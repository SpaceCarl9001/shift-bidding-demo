// Checks the shift swap rules in supabase/swaps.sql and the admin reject/refuse paths in api/swaps.js,
// against the live Supabase project, using throwaway agents in LOB "__swap_test__" that are deleted
// afterwards. Never touches Assembled (the test agents have no Assembled id). Run: npm run check:swaps
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const swapsHandler = require("../api/swaps.js");
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: k } = process.env;

const LOB = "__swap_test__", OTHER = "__swap_test__x", stamp = Date.now(), password = `Swap-${stamp}-pw`;
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
const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// A date in the work week k weeks from now (k = 0 is this week); i = 0 for Monday ... 6 for Sunday.
const wk = (k, i) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7 * k + i); return d.toISOString().slice(0, 10); };
const MON = 0, THU = 3, FRI = 4, SAT = 5, SUN = 6;
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  -> " + JSON.stringify(detail).slice(0, 220)}`); };
const callApi = (token, body) => new Promise(resolve => {
  const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
  swapsHandler({ method: "POST", headers: { authorization: `Bearer ${token}` }, body }, res);
});

(async () => {
  if ((await svc("GET", "swap_requests?select=id&limit=1")).status === 404) {
    console.error("public.swap_requests does not exist. Run supabase/swaps.sql in the Supabase SQL Editor first."); process.exit(1);
  }
  if ((await svc("GET", "published_results?select=lob&limit=1")).status !== 200) {
    console.error("public.published_results does not exist. Run the updated supabase/swaps.sql and shift-trades.sql first."); process.exit(1);
  }
  const users = {}, emails = {};
  for (const key of ["A", "B", "C", "D", "E", "F", "ADMIN"]) emails[key] = `swap-${key.toLowerCase()}-${stamp}@example.com`;
  try {
    const shells = (await svc("POST", "shift_shells", [
      { lob: LOB, seats: 2, days: "1,2,3,4,5", start_local: "08:00", end_local: "17:00", timezone: "UTC", schedule: "swap s1", set_name: "A" },
      { lob: LOB, seats: 2, days: "0,1,2,3", start_local: "11:00", end_local: "22:00", timezone: "UTC", schedule: "swap s2", set_name: "B" },
      { lob: OTHER, seats: 2, days: "1,2,3,4,5", start_local: "12:00", end_local: "21:00", timezone: "UTC", schedule: "swap s3", set_name: null },
    ])).data;
    const [s1, s2, s3] = shells;
    const agentRows = (await svc("POST", "agents", ["A", "B", "C", "D", "E", "F"].map(key => ({
      email: emails[key], name: `Swap ${key}`, lob: key === "C" ? OTHER : LOB, assembled_id: `swap-${key}-${stamp}`, excluded: key === "D",
    })))).data;
    const id = Object.fromEntries(agentRows.map(a => [a.name.slice(-1), a.id]));
    await svc("POST", "assignments", [
      { agent_id: id.A, shift_id: s1.id }, { agent_id: id.B, shift_id: s2.id }, { agent_id: id.C, shift_id: s3.id },
      { agent_id: id.D, shift_id: s2.id }, { agent_id: id.F, shift_id: s1.id },
    ]);
    for (const key of ["A", "B", "C", "F", "ADMIN"]) {
      const u = await (await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: svcH, body: JSON.stringify({ email: emails[key], password, email_confirm: true }) })).json();
      const t = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: emails[key], password }) })).json();
      users[key] = { id: u.id, token: t.access_token, rest: as(t.access_token) };
    }
    const A = users.A.rest, B = users.B.rest, C = users.C.rest;
    const rpc = (who, fn, args) => who("POST", `rpc/${fn}`, args);

    // ---- before the LOB's results are published: nothing to see, nothing to ask for
    let r = await rpc(A, "swap_board", {});
    check("unpublished: the agent sees no shift and no colleagues", r.ok && r.data.published === false && r.data.me.shift === null && r.data.colleagues.length === 0, r.data);
    r = await rpc(A, "request_day_swap", { p_partner_id: id.B, p_give: wk(1, THU), p_take: wk(1, SUN) });
    check("unpublished: day swaps cannot be asked for", !r.ok && /not published/.test(r.data.message), r.data);
    r = await A("POST", "published_results", { lob: LOB }); check("agents cannot publish results", !r.ok, r);
    r = await svc("POST", "published_results", { lob: LOB }); check("results published (test setup)", r.ok, r);

    // ---- what agents can see
    r = await rpc(A, "swap_board", {});
    const board = r.data;
    check("agent sees their own shift", r.ok && board.me.shift && board.me.shift.id === s1.id, r);
    const names = (board.colleagues || []).map(c => c.name).sort().join();
    check("colleagues: same LOB, has a shift, not removed (B and F only)", names === "Swap B,Swap F", names);
    check("colleagues show name and shift only (no email or rank)", board.colleagues.every(c => !("email" in c) && !("rank" in c)));
    check("agents do not see admin-only set names on shifts",
      !("set_name" in board.me.shift) && board.colleagues.every(c => !("set_name" in c.shift)), board);
    r = await A("GET", "swap_requests?select=id");
    check("agents cannot read the swaps table directly", r.ok && r.data.length === 0, r);
    r = await A("POST", "swap_requests", { lob: LOB, requester_id: id.A, partner_id: id.B, start_date: day(1), end_date: day(2) });
    check("agents cannot write the swaps table directly", !r.ok, r);

    // ---- rest-day swaps, always open (only shift trades have a window).
    // A works Mon-Fri, B works Sun-Wed: A can give Thu or Fri (B is off) and take Sun (B works).
    const ask = (who, partner, give, take) => rpc(who, "request_day_swap", { p_partner_id: partner, p_give: give, p_take: take, p_note: "test" });
    const hour = 3600e3, at = ms => new Date(Date.now() + ms).toISOString();
    r = await ask(A, id.B, wk(1, THU), wk(1, SUN));
    const swap1 = r.data;
    check("no window needed: give Thursday, take Sunday, same week, goes through", r.ok && Number.isInteger(swap1), r.data);
    r = await rpc(A, "request_swap", { p_partner_id: id.B, p_start: day(2), p_end: day(2) });
    check("the old one-day request is retired with a clear message", !r.ok && /Refresh the page/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(1, FRI), wk(2, SUN)); check("both days must be in the same Monday-to-Sunday week", !r.ok && /same Monday-to-Sunday week/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(2, SAT), wk(2, SUN)); check("the day you give must be one of your work days", !r.ok && /not scheduled/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(2, MON), wk(2, SUN)); check("the partner must be off on the day you give", !r.ok && /also works/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(2, THU), wk(2, FRI)); check("the day you take must be one of your days off", !r.ok && /already work/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(2, THU), wk(2, SAT)); check("the partner must work the day you take", !r.ok && /off on .* too/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(2, THU), wk(2, THU)); check("two different days", !r.ok && /two different days/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(-2, THU), wk(-2, SUN)); check("cannot be in the past", !r.ok && /past/.test(r.data.message), r.data);
    await svc("POST", "swap_windows", [{ lob: LOB, kind: "trade", opens_at: at(-hour), closes_at: at(hour) }, { lob: OTHER, kind: "trade", opens_at: at(-hour), closes_at: at(hour) }]);
    r = await A("POST", "swap_windows", { lob: `${LOB}y`, kind: "trade", opens_at: at(-hour), closes_at: at(hour) }); check("agents cannot create a window", !r.ok, r);
    r = await A("PATCH", `swap_windows?lob=eq.${LOB}`, { opens_at: at(-2 * hour) }); check("agents cannot change a window", r.ok && r.data.length === 0, r);
    r = await A("GET", "swap_windows?select=lob,kind"); check("agents only see their own LOB's window", r.ok && r.data.length === 1 && r.data[0].lob === LOB, r.data);

    // ---- who you can ask, and when
    r = await ask(A, id.C, wk(2, THU), wk(2, SUN)); check("cannot swap with another LOB", !r.ok && /own LOB/.test(r.data.message), r.data);
    r = await ask(A, id.D, wk(2, THU), wk(2, SUN)); check("cannot swap with a removed person", !r.ok, r.data);
    r = await ask(A, id.A, wk(2, THU), wk(2, SUN)); check("cannot swap with yourself", !r.ok && /yourself/.test(r.data.message), r.data);
    r = await ask(A, id.F, wk(2, THU), wk(2, SUN)); check("cannot swap with someone on the same shift", !r.ok && /same shift/.test(r.data.message), r.data);
    r = await ask(A, id.E, wk(2, THU), wk(2, SUN)); check("cannot swap with someone who has no shift", !r.ok && /assigned shift/.test(r.data.message), r.data);
    r = await ask(users.F.rest, id.B, wk(1, THU), wk(1, SUN)); check("no overlapping swaps for the same person", !r.ok && /already have a swap/.test(r.data.message), r.data);
    r = await ask(A, id.B, wk(1, FRI), wk(1, SUN)); check("a day already in a swap cannot be used again", !r.ok && /already have a swap/.test(r.data.message), r.data);

    // ---- partner responds
    r = await rpc(B, "swap_board", {});
    const seen = (r.data.requests || []).find(x => x.id === swap1);
    check("partner sees the request, waiting for them", seen && !seen.mine && seen.status === "pending_partner" && seen.other_name === "Swap A", seen);
    check("partner sees the two days", seen && seen.give_date === wk(1, THU) && seen.take_date === wk(1, SUN), seen);
    r = await rpc(C, "respond_swap", { p_id: swap1, p_accept: true }); check("someone else cannot accept it", !r.ok, r.data);
    r = await rpc(A, "respond_swap", { p_id: swap1, p_accept: true }); check("the requester cannot accept their own request", !r.ok, r.data);
    r = await rpc(B, "respond_swap", { p_id: swap1, p_accept: true });
    const afterAccept = (await svc("GET", `swap_requests?select=status&id=eq.${swap1}`)).data[0];
    check("partner accepts: goes to the admin", r.ok && afterAccept.status === "pending_admin", { r: r.data, afterAccept });
    r = await rpc(B, "cancel_swap", { p_id: swap1 }); check("the partner cannot cancel it", !r.ok, r.data);

    // ---- admin
    process.env.ADMIN_EMAILS = `${process.env.ADMIN_EMAILS},${emails.ADMIN}`;
    await svc("POST", "admins", { email: emails.ADMIN });
    r = await callApi(users.A.token, { action: "reject", id: swap1 }); check("agents cannot use the admin swap actions", r.status === 403, r);
    r = await callApi(users.ADMIN.token, { action: "approve", id: swap1 });
    const stillPending = (await svc("GET", `swap_requests?select=status&id=eq.${swap1}`)).data[0];
    check("approval is refused when agents have no Assembled id, and nothing changes",
      r.status === 409 && /Assembled agent id/.test(r.body.error) && stillPending.status === "pending_admin", r.body);
    r = await users.ADMIN.rest("GET", `swap_requests?select=id,status&lob=eq.${LOB}`);
    check("admins can see the LOB's swaps", r.ok && r.data.length === 1, r);
    r = await callApi(users.ADMIN.token, { action: "reject", id: swap1, note: "Test rejection" });
    const rejected = (await svc("GET", `swap_requests?select=status,admin_note,decided_by&id=eq.${swap1}`)).data[0];
    check("admin rejects with a note", r.status === 200 && rejected.status === "rejected" && rejected.admin_note === "Test rejection" && rejected.decided_by === emails.ADMIN, rejected);
    r = await callApi(users.ADMIN.token, { action: "reject", id: swap1 }); check("a decided swap cannot be decided again", r.status === 409, r.body);

    // ---- cancel and decline
    r = await ask(A, id.B, wk(2, THU), wk(2, SUN)); const swap2 = r.data;
    r = await rpc(A, "cancel_swap", { p_id: swap2 });
    check("requester can cancel while pending", r.ok && (await svc("GET", `swap_requests?select=status&id=eq.${swap2}`)).data[0].status === "cancelled", r.data);
    r = await ask(A, id.B, wk(2, THU), wk(2, SUN)); const swap3 = r.data;
    check("dates free again after a cancel", Number.isInteger(swap3), r.data);
    r = await rpc(B, "respond_swap", { p_id: swap3, p_accept: false });
    check("partner can decline", r.ok && (await svc("GET", `swap_requests?select=status&id=eq.${swap3}`)).data[0].status === "declined", r.data);
    r = await rpc(A, "swap_board", {});
    check("requester's board shows their history", (r.data.requests || []).length === 3, (r.data.requests || []).map(x => x.status));

    // ---- a closed trade window does not affect day swaps
    r = await users.ADMIN.rest("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { opens_at: at(-2 * hour), closes_at: at(-60e3) });
    check("admins can edit the trade window", r.ok && r.data.length === 1, r);
    r = await ask(A, id.B, wk(3, FRI), wk(3, SUN)); const swap4 = r.data;
    check("with the trade window closed, day swaps can still be asked for", r.ok && Number.isInteger(swap4), r.data);
    r = await rpc(B, "respond_swap", { p_id: swap4, p_accept: true });
    check("and accepted", r.ok && (await svc("GET", `swap_requests?select=status&id=eq.${swap4}`)).data[0].status === "pending_admin", r.data);
    r = await users.ADMIN.rest("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { closes_at: at(-3 * hour) });
    check("a window must close after it opens", !r.ok, r);

    // ---- unpublishing hides everything again, and requests wait
    r = await ask(A, id.B, wk(4, THU), wk(4, SUN)); const swap5 = r.data;
    r = await users.ADMIN.rest("DELETE", `published_results?lob=eq.${LOB}`); check("admins can unpublish results", r.ok && r.data.length === 1, r);
    r = await rpc(B, "swap_board", {}); check("unpublished again: no shifts or requests shown", r.ok && r.data.published === false && r.data.requests.length === 0, r.data);
    r = await rpc(B, "respond_swap", { p_id: swap5, p_accept: true });
    check("unpublished: a waiting swap cannot be accepted, and stays waiting", !r.ok && (await svc("GET", `swap_requests?select=status&id=eq.${swap5}`)).data[0].status === "pending_partner", r.data);
    r = await users.ADMIN.rest("POST", "published_results", { lob: LOB });
    check("admins can publish results, stamped with who did it", r.ok && r.data[0]?.published_by === emails.ADMIN, r);
  } catch (err) {
    fails++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    const agents = (await svc("GET", `agents?select=id&lob=in.(${LOB},${OTHER})`)).data || [];
    const ids = agents.map(a => a.id).join(",");
    if (ids) {
      await svc("DELETE", `swap_requests?requester_id=in.(${ids})`);
      await svc("DELETE", `assignments?agent_id=in.(${ids})`);
      await svc("DELETE", `bids2?agent_id=in.(${ids})`);
    }
    await svc("DELETE", `swap_windows?lob=in.(${LOB},${OTHER},${LOB}y)`);
    await svc("DELETE", `published_results?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `shift_shells?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `agents?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `admins?email=eq.${encodeURIComponent(emails.ADMIN)}`);
    for (const u of Object.values(users)) if (u.id) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: svcH });
    const left = (await svc("GET", `agents?select=id&lob=in.(${LOB},${OTHER})`)).data || [];
    console.log(`Cleanup done (${left.length} test agents left).`);
  }
  console.log(fails ? `\n${fails} check(s) failed.` : "\nAll swap checks passed.");
  process.exit(fails ? 1 : 0);
})();
