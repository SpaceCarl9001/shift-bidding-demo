// Admin only: login status for the roster, and resetting logins when someone forgets their password.
// A reset replaces the password with a random one nobody knows and marks the login so that
// /api/setup-account lets the person create a new password the next time they enter their email.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)
//
// GET                   -> { accounts: { "<email>": "active" | "reset" } }   (emails with no login are absent)
// POST { emails: [...] } -> { reset: <count>, noLogin: [emails that have no login to reset] }

const { isAdminEmail, hasPermission } = require("../lib/admins");
const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Use GET or POST" });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };

  // ---- auth ----------------------------------------------------------
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not signed in" });
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResp.ok) return res.status(401).json({ error: "Invalid session" });
  const me = await userResp.json();
  if (!(await isAdminEmail(me.email))) return res.status(403).json({ error: "Admins only" });

  // ---- all logins, keyed by email ------------------------------------
  const byEmail = {};
  try {
    for (let page = 1; page <= 20; page++) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
      if (!r.ok) throw new Error(`auth users ${r.status}`);
      const users = (await r.json()).users || [];
      for (const u of users) if (u.email) byEmail[u.email.toLowerCase()] = u;
      if (users.length < 1000) break;
    }
  } catch {
    return res.status(502).json({ error: "Could not load logins. Try again in a minute." });
  }
  const statusOf = u => (u.app_metadata && u.app_metadata.reset_allowed) || !u.email_confirmed_at ? "reset" : "active";

  if (req.method === "GET") {
    const accounts = {};
    for (const [email, u] of Object.entries(byEmail)) accounts[email] = statusOf(u);
    return res.status(200).json({ accounts });
  }

  // ---- reset ---------------------------------------------------------
  if (!(await hasPermission(me.email, "roster"))) return res.status(403).json({ error: "You do not have permission to reset logins." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const emails = [...new Set(((body && body.emails) || []).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return res.status(400).json({ error: "No emails given." });
  if (emails.includes((me.email || "").toLowerCase())) {
    return res.status(400).json({ error: "You cannot reset your own login here. Use Change password instead." });
  }

  let reset = 0;
  const noLogin = [], failed = [];
  for (const email of emails) {
    const u = byEmail[email];
    if (!u) { noLogin.push(email); continue; }
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({
        password: crypto.randomBytes(24).toString("base64url"),
        app_metadata: { ...(u.app_metadata || {}), reset_allowed: true },
      }),
    });
    if (r.ok) reset++; else failed.push(email);
  }
  if (failed.length) return res.status(502).json({ error: `Could not reset: ${failed.join(", ")}`, reset, noLogin });
  return res.status(200).json({ reset, noLogin });
};
