// Checks supabase/manual-assignments.sql against the live Supabase project: only manual assigners
// can add, change or remove manual assignments; other admins can read them; agents see nothing.
// Uses a throwaway LOB and logins that are deleted afterwards. Run: npm run check:manual
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: k } = process.env;

const LOB = "__manual_test__", stamp = Date.now(), password = `Manual-${stamp}-pw`;
const svcH = { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", Prefer: "return=representation" };
const svc = async (method, p, body) => {
  const r = await fetch(`${url}/rest/v1/${p}`, { method, headers: svcH, body: body && JSON.stringify(body) });
  const t = await r.text(); return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : null };
};
const as = token => async (method, p, body, prefer = "return=representation") => {
  const r = await fetch(`${url}/rest/v1/${p}`, { method, headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: prefer }, body: body && JSON.stringify(body) });
  const t = await r.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { ok: r.ok, status: r.status, data };
};
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  -> " + JSON.stringify(detail).slice(0, 220)}`); };

(async () => {
  if ((await svc("GET", "manual_assignments?select=agent_id&limit=1")).status === 404) {
    console.error("public.manual_assignments does not exist. Run supabase/manual-assignments.sql in the Supabase SQL Editor first."); process.exit(1);
  }
  const emails = { boss: `manual-boss-${stamp}@example.com`, admin: `manual-admin-${stamp}@example.com`, agent: `manual-agent-${stamp}@example.com` };
  const users = {};
  try {
    const shells = (await svc("POST", "shift_shells", [
      { lob: LOB, seats: 1, days: "1,2,3,4,5", start_local: "08:00", end_local: "17:00", timezone: "America/New_York", schedule: "manual s1" },
      { lob: LOB, seats: 2, days: "1,2,3,4,5", start_local: "12:00", end_local: "21:00", timezone: "America/New_York", schedule: "manual s2" },
      { lob: `${LOB}x`, seats: 1, days: "1,2,3,4,5", start_local: "12:00", end_local: "21:00", timezone: "America/New_York", schedule: "manual other" },
    ])).data;
    const [s1, s2, other] = shells;
    const agents = (await svc("POST", "agents", ["one", "two", "three"].map(n => ({
      email: n === "one" ? emails.agent : `manual-${n}-${stamp}@example.com`, name: `Manual ${n}`, lob: LOB, assembled_id: `manual-${n}-${stamp}`, excluded: false,
    })))).data;
    const [a1, a2, a3] = agents;
    for (const key of Object.keys(emails)) {
      const u = await (await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: svcH, body: JSON.stringify({ email: emails[key], password, email_confirm: true }) })).json();
      const t = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: emails[key], password }) })).json();
      users[key] = { id: u.id, rest: as(t.access_token) };
    }
    // The boss has the "manual" permission; the other admin has the standard ones, without it.
    await svc("POST", "admins", [{ email: emails.boss, permissions: ["manual"] }, { email: emails.admin, permissions: ["roster", "shells", "windows", "assign", "swaps", "push"] }]);
    const boss = users.boss.rest, admin = users.admin.rest, agent = users.agent.rest;

    let r = await boss("POST", "rpc/can_assign_manually", {}); check("the manual assigner is allowed", r.ok && r.data === true, r);
    r = await admin("POST", "rpc/can_assign_manually", {}); check("another admin is not", r.ok && r.data === false, r);
    r = await agent("POST", "rpc/can_assign_manually", {}); check("an agent is not", r.ok && r.data === false, r);

    r = await boss("POST", "manual_assignments", { agent_id: a1.id, shift_id: s1.id });
    check("manual assigner can assign a shift", r.ok && r.data[0]?.shift_id === s1.id && r.data[0]?.assigned_by === emails.boss, r);
    r = await admin("POST", "manual_assignments", { agent_id: a2.id, shift_id: s2.id }); check("another admin cannot assign", !r.ok, r);
    r = await admin("PATCH", `manual_assignments?agent_id=eq.${a1.id}`, { shift_id: s2.id }); check("another admin cannot change one", r.ok && r.data.length === 0, r);
    r = await admin("DELETE", `manual_assignments?agent_id=eq.${a1.id}`); check("another admin cannot remove one", r.ok && r.data.length === 0, r);
    r = await admin("GET", `manual_assignments?select=agent_id&agent_id=eq.${a1.id}`); check("another admin can see it", r.ok && r.data.length === 1, r);
    r = await agent("GET", "manual_assignments?select=agent_id"); check("agents cannot see manual assignments, even their own", r.ok && r.data.length === 0, r);
    r = await agent("POST", "manual_assignments", { agent_id: a1.id, shift_id: s2.id }); check("agents cannot assign", !r.ok, r);
    r = await agent("PATCH", `admins?email=eq.${encodeURIComponent(emails.agent)}`, { permissions: ["manual"] }); check("an agent cannot make themselves a manual assigner", r.ok && r.data.length === 0, r);
    r = await admin("PATCH", `admins?email=eq.${encodeURIComponent(emails.admin)}`, { permissions: ["manual"] }); check("an admin without Manage admins cannot give themselves the permission", r.ok && r.data.length === 0, r);

    r = await boss("POST", "manual_assignments", { agent_id: a2.id, shift_id: other.id }); check("the shell must be in the agent's LOB", !r.ok && /but this agent is in/.test(r.data.message), r.data);
    r = await boss("POST", "manual_assignments", { agent_id: a2.id, shift_id: s1.id }); check("cannot go over the shell's seats (1 seat, already used)", !r.ok && /already manually assigned/.test(r.data.message), r.data);
    r = await boss("POST", "manual_assignments", { agent_id: a2.id, shift_id: s2.id });
    r = await boss("POST", "manual_assignments", { agent_id: a3.id, shift_id: s2.id }); check("a 2-seat shell takes two", r.ok, r.data);
    r = await boss("POST", "manual_assignments?on_conflict=agent_id", { agent_id: a1.id, shift_id: s2.id }, "resolution=merge-duplicates,return=representation");
    check("changing to a full shell is refused", !r.ok && /already manually assigned/.test(r.data.message), r.data);
    r = await boss("DELETE", `manual_assignments?agent_id=eq.${a3.id}`); check("manual assigner can remove one", r.ok && r.data.length === 1, r);
    r = await boss("POST", "manual_assignments?on_conflict=agent_id", { agent_id: a1.id, shift_id: s2.id }, "resolution=merge-duplicates,return=representation");
    check("manual assigner can change one (upsert, as the app does)", r.ok && r.data[0]?.shift_id === s2.id, r.data);
    r = await svc("DELETE", `shift_shells?id=eq.${s2.id}`); check("a shell with a manual assignment cannot be deleted, even with full rights", !r.ok, r);

    // ---- after auto assign: giving an agent with no shift an open seat (assign_open_seat)
    if ((await boss("POST", "rpc/assign_open_seat", { p_agent_id: -1, p_shift_id: -1 })).status === 404) throw new Error("assign_open_seat is missing: run the updated supabase/manual-assignments.sql first");
    await svc("DELETE", `manual_assignments?agent_id=in.(${a1.id},${a2.id},${a3.id})`);
    await svc("POST", "assignments", [{ agent_id: a1.id, shift_id: s1.id }, { agent_id: a2.id, shift_id: s2.id }]);   // as if auto assign ran: s1 full, s2 has 1 of 2 open
    const seat = (who, agentId, shiftId) => who("POST", "rpc/assign_open_seat", { p_agent_id: agentId, p_shift_id: shiftId });
    r = await seat(admin, a3.id, s2.id); check("open seat: an admin without Manual assignment cannot", !r.ok && /permission/.test(r.data.message), r.data);
    r = await seat(agent, a3.id, s2.id); check("open seat: an agent cannot", !r.ok, r.data);
    r = await seat(boss, a1.id, s2.id); check("open seat: refused for an agent who already has a shift", !r.ok && /already has an assigned shift/.test(r.data.message), r.data);
    r = await seat(boss, a3.id, s1.id); check("open seat: refused when the shell is full", !r.ok && /no open seats/.test(r.data.message), r.data);
    r = await seat(boss, a3.id, other.id); check("open seat: the shell must be in the agent's LOB", !r.ok && /but Manual three is in/.test(r.data.message), r.data);
    r = await seat(boss, a3.id, s2.id);
    const a3Asg = (await svc("GET", `assignments?select=shift_id&agent_id=eq.${a3.id}`)).data || [];
    const a3Man = (await svc("GET", `manual_assignments?select=shift_id,assigned_by&agent_id=eq.${a3.id}`)).data || [];
    check("open seat: saved to the results and kept as a manual assignment", r.ok && a3Asg.length === 1 && a3Asg[0].shift_id === s2.id && a3Man[0]?.shift_id === s2.id && a3Man[0]?.assigned_by === emails.boss, { r: r.data, a3Asg, a3Man });
    r = await seat(boss, a3.id, s2.id); check("open seat: cannot be given twice", !r.ok && /already has an assigned shift/.test(r.data.message), r.data);
    check("open seat: nobody else's shift changed", JSON.stringify(((await svc("GET", `assignments?select=agent_id,shift_id&agent_id=in.(${a1.id},${a2.id})&order=agent_id`)).data || []).map(x => x.shift_id)) === JSON.stringify([s1.id, s2.id]));
    await svc("DELETE", `assignments?agent_id=eq.${a2.id}`);
    await svc("PATCH", `agents?id=eq.${a2.id}`, { excluded: true });
    r = await seat(boss, a2.id, s2.id); check("open seat: refused for a removed agent", !r.ok && /not part of the shift bid/.test(r.data.message), r.data);

    // ---- after auto assign: moving an agent who has a shift to an open seat (move_to_open_seat)
    // Now: a1 on s1 (1 seat, full), a3 on s2 (2 seats, 1 open).
    const move = (who, agentId, shiftId) => who("POST", "rpc/move_to_open_seat", { p_agent_id: agentId, p_shift_id: shiftId });
    const onShell = async agentId => ((await svc("GET", `assignments?select=shift_id&agent_id=eq.${agentId}`)).data || [])[0]?.shift_id;
    r = await move(admin, a1.id, s2.id); check("move: an admin without Manual assignment cannot", !r.ok && /permission/.test(r.data.message), r.data);
    r = await move(boss, a1.id, s2.id);
    const a1Man = (await svc("GET", `manual_assignments?select=shift_id&agent_id=eq.${a1.id}`)).data || [];
    check("move: the agent moves to the open seat, kept as a manual assignment", r.ok && (await onShell(a1.id)) === s2.id && a1Man[0]?.shift_id === s2.id, { r: r.data, a1Man });
    check("move: nobody else changes", (await onShell(a3.id)) === s2.id);
    r = await move(boss, a1.id, s2.id); check("move: refused when they are already on that shell", !r.ok && /already on that shell/.test(r.data.message), r.data);
    r = await move(boss, a3.id, s1.id); check("move: their old seat opened up for someone else", r.ok && (await onShell(a3.id)) === s1.id, r.data);
    r = await move(boss, a1.id, s1.id); check("move: refused when the shell is full", !r.ok && /no open seats/.test(r.data.message) && (await onShell(a1.id)) === s2.id, r.data);
    r = await move(boss, a1.id, other.id); check("move: the shell must be in the agent's LOB", !r.ok && /but Manual one is in/.test(r.data.message), r.data);
    const [s4] = (await svc("POST", "shift_shells", { lob: LOB, seats: 1, days: "0,1,2,3", start_local: "10:00", end_local: "21:00", timezone: "America/New_York", schedule: "manual s4" })).data;
    await svc("PATCH", `assignments?agent_id=eq.${a1.id}`, { pushed_at: new Date().toISOString() });
    r = await move(boss, a1.id, s4.id); check("move: once in Assembled, refused unless the admin confirms they deleted it there", !r.ok && /already in Assembled/.test(r.data.message) && (await onShell(a1.id)) === s2.id, r.data);
    r = await boss("POST", "rpc/move_to_open_seat", { p_agent_id: a1.id, p_shift_id: s4.id, p_pushed_ok: true });
    const a1Row = ((await svc("GET", `assignments?select=shift_id,pushed_at&agent_id=eq.${a1.id}`)).data || [])[0];
    check("move: with that confirmed, they move and can be pushed again", r.ok && a1Row?.shift_id === s4.id && a1Row?.pushed_at === null, { r: r.data, a1Row });
    r = await move(boss, a1.id, s2.id); check("move: and can move back to their old shell's open seat", r.ok && (await onShell(a1.id)) === s2.id, r.data);
    const swapRow = (await svc("POST", "swap_requests", { lob: LOB, requester_id: a1.id, partner_id: a3.id, start_date: "2099-01-05", end_date: "2099-01-06", give_date: "2099-01-05", take_date: "2099-01-06", status: "approved" })).data;
    r = await move(boss, a1.id, s4.id); check("move: refused while they have an approved day swap still to come", !r.ok && /approved day swap/.test(r.data.message), r.data);
    if (swapRow?.[0]) await svc("DELETE", `swap_requests?id=eq.${swapRow[0].id}`);
    const trade = (await svc("POST", "shift_trades", { lob: LOB, requester_id: a1.id, partner_id: a3.id, requester_shift_id: s2.id, partner_shift_id: s1.id, status: "pending_admin" })).data;
    r = await move(boss, a1.id, s1.id); check("move: refused while they have a trade waiting", !r.ok && /trade or day swap waiting/.test(r.data.message), r.data);
    if (trade?.[0]) await svc("DELETE", `shift_trades?id=eq.${trade[0].id}`);
    r = await move(boss, a2.id, s1.id); check("move: refused for a removed agent", !r.ok && /not part of the shift bid/.test(r.data.message), r.data);

    await svc("PATCH", `admins?email=eq.${encodeURIComponent(emails.boss)}`, { permissions: [] });
    r = await boss("DELETE", `manual_assignments?agent_id=eq.${a1.id}`); check("once taken off the list, they cannot change anything", r.ok && r.data.length === 0, r);
  } catch (err) {
    fails++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    const ag = (await svc("GET", `agents?select=id&lob=eq.${LOB}`)).data || [];
    if (ag.length) await svc("DELETE", `manual_assignments?agent_id=in.(${ag.map(a => a.id).join(",")})`);
    if (ag.length) await svc("DELETE", `assignments?agent_id=in.(${ag.map(a => a.id).join(",")})`);
    if (ag.length) await svc("DELETE", `swap_requests?requester_id=in.(${ag.map(a => a.id).join(",")})`);
    if (ag.length) await svc("DELETE", `shift_trades?requester_id=in.(${ag.map(a => a.id).join(",")})`);
    await svc("DELETE", `shift_shells?lob=in.(${LOB},${LOB}x)`);
    await svc("DELETE", `agents?lob=eq.${LOB}`);
    await svc("DELETE", `manual_assigners?email=in.(${encodeURIComponent(emails.boss)},${encodeURIComponent(emails.admin)},${encodeURIComponent(emails.agent)})`);
    await svc("DELETE", `admins?email=in.(${encodeURIComponent(emails.boss)},${encodeURIComponent(emails.admin)})`);
    for (const u of Object.values(users)) if (u.id) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: svcH });
    const left = (await svc("GET", `agents?select=id&lob=eq.${LOB}`)).data || [];
    console.log(`Cleanup done (${left.length} test agents left).`);
    console.log(fails ? `\n${fails} failed` : "\nAll manual assignment checks passed.");
    process.exit(fails ? 1 : 0);
  }
})();
