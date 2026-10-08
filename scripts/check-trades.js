// Checks supabase/shift-trades.sql against the live Supabase project: agents trade assigned shifts
// for good (same LOB, inside the swap window), the partner accepts, an admin approves, and approving
// exchanges the two assignments. Uses a throwaway LOB and logins that are deleted afterwards.
// Never touches Assembled. Run: npm run check:trades
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: k } = process.env;

const LOB = "__trade_test__", OTHER = "__trade_test__x", stamp = Date.now(), password = `Trade-${stamp}-pw`;
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
const hour = 3600e3, at = ms => new Date(Date.now() + ms).toISOString();

(async () => {
  if ((await svc("GET", "shift_trades?select=id&limit=1")).status === 404) {
    console.error("public.shift_trades does not exist. Run supabase/shift-trades.sql in the Supabase SQL Editor first."); process.exit(1);
  }
  const keys = ["A", "B", "C", "ADMIN"], emails = Object.fromEntries(keys.map(k => [k, `trade-${k.toLowerCase()}-${stamp}@example.com`]));
  const users = {};
  try {
    const [s1, s2, s3, s4] = (await svc("POST", "shift_shells", [
      { lob: LOB, seats: 2, days: "1,2,3,4,5", start_local: "08:00", end_local: "17:00", timezone: "America/New_York", schedule: "trade s1", set_name: "A" },
      { lob: LOB, seats: 2, days: "0,1,2,3", start_local: "11:00", end_local: "22:00", timezone: "America/New_York", schedule: "trade s2", set_name: "B" },
      { lob: OTHER, seats: 2, days: "1,2,3,4,5", start_local: "12:00", end_local: "21:00", timezone: "America/New_York", schedule: "trade s3", set_name: null },
      { lob: LOB, seats: 2, days: "2,3,4,5,6", start_local: "13:00", end_local: "22:00", timezone: "America/New_York", schedule: "trade s4", set_name: null },
    ])).data;
    const ag = (await svc("POST", "agents", ["A", "B", "C"].map(key => ({
      email: emails[key], name: `Trade ${key}`, lob: key === "C" ? OTHER : LOB, assembled_id: `trade-${key}-${stamp}`, excluded: false,
    })))).data;
    const id = Object.fromEntries(ag.map(a => [a.name.slice(-1), a.id]));
    const asg = (await svc("POST", "assignments", [
      { agent_id: id.A, shift_id: s1.id }, { agent_id: id.B, shift_id: s2.id }, { agent_id: id.C, shift_id: s3.id },
    ])).data;
    const asgOf = Object.fromEntries(asg.map(a => [a.agent_id, a.id]));
    for (const key of keys) {
      const u = await (await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: svcH, body: JSON.stringify({ email: emails[key], password, email_confirm: true }) })).json();
      const t = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: emails[key], password }) })).json();
      users[key] = { id: u.id, rest: as(t.access_token) };
    }
    await svc("POST", "admins", { email: emails.ADMIN });
    const A = users.A.rest, B = users.B.rest, admin = users.ADMIN.rest;
    const rpc = (who, fn, args) => who("POST", `rpc/${fn}`, args);
    const shiftOf = async agentId => ((await svc("GET", `assignments?select=shift_id&agent_id=eq.${agentId}`)).data || [])[0]?.shift_id;
    const statusOf = async tid => ((await svc("GET", `shift_trades?select=status&id=eq.${tid}`)).data || [])[0]?.status;

    // Before the LOB's results are published, even an open trade window does not allow trades.
    await svc("POST", "swap_windows", { lob: LOB, kind: "trade", opens_at: at(-hour), closes_at: at(hour) });
    let r = await rpc(A, "trade_board", {});
    check("unpublished: the trade board is empty", r.ok && r.data.published === false && r.data.trades.length === 0, r.data);
    r = await rpc(A, "request_trade", { p_partner_id: id.B });
    check("unpublished: trade requests are refused, even with the trade window open", !r.ok && /not published/.test(r.data.message), r.data);
    await svc("DELETE", `swap_windows?lob=eq.${LOB}`);
    await svc("POST", "published_results", { lob: LOB });

    r = await rpc(A, "request_trade", { p_partner_id: id.B });
    check("no trade window: trade requests are refused", !r.ok && /not open/.test(r.data.message), r.data);
    await svc("POST", "swap_windows", { lob: LOB, kind: "swap", opens_at: at(-hour), closes_at: at(hour) });
    r = await rpc(A, "request_trade", { p_partner_id: id.B });
    check("an open day swap window does not open trades", !r.ok && /not open/.test(r.data.message), r.data);
    await svc("POST", "swap_windows", { lob: LOB, kind: "trade", opens_at: at(-hour), closes_at: at(hour) });

    r = await rpc(A, "trade_board", {});
    check("trade board: not pushed yet, no trades", r.ok && r.data.pushed === false && r.data.trades.length === 0, r.data);
    r = await rpc(A, "request_trade", { p_partner_id: id.C }); check("cannot trade with another LOB", !r.ok && /own LOB/.test(r.data.message), r.data);
    r = await rpc(A, "request_trade", { p_partner_id: id.A }); check("cannot trade with yourself", !r.ok, r.data);
    r = await rpc(A, "request_trade", { p_partner_id: id.B, p_note: "mornings please" });
    const t1 = r.data; check("valid trade request", r.ok && Number.isInteger(t1), r.data);
    r = await rpc(B, "request_trade", { p_partner_id: id.A }); check("only one waiting trade per person", !r.ok && /already have a shift trade waiting/.test(r.data.message), r.data);
    r = await A("GET", "shift_trades?select=id"); check("agents cannot read the trades table directly", r.ok && r.data.length === 0, r);
    r = await A("POST", "shift_trades", { lob: LOB, requester_id: id.A, partner_id: id.B }); check("agents cannot write the trades table directly", !r.ok, r);
    r = await rpc(B, "trade_board", {});
    const seen = (r.data.trades || []).find(t => t.id === t1);
    check("partner sees it, with the shift they would get", seen && !seen.mine && seen.their_shift?.id === s1.id && !("set_name" in seen.their_shift), seen);
    r = await rpc(A, "respond_trade", { p_id: t1, p_accept: true }); check("the requester cannot accept their own trade", !r.ok, r.data);
    r = await rpc(B, "respond_trade", { p_id: t1, p_accept: true }); check("partner accepts: goes to the admin", r.ok && (await statusOf(t1)) === "pending_admin", r.data);
    r = await rpc(B, "cancel_trade", { p_id: t1 }); check("the partner cannot cancel it", !r.ok, r.data);
    r = await rpc(A, "decide_trade", { p_id: t1, p_approve: true }); check("agents cannot approve", !r.ok, r.data);
    r = await rpc(admin, "decide_trade", { p_id: t1, p_approve: true, p_note: "ok" });
    check("admin approves: the two assignments are exchanged", r.ok && (await shiftOf(id.A)) === s2.id && (await shiftOf(id.B)) === s1.id && (await statusOf(t1)) === "approved", r.data);
    r = await rpc(admin, "decide_trade", { p_id: t1, p_approve: false }); check("a decided trade cannot be decided again", !r.ok, r.data);

    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t2 = r.data;
    r = await rpc(B, "respond_trade", { p_id: t2, p_accept: false }); check("partner can decline", r.ok && (await statusOf(t2)) === "declined", r.data);
    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t3 = r.data;
    r = await rpc(A, "cancel_trade", { p_id: t3 }); check("requester can cancel while waiting", r.ok && (await statusOf(t3)) === "cancelled", r.data);

    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t4 = r.data;
    await rpc(B, "respond_trade", { p_id: t4, p_accept: true });
    await svc("PATCH", `assignments?id=eq.${asgOf[id.A]}`, { shift_id: s4.id });   // as if auto assign ran again
    r = await rpc(admin, "decide_trade", { p_id: t4, p_approve: true });
    check("approval is refused when their shifts changed since they asked, and nothing moves",
      !r.ok && /changed since they asked/.test(r.data.message) && (await shiftOf(id.A)) === s4.id && (await shiftOf(id.B)) === s1.id, r.data);
    r = await rpc(admin, "decide_trade", { p_id: t4, p_approve: false, p_note: "ask again" });
    check("admin rejects", r.ok && (await statusOf(t4)) === "rejected", r.data);

    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t5 = r.data;
    await rpc(B, "respond_trade", { p_id: t5, p_accept: true });
    await svc("PATCH", `assignments?id=eq.${asgOf[id.B]}`, { pushed_at: new Date().toISOString() });
    r = await rpc(admin, "decide_trade", { p_id: t5, p_approve: true });
    check("approval is refused once the schedule is in Assembled", !r.ok && /already in Assembled/.test(r.data.message) && (await shiftOf(id.A)) === s4.id, r.data);
    r = await rpc(B, "trade_board", {}); check("trade board says when the schedule is pushed", r.ok && r.data.pushed === true, r.data);
    await rpc(admin, "decide_trade", { p_id: t5, p_approve: false });
    await svc("PATCH", `assignments?id=eq.${asgOf[id.B]}`, { pushed_at: null });

    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t6 = r.data;
    await svc("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { opens_at: at(-2 * hour), closes_at: at(-60e3) });
    r = await rpc(A, "request_trade", { p_partner_id: id.B }); check("closed window: new trade requests are refused", !r.ok && /not open/.test(r.data.message), r.data);
    r = await rpc(B, "respond_trade", { p_id: t6, p_accept: true }); check("closed window: accepting is refused", !r.ok && /not open/.test(r.data.message), r.data);
    r = await rpc(B, "trade_board", {}); const gone = (r.data.trades || []).find(t => t.id === t6);
    check("closed window: an unanswered trade is auto declined", (await statusOf(t6)) === "declined" && gone?.status === "declined" && gone.auto_declined === true, gone);
    r = await rpc(B, "respond_trade", { p_id: t6, p_accept: false }); check("an auto declined trade cannot be answered any more", !r.ok, r.data);

    // Accepted before the close: it stays with the admin.
    await svc("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { opens_at: at(-hour), closes_at: at(hour) });
    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t6b = r.data;
    await rpc(B, "respond_trade", { p_id: t6b, p_accept: true });
    await svc("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { opens_at: at(-2 * hour), closes_at: at(-60e3) });
    await rpc(admin, "expire_closed_trades", {});
    check("closed window: a trade already accepted still waits for the admin", (await statusOf(t6b)) === "pending_admin");
    await rpc(admin, "decide_trade", { p_id: t6b, p_approve: false });

    // The window passes its close time with nobody looking, then the admin opens it again: the old
    // unanswered trade does not come back.
    await svc("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { opens_at: at(-hour), closes_at: at(5e3) });
    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t6c = r.data;
    await new Promise(res => setTimeout(res, 7e3));
    check("a window that closed on its own leaves the trade untouched until someone looks", (await statusOf(t6c)) === "pending_partner");
    await svc("PATCH", `swap_windows?lob=eq.${LOB}&kind=eq.trade`, { opens_at: at(-hour), closes_at: at(hour) });
    check("opening the window again does not bring the old unanswered trade back", (await statusOf(t6c)) === "declined");

    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t6d = r.data;
    await svc("DELETE", `swap_windows?lob=eq.${LOB}&kind=eq.trade`);
    check("removing the trade window auto declines unanswered trades right away", (await statusOf(t6d)) === "declined");

    await svc("POST", "swap_windows", { lob: LOB, kind: "trade", opens_at: at(-hour), closes_at: at(hour) });
    r = await rpc(A, "request_trade", { p_partner_id: id.B }); const t7 = r.data;
    await rpc(admin, "expire_closed_trades", {});
    r = await rpc(B, "trade_board", {});
    check("open window: an unanswered trade stays waiting", (await statusOf(t7)) === "pending_partner", r.data);
    await svc("DELETE", `published_results?lob=eq.${LOB}`);
    r = await rpc(B, "respond_trade", { p_id: t7, p_accept: true });
    check("unpublished again: accepting is refused, and the trade stays waiting", !r.ok && /not published/.test(r.data.message) && (await statusOf(t7)) === "pending_partner", r.data);
  } catch (err) {
    fails++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    const agents = (await svc("GET", `agents?select=id&lob=in.(${LOB},${OTHER})`)).data || [];
    const ids = agents.map(a => a.id).join(",");
    if (ids) {
      await svc("DELETE", `shift_trades?requester_id=in.(${ids})`);
      await svc("DELETE", `assignments?agent_id=in.(${ids})`);
    }
    await svc("DELETE", `swap_windows?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `published_results?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `shift_shells?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `agents?lob=in.(${LOB},${OTHER})`);
    await svc("DELETE", `admins?email=eq.${encodeURIComponent(emails.ADMIN)}`);
    for (const u of Object.values(users)) if (u.id) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: svcH });
    const left = (await svc("GET", `agents?select=id&lob=in.(${LOB},${OTHER})`)).data || [];
    console.log(`Cleanup done (${left.length} test agents left).`);
    console.log(fails ? `\n${fails} failed` : "\nAll shift trade checks passed.");
    process.exit(fails ? 1 : 0);
  }
})();
