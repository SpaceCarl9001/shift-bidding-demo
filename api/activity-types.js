// Lists Assembled activity types so the admin can pick which one to push shifts as.
// Required env vars: ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)

const { isAdminEmail } = require("../lib/admins");
module.exports = async function handler(req, res) {
  const { ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!ASSEMBLED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not signed in" });

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResp.ok) return res.status(401).json({ error: "Invalid session" });
  const user = await userResp.json();
  if (!(await isAdminEmail(user.email))) {
    return res.status(403).json({ error: "Admins only" });
  }

  const basic = "Basic " + Buffer.from(ASSEMBLED_API_KEY + ":").toString("base64");
  const r = await fetch("https://api.assembledhq.com/v0/activity_types", {
    headers: { Authorization: basic, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    return res.status(502).json({ error: `Assembled activity_types failed (${r.status}): ${(await r.text()).slice(0, 200)}` });
  }
  const raw = await r.json();
  const inner = raw.activity_types || {};
  const list = (Array.isArray(inner) ? inner : Object.values(inner))
    .map(t => ({ id: t.id, name: t.name, productive: !!t.productive, timeoff: !!t.timeoff }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return res.status(200).json({ activity_types: list });
};
