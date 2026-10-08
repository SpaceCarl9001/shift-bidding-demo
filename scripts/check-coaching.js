// Checks supabase/coaching.sql against the live Supabase project: only admins with Roster & ranks
// can change coaches and coach groups, every admin can read them, agents see nothing, and
// replace_coach_assignments only accepts agents and coaches from the LOB. Uses a throwaway LOB and
// logins that are deleted afterwards. Never touches Assembled. Run: npm run check:coaching
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: k } = process.env;

const LOB = "__coach_test__", OTHER = "__coach_test__x", stamp = Date.now(), password = `Coach-${stamp}-pw`;
const svcH = { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", Prefer: "return=representation" };
const svc = async (method, p, body) => {
  const r = await fetch(`${url}/rest/v1/${p}`, { method, headers: svcH, body: body && JSON.stringify(body) });
  const t = await r.text(); return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : null };
};
const as = token => async (method, p, body) => {
  const r = await fetch(`${url}/rest/v1/${p}`, { method, headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: body && JSON.stringify(body) });
  const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { ok: r.ok, status: r.status, data };
};
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  -> " + JSON.stringify(detail).slice(0, 220)}`); };

(async () => {
  if ((await svc("GET", "coaches?select=id&limit=1")).status !== 200) {
    console.error("public.coaches does not exist. Run supabase/coaching.sql in the Supabase SQL Editor first."); process.exit(1);
  }
  const emails = { editor: `coach-editor-${stamp}@example.com`, viewer: `coach-viewer-${stamp}@example.com`, agent: `coach-agent-${stamp}@example.com`, coach: `coach-coach-${stamp}@example.com` };
  const users = {};
  try {
    // The coach's own person record, in the coach bid group ("<LOB> Coaches").
    const [coachPerson] = (await svc("POST", "agents", { email: emails.coach, name: "Coach Lena", lob: `${LOB} Coaches`, assembled_id: `coach-k-${stamp}`, excluded: false })).data;
    const ag = (await svc("POST", "agents", [
      { email: emails.agent, name: "Coach A1", lob: LOB, assembled_id: `coach-a1-${stamp}`, excluded: false },
      { email: `coach-a2-${stamp}@example.com`, name: "Coach A2", lob: LOB, assembled_id: `coach-a2-${stamp}`, excluded: false },
      { email: `coach-x-${stamp}@example.com`, name: "Coach X", lob: OTHER, assembled_id: `coach-x-${stamp}`, excluded: false },
    ])).data;
    const [a1, a2, ax] = ag;
    for (const key of Object.keys(emails)) {
      const u = await (await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: svcH, body: JSON.stringify({ email: emails[key], password, email_confirm: true }) })).json();
      const t = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: emails[key], password }) })).json();
      users[key] = { id: u.id, rest: as(t.access_token) };
    }
    await svc("POST", "admins", [{ email: emails.editor, permissions: ["roster"] }, { email: emails.viewer, permissions: ["shells"] }]);
    const E = users.editor.rest, V = users.viewer.rest, A = users.agent.rest;
    const coach = (lob, name) => ({ lob, name, days: "1,2,3,4,5", start_local: "08:00", end_local: "17:00", timezone: "America/New_York" });

    let r = await V("POST", "coaches", coach(LOB, "Sneaky")); check("without Roster & ranks: cannot add a coach", !r.ok, r);
    r = await A("POST", "coaches", coach(LOB, "Sneaky")); check("agents cannot add a coach", !r.ok, r);
    r = await E("POST", "coaches", [coach(LOB, "Sam"), coach(LOB, "Lena"), coach(OTHER, "Other")]);
    check("with Roster & ranks: can add coaches", r.ok && r.data.length === 3, r);
    const [cj, ck, co] = r.data || [];
    r = await V("GET", `coaches?select=id&lob=eq.${LOB}`); check("every admin can read coaches", r.ok && r.data.length === 2, r);
    r = await A("GET", "coaches?select=id"); check("agents cannot read coaches", r.ok && r.data.length === 0, r);
    r = await V("PATCH", `coaches?id=eq.${cj.id}`, { name: "Changed" }); check("without Roster & ranks: cannot change a coach", r.ok && r.data.length === 0, r);

    const save = (who, rows) => who("POST", "rpc/replace_coach_assignments", { p_lob: LOB, p_rows: rows });
    r = await save(V, [{ agent_id: a1.id, coach_id: cj.id }]); check("without Roster & ranks: cannot save coach groups", !r.ok && /permission/.test(r.data.message), r.data);
    r = await save(E, [{ agent_id: ax.id, coach_id: cj.id }]); check("an agent from another LOB is refused", !r.ok && /must be in/.test(r.data.message), r.data);
    r = await save(E, [{ agent_id: a1.id, coach_id: co.id }]); check("a coach from another LOB is refused", !r.ok && /must be in/.test(r.data.message), r.data);
    r = await save(E, [{ agent_id: a1.id, coach_id: cj.id, overlap_minutes: 2700 }, { agent_id: a2.id, coach_id: ck.id, overlap_minutes: 600 }]);
    const rows = (await svc("GET", `coach_assignments?select=agent_id,coach_id,overlap_minutes,saved_by&agent_id=in.(${a1.id},${a2.id})&order=agent_id`)).data || [];
    check("coach groups are saved, with who saved them", r.ok && rows.length === 2 && rows[0].coach_id === cj.id && rows[0].overlap_minutes === 2700 && rows[0].saved_by === emails.editor, { r: r.data, rows });
    r = await save(E, [{ agent_id: a2.id, coach_id: cj.id }]);
    const after = (await svc("GET", `coach_assignments?select=agent_id,coach_id&agent_id=in.(${a1.id},${a2.id})`)).data || [];
    check("saving again replaces the LOB's groups (agents left out lose their coach)", r.ok && after.length === 1 && after[0].agent_id === a2.id && after[0].coach_id === cj.id, after);
    r = await A("GET", "coach_assignments?select=agent_id"); check("agents cannot read coach groups", r.ok && r.data.length === 0, r);
    r = await V("GET", `coach_assignments?select=agent_id&agent_id=eq.${a2.id}`); check("every admin can read coach groups", r.ok && r.data.length === 1, r);
    r = await V("POST", "coach_lob_settings", { lob: LOB, coach_count: 3 }); check("without Roster & ranks: cannot set the number of coaches", !r.ok, r);
    r = await E("POST", "coach_lob_settings", { lob: LOB, coach_count: 3 }); check("with Roster & ranks: can set the number of coaches", r.ok && r.data[0]?.coach_count === 3, r);
    r = await E("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coach_count: 0 }); check("the number of coaches must be 1 to 50", !r.ok, r);
    r = await V("GET", `coach_lob_settings?select=coach_count&lob=eq.${LOB}`); check("every admin can read the number of coaches", r.ok && r.data[0]?.coach_count === 3, r);
    r = await A("GET", "coach_lob_settings?select=lob"); check("agents cannot read it", r.ok && r.data.length === 0, r);

    // ---- agents see their own coach's name only once results and coach groups are both published
    await save(E, [{ agent_id: a1.id, coach_id: ck.id }, { agent_id: a2.id, coach_id: cj.id }]);
    const myCoach = async () => (await A("POST", "rpc/my_coach", {})).data;
    check("agent: no coach shown before anything is published", (await myCoach()) === null, await myCoach());
    r = await A("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coaches_published_at: new Date().toISOString() }); check("agents cannot publish coach groups", r.ok && r.data.length === 0, r);
    r = await V("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coaches_published_at: new Date().toISOString() }); check("without Roster & ranks: cannot publish coach groups", r.ok && r.data.length === 0, r);
    r = await E("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coaches_published_at: new Date().toISOString(), coaches_published_by: emails.editor });
    check("with Roster & ranks: can publish coach groups", r.ok && r.data.length === 1, r);
    check("agent: still no coach while the results are not published", (await myCoach()) === null, await myCoach());
    await svc("POST", "published_results", { lob: LOB });
    let mc = await myCoach(); check("agent: sees their own coach once both are published", mc && mc.name === "Lena" && Object.keys(mc).join() === "name", mc);
    r = await E("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coaches_published_at: null });
    check("agent: unpublishing coach groups hides it again", r.ok && (await myCoach()) === null, await myCoach());
    await E("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coaches_published_at: new Date().toISOString() });
    await svc("DELETE", `published_results?lob=eq.${LOB}`);
    check("agent: unpublishing the results hides it too", (await myCoach()) === null, await myCoach());

    // ---- a coach sees their own agents once the coach groups are published
    const C = users.coach.rest, myAgents = async () => (await C("POST", "rpc/my_coach_agents", {})).data;
    check("coach not linked to a coach record yet: nothing", (await myAgents()) === null, await myAgents());
    await svc("PATCH", `coaches?id=eq.${ck.id}`, { agent_id: coachPerson.id });
    let ma = await myAgents();
    check("coach groups published: the coach sees their own agents only (A1, not A2)", ma && ma.published === true && JSON.stringify(ma.agents.map(x => x.name)) === '["Coach A1"]', ma);
    check("each agent shows name and shift only", ma && ma.agents.every(x => Object.keys(x).sort().join() === "name,shift"), ma);
    await E("PATCH", `coach_lob_settings?lob=eq.${LOB}`, { coaches_published_at: null });
    ma = await myAgents(); check("coach groups unpublished: the list is hidden", ma && ma.published === false && ma.agents.length === 0, ma);
    r = await A("POST", "rpc/my_coach_agents", {}); check("a regular agent gets nothing", r.ok && r.data === null, r.data);
    r = await C("GET", "coach_assignments?select=agent_id"); check("the coach still cannot read the coach tables directly", r.ok && r.data.length === 0, r);

    r = await E("DELETE", `coaches?id=eq.${cj.id}`);
    const gone = (await svc("GET", `coach_assignments?select=agent_id&agent_id=eq.${a2.id}`)).data || [];
    check("removing a coach removes their group rows", r.ok && gone.length === 0, { r, gone });
  } catch (err) {
    fails++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    const ag = (await svc("GET", `agents?select=id&lob=in.(${LOB},${OTHER})`)).data || [];
    if (ag.length) await svc("DELETE", `coach_assignments?agent_id=in.(${ag.map(a => a.id).join(",")})`);
    await svc("DELETE", `coaches?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `coach_lob_settings?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `published_results?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `agents?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `agents?lob=eq.${encodeURIComponent(LOB + " Coaches")}`);
    await svc("DELETE", `admins?email=in.(${encodeURIComponent(emails.editor)},${encodeURIComponent(emails.viewer)})`);
    for (const u of Object.values(users)) if (u.id) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: svcH });
    const left = (await svc("GET", `coaches?select=id&lob=in.(${LOB},${OTHER})`)).data || [];
    console.log(`Cleanup done (${left.length} test coaches left).`);
    console.log(fails ? `\n${fails} failed` : "\nAll coaching checks passed.");
    process.exit(fails ? 1 : 0);
  }
})();
