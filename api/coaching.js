// Admin only: coach groups (supabase/coaching.sql).
// Required env vars: ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)
//
// Body: { action, lob, agentIds? }
//   groups:  the LOB's coach groups in Assembled (the teams under "<LOB> Coaches"), with headcounts.
//   plan:    shares the LOB's agents who have an assigned shift out between its coaches: about the
//            same number each, matched to the coach's schedule (lib/coaching.js). Saves nothing.
//            With shuffle: true and current ({ agentId: coachId }), shares them out at random instead,
//            still evenly, moving as many agents as possible to a different coach. With keep
//            ({ agentId: coachId }), those agents stay with their coach and only the others are placed.
//   suggest: { count } coach schedules picked from the LOB's shift shells, so that after the even
//            split agents share the most hours with their own coach (lib/coaching.js). Saves nothing.
//   teams:   what moving each agent into their saved coach's team in Assembled would change.
//   apply:   makes those team changes in Assembled (needs "push"). agentIds limits it to some agents.
// Assembled replaces a person's whole team list when it is updated, so each person keeps every
// team they are on except the LOB's coach groups, and gets their coach's group.

const { isAdminEmail, hasPermission } = require("../lib/admins");
const { assembledClient } = require("../lib/assembled");
const { distribute, suggestSchedules, scoreSchedules, mondayFrom, nextTeams, sameTeams } = require("../lib/coaching");

const MAX_UPDATES = 150;   // per request, to stay inside the 60 second limit at 4 calls a second

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const { ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!ASSEMBLED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not signed in" });
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!userResp.ok) return res.status(401).json({ error: "Invalid session" });
  const me = await userResp.json();
  if (!(await isAdminEmail(me.email))) return res.status(403).json({ error: "Admins only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action, lob, agentIds, shuffle, current, count, keep } = body || {};
  if (!["groups", "plan", "suggest", "teams", "apply"].includes(action) || !lob) {
    return res.status(400).json({ error: "Need an action (groups, plan, suggest, teams or apply) and a LOB." });
  }
  if (action === "apply" && !(await hasPermission(me.email, "push"))) {
    return res.status(403).json({ error: "You do not have permission to change Assembled. You can still preview the changes." });
  }

  const sb = async (method, path, payload) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...sbHeaders, Prefer: "return=representation" }, body: payload ? JSON.stringify(payload) : undefined });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const { call } = assembledClient(ASSEMBLED_API_KEY);
  const asm = async (path, options) => {
    const r = await call(`https://api.assembledhq.com${path}`, options);
    if (!r.ok) throw new Error(`Assembled ${path.split("?")[0]} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const asList = (c, key) => !c || !c[key] ? [] : Array.isArray(c[key]) ? c[key] : Object.values(c[key]);
  async function assembledPeople() {
    let people = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      const raw = await asm(`/v0/people?limit=500&offset=${offset}`);
      const batch = asList(raw, "people");
      people = people.concat(batch);
      if (!batch.length || people.length >= (raw.total || 0)) break;
    }
    return people;
  }
  // The LOB's coach group teams: everything under the "<LOB> Coaches" team, and that team itself.
  function coachGroups(teams) {
    const parent = teams.find(t => t.name === `${lob} Coaches`);
    if (!parent) return { parent: null, groups: [], ids: new Set() };
    const ids = new Set([parent.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of teams) if (t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) { ids.add(t.id); grew = true; }
    }
    return { parent, groups: teams.filter(t => t.parent_id === parent.id), ids };
  }

  try {
    if (action === "groups") {
      const teams = asList(await asm("/v0/teams"), "teams"), { parent, groups } = coachGroups(teams);
      if (!parent) return res.status(200).json({ groups: [], note: `There is no "${lob} Coaches" team in Assembled.` });
      const people = (await assembledPeople()).filter(p => !p.deleted);
      return res.status(200).json({ groups: groups.map(g => ({ id: g.id, name: g.name, members: people.filter(p => (p.teams || []).includes(g.id)).length }))
        .sort((a, b) => a.name.localeCompare(b.name)) });
    }

    const agents = await sb("GET", `agents?select=id,name,email,assembled_id&lob=eq.${encodeURIComponent(lob)}&excluded=eq.false&limit=5000`);
    const ids = agents.map(a => a.id);

    const etToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (action === "suggest") {
      const k = Math.round(Number(count));
      if (!(k >= 1 && k <= 50)) return res.status(400).json({ error: "The number of coaches must be between 1 and 50." });
      const [asg, shells, coaches] = await Promise.all([
        ids.length ? sb("GET", `assignments?select=agent_id,shift_shells(days,start_local,end_local,timezone)&agent_id=in.(${ids.join(",")})`) : [],
        sb("GET", `shift_shells?select=days,start_local,end_local,timezone&lob=eq.${encodeURIComponent(lob)}&limit=5000`),
        sb("GET", `coaches?select=*&lob=eq.${encodeURIComponent(lob)}&order=name`),
      ]);
      const withShift = asg.filter(a => a.shift_shells).map(a => ({ id: a.agent_id, shift: a.shift_shells }));
      if (!withShift.length) return res.status(200).json({ schedules: [], note: `No ${lob} agents have an assigned shift yet, so there is nothing to base coach schedules on.` });
      const weekStart = mondayFrom(etToday);
      const result = suggestSchedules({ agents: withShift, candidates: shells, count: k, weekStart });
      return res.status(200).json({ weekStart, agents: withShift.length, ...result,
        currentFit: coaches.length ? scoreSchedules({ agents: withShift, coaches, weekStart }) : null });
    }

    if (action === "plan") {
      const coaches = await sb("GET", `coaches?select=*&lob=eq.${encodeURIComponent(lob)}&order=name`);
      if (!coaches.length) return res.status(200).json({ rows: [], overlap: {}, note: `Add the ${lob} coaches and their schedules first.` });
      const asg = ids.length ? await sb("GET", `assignments?select=agent_id,shift_shells(days,start_local,end_local,timezone)&agent_id=in.(${ids.join(",")})`) : [];
      const withShift = asg.filter(a => a.shift_shells).map(a => ({ id: a.agent_id, shift: a.shift_shells }));
      const has = new Set(withShift.map(a => a.id));
      const weekStart = mondayFrom(etToday);
      const { rows, overlap, placed } = distribute({ agents: withShift, coaches, weekStart,
        shuffle: shuffle ? { current: current && typeof current === "object" ? current : {} } : null,
        keep: keep && typeof keep === "object" && !shuffle ? keep : null });
      return res.status(200).json({ weekStart, rows, overlap, placed: placed || null, noShift: agents.filter(a => !has.has(a.id)).map(a => a.name).sort() });
    }

    // teams / apply: compare each saved coach group with the person's teams in Assembled.
    const saved = ids.length ? await sb("GET", `coach_assignments?select=agent_id,coach_id,coaches(name,assembled_team_id)&agent_id=in.(${ids.join(",")})`) : [];
    const [teams, people] = [asList(await asm("/v0/teams"), "teams"), await assembledPeople()];
    const teamName = Object.fromEntries(teams.map(t => [t.id, t.name]));
    const { parent, ids: groupIds } = coachGroups(teams);
    if (!parent) return res.status(200).json({ changes: [], skipped: [], note: `There is no "${lob} Coaches" team in Assembled.` });
    const personById = Object.fromEntries(people.map(p => [String(p.id), p]));
    const agentById = Object.fromEntries(agents.map(a => [a.id, a]));
    const only = Array.isArray(agentIds) && agentIds.length ? new Set(agentIds.map(Number)) : null;
    const changes = [], skipped = [], unchanged = [];
    for (const s of saved) {
      const a = agentById[s.agent_id];
      if (!a || (only && !only.has(a.id))) continue;
      const target = s.coaches?.assembled_team_id, p = personById[String(a.assembled_id)];
      if (!target || !teamName[target] || !groupIds.has(target)) { skipped.push({ name: a.name, reason: `${s.coaches?.name || "Their coach"} has no ${lob} coach group set` }); continue; }
      if (!p || p.deleted) { skipped.push({ name: a.name, reason: "not found in Assembled, or inactive there" }); continue; }
      const next = nextTeams(p.teams, groupIds, target);
      if (sameTeams(p.teams, next)) { unchanged.push(a.name); continue; }
      changes.push({ agent_id: a.id, name: a.name, person_id: p.id, teams: next,
        from: (p.teams || []).filter(t => groupIds.has(t)).map(t => teamName[t] || t), to: teamName[target] });
    }
    changes.sort((x, y) => x.name.localeCompare(y.name));
    if (action === "teams") {
      return res.status(200).json({ changes: changes.map(({ teams: _t, person_id: _p, ...c }) => c), unchanged: unchanged.length, skipped });
    }

    // apply
    const batch = changes.slice(0, MAX_UPDATES), done = [], failed = [];
    for (const c of batch) {
      try {
        const out = await asm(`/v0/people/${encodeURIComponent(c.person_id)}`, { method: "PATCH", body: JSON.stringify({ teams: c.teams }) });
        // Assembled answers with the updated person; make sure the teams are what was sent.
        const got = out && (out.teams || (out.person && out.person.teams));
        if (got && !sameTeams(got, c.teams)) throw new Error("Assembled saved different teams than were sent");
        done.push(c);
      } catch (err) {
        failed.push({ name: c.name, error: String(err.message || err).slice(0, 200) });
      }
    }
    if (done.length) await sb("PATCH", `coach_assignments?agent_id=in.(${done.map(c => c.agent_id).join(",")})`, { synced_at: new Date().toISOString() });
    return res.status(200).json({ updated: done.map(c => ({ name: c.name, to: c.to })), failed, remaining: changes.length - batch.length, unchanged: unchanged.length, skipped });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
};
