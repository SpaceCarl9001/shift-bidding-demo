// Syncs agents + teams from Assembled into the Supabase "agents" table.
// Secrets come from Vercel Environment Variables. Nothing secret lives in this file.
// Required env vars: ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)

// LOBs are these top-level teams in Assembled. Sub-teams (e.g. "Returns Mitigation" under
// Support) roll up to them, and "<LOB> Coaches" groups count toward that LOB.
const LOB_TEAMS = ["Sales", "Support", "Retention", "Billing"];

// Returns teamIds => LOB name, "Multiple LOBs" or "Unassigned".
// Regular teams decide the LOB; coach teams only break ties or fill in when there is none.
function buildLobResolver(teams) {
  const byId = {};
  for (const t of teams) byId[t.id] = t;

  function lobOfTeam(id) {
    let t = byId[id];
    for (let i = 0; t && t.parent_id && byId[t.parent_id] && i < 10; i++) t = byId[t.parent_id];
    const rootName = String((t && t.name) || "");
    if (LOB_TEAMS.includes(rootName)) return { lob: rootName, coach: false };
    const coachOf = rootName.replace(/ Coaches$/, "");
    if (coachOf !== rootName && LOB_TEAMS.includes(coachOf)) return { lob: coachOf, coach: true };
    return null;
  }

  return function lobFor(teamIds) {
    const regular = {}, all = {};
    for (const id of teamIds || []) {
      const hit = lobOfTeam(id);
      if (!hit) continue;
      all[hit.lob] = (all[hit.lob] || 0) + 1;
      if (!hit.coach) regular[hit.lob] = (regular[hit.lob] || 0) + 1;
    }
    let candidates = Object.keys(regular);
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) candidates = Object.keys(all);
    if (!candidates.length) return "Unassigned";
    const ranked = candidates.sort((a, b) => all[b] - all[a]);
    if (ranked.length > 1 && all[ranked[0]] === all[ranked[1]]) return "Multiple LOBs";
    return ranked[0];
  };
}

const { isAdminEmail, hasPermission } = require("../lib/admins");
module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!ASSEMBLED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }

  // 1. Verify the caller is a signed in admin
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
  if (!(await hasPermission(user.email, "roster"))) {
    return res.status(403).json({ error: "You do not have permission to sync the roster." });
  }

  // 2. Pull teams and people from Assembled
  const basic = "Basic " + Buffer.from(ASSEMBLED_API_KEY + ":").toString("base64");
  const aHeaders = { Authorization: basic, "Content-Type": "application/json" };

  async function assembledGet(path) {
    const r = await fetch("https://api.assembledhq.com/v0" + path, { headers: aHeaders });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Assembled ${path} failed (${r.status}): ${body.slice(0, 200)}`);
    }
    return r.json();
  }

  function asList(container, key) {
    const inner = container && container[key];
    if (!inner) return [];
    return Array.isArray(inner) ? inner : Object.values(inner);
  }

  let teams = [], people = [];
  try {
    const teamsRaw = await assembledGet("/teams");
    teams = asList(teamsRaw, "teams");

    // People is paginated, max 500 per page
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const raw = await assembledGet(`/people?limit=500&offset=${offset}`);
      const batch = asList(raw, "people");
      people = people.concat(batch);
      const total = raw.total || 0;
      offset += 500;
      if (batch.length === 0 || people.length >= total) break;
    }
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }

  const lobFor = buildLobResolver(teams);

  // 3. Shape agent rows
  const rows = [];
  for (const p of people) {
    if (p.deleted) continue;
    const email = (p.email || "").trim().toLowerCase();
    if (!email) continue;
    const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.name || email;
    const lob = lobFor(p.teams);
    rows.push({
      assembled_id: String(p.id),
      assembled_agent_id: p.agent_id ? String(p.agent_id) : null,
      name,
      email,
      lob,
    });
  }

  if (!rows.length) {
    return res.status(200).json({ synced: 0, note: "No active people with emails found in Assembled." });
  }

  // 4. Upsert into Supabase keyed by email so existing ranks are preserved. People an admin put in
  //    a coach bid group (lob_locked) keep that group: their LOB is left out of the update.
  let locked = new Set();
  const lockResp = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=email&lob_locked=eq.true`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (lockResp.ok) locked = new Set((await lockResp.json()).map(a => String(a.email).toLowerCase()));
  const upsert = async batch => {
    if (!batch.length) return null;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?on_conflict=email`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    return r.ok ? null : `Supabase upsert failed: ${(await r.text()).slice(0, 300)}`;
  };
  const upErr = (await upsert(rows.filter(r => !locked.has(r.email))))
    || (await upsert(rows.filter(r => locked.has(r.email)).map(({ lob: _lob, ...r }) => r)));
  if (upErr) return res.status(502).json({ error: upErr });

  // 5. Report how many are removed from bidding. The upsert never touches "excluded",
  //    so people an admin removed stay removed.
  const removedResp = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=id&excluded=eq.true`, {
    method: "HEAD",
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Prefer: "count=exact" },
  });
  const removed = Number((removedResp.headers.get("content-range") || "").split("/")[1]) || 0;

  const lobs = [...new Set(rows.map(r => r.lob))].sort();
  const missingAgentId = rows.filter(r => !r.assembled_agent_id).length;
  return res.status(200).json({ synced: rows.length, lobs, missingAgentId, removed });
};

module.exports.buildLobResolver = buildLobResolver;
