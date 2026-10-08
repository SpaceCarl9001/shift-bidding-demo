// Returns only the public Supabase settings needed by the browser, and the admin list
// (the admins table plus ADMIN_EMAILS) so the page knows whether to show the admin screens.
const { adminEmails } = require("../lib/admins");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET" });

  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Supabase settings are not configured in Vercel." });
  }

  return res.status(200).json({
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    adminEmails: await adminEmails(),
  });
};
