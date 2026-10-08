// First-time account setup without confirmation emails.
// Anyone whose email is on the roster (an agent who is not removed, or an admin) can create
// their login and pick a password. The account is created already confirmed, so no email is sent.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)
//
// Body: { email, action: "check" }            -> { status: "has_account" | "can_setup" | "not_found" | "removed",
//                                                  reason: "new" | "reset" (with can_setup) }
//       { email, password, action: "setup" }  -> { ok: true }  (then sign in with the password)

const MIN_PASSWORD = 8;

const { isAdminEmail } = require("../lib/admins");
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String((body && body.email) || "").trim().toLowerCase();
  const action = body && body.action;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });

  // ---- is this email allowed to have an account? -------------------
  const agentResp = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=excluded&email=eq.${encodeURIComponent(email)}`, { headers });
  if (!agentResp.ok) return res.status(502).json({ error: "Could not check the roster. Try again in a minute." });
  const agent = (await agentResp.json())[0];
  const isAdmin = await isAdminEmail(email);
  if (!agent && !isAdmin) return res.status(200).json({ status: "not_found" });
  if (agent && agent.excluded && !isAdmin) return res.status(200).json({ status: "removed" });

  // ---- does a login already exist? ----------------------------------
  async function findUser() {
    for (let page = 1; page <= 20; page++) {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
      if (!r.ok) throw new Error(`auth users ${r.status}`);
      const users = (await r.json()).users || [];
      const found = users.find(u => String(u.email || "").toLowerCase() === email);
      if (found || users.length < 1000) return found || null;
    }
    return null;
  }
  let user;
  try { user = await findUser(); }
  catch { return res.status(502).json({ error: "Could not check your account. Try again in a minute." }); }

  // A login that was never confirmed (from before this flow), or that an admin reset
  // (/api/accounts), can be set up again with a new password.
  const resetByAdmin = !!(user && user.app_metadata && user.app_metadata.reset_allowed);
  const hasAccount = !!(user && user.email_confirmed_at) && !resetByAdmin;
  if (action === "check") {
    if (hasAccount) return res.status(200).json({ status: "has_account" });
    return res.status(200).json({ status: "can_setup", reason: resetByAdmin ? "reset" : "new" });
  }
  if (action !== "setup") return res.status(400).json({ error: "Unknown action." });

  // ---- create the login ---------------------------------------------
  if (hasAccount) {
    return res.status(409).json({ error: "You already have an account. Sign in with your password, or ask your admin to reset it." });
  }
  const password = String((body && body.password) || "");
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Your password must be at least ${MIN_PASSWORD} characters.` });
  }

  const r = user
    ? await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: "PUT", headers,
        body: JSON.stringify({ password, email_confirm: true, app_metadata: { ...(user.app_metadata || {}), reset_allowed: false } }),
      })
    : await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST", headers, body: JSON.stringify({ email, password, email_confirm: true }),
      });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    const msg = detail.msg || detail.message || detail.error_description || "";
    if (/password/i.test(msg)) return res.status(400).json({ error: msg });
    return res.status(502).json({ error: "Could not create your account. Try again in a minute." });
  }
  return res.status(200).json({ ok: true });
};
