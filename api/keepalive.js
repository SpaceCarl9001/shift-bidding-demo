// Called once a day by a Vercel cron job (see vercel.json). Supabase's free plan pauses a
// project after a week with no activity, which would take the app down between bid cycles;
// a small daily database read keeps it active.
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
module.exports = async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: "Server is missing environment variables." });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=id&limit=1`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) return res.status(502).json({ ok: false, error: `Database check failed (${r.status})` });
  return res.status(200).json({ ok: true, checkedAt: new Date().toISOString() });
};
