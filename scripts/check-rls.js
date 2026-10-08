// Verifies the row-level security policies from supabase/rls-policies.sql and the
// all-or-nothing save functions from supabase/save-functions.sql.
// Creates a temporary user plus test rows in LOB "__rls_test__", checks what a logged-out
// visitor, an agent and an admin can do, then deletes everything it created.
// Reads SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY from .env.local.
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;

const LOB = "__rls_test__";
const stamp = Date.now();
const email = `rls-test-${stamp}@example.com`;
const otherEmail = `rls-other-${stamp}@example.com`;
const password = `Rls-${stamp}-${Math.random().toString(36).slice(2)}`;

async function call(method, url, key, token, body, prefer = "return=representation") {
  const r = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}
const svc = (method, p, body) => call(method, `${SUPABASE_URL}/rest/v1/${p}`, SUPABASE_SERVICE_KEY, SUPABASE_SERVICE_KEY, body);
const asAnon = (method, p, body) => call(method, `${SUPABASE_URL}/rest/v1/${p}`, SUPABASE_ANON_KEY, SUPABASE_ANON_KEY, body);
let userToken;
const asUser = (method, p, body) => call(method, `${SUPABASE_URL}/rest/v1/${p}`, SUPABASE_ANON_KEY, userToken, body);

let failures = 0;
function check(label, pass, detail) {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass || !detail ? "" : `  -> ${JSON.stringify(detail).slice(0, 200)}`}`);
}
function must(res, what) {
  if (!res.ok) throw new Error(`Setup step failed (${what}): ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  return res.data;
}
const shell = n => ({ lob: LOB, seats: 1, days: "1", start_local: "08:00", end_local: "17:00", timezone: "UTC", schedule: `rls test ${n}` });

async function main() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    throw new Error("Missing SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_KEY in .env.local");
  }
  if ((await svc("GET", "admins?select=email&limit=1")).status === 404) {
    throw new Error("public.admins does not exist. Run supabase/rls-policies.sql in the Supabase SQL Editor first.");
  }

  let userId;
  try {
    // ---- logged-out visitor
    const anonInsert = await asAnon("POST", "shift_shells", shell("anon"));
    check("logged-out visitor cannot add a shift shell", !anonInsert.ok, anonInsert);

    // ---- temporary user and test data
    const created = await call("POST", `${SUPABASE_URL}/auth/v1/admin/users`, SUPABASE_SERVICE_KEY, SUPABASE_SERVICE_KEY,
      { email, password, email_confirm: true });
    userId = must(created, "create temp user").id;
    const login = await call("POST", `${SUPABASE_URL}/auth/v1/token?grant_type=password`, SUPABASE_ANON_KEY, SUPABASE_ANON_KEY,
      { email, password });
    userToken = must(login, "sign in temp user").access_token;

    const [me, other] = must(await svc("POST", "agents", [
      { email, name: "RLS Test", lob: LOB, assembled_id: `rls-test-${stamp}` },
      { email: otherEmail, name: "RLS Other", lob: LOB, assembled_id: `rls-other-${stamp}` },
    ]), "create test agents");
    const [testShell] = must(await svc("POST", "shift_shells", { ...shell("setup"), set_name: "A" }), "create test shift shell");
    const hour = 3600 * 1000;
    const [win] = must(await svc("POST", "bid_windows", {
      lob: LOB, opens_at: new Date(Date.now() - hour).toISOString(), closes_at: new Date(Date.now() + hour).toISOString(),
    }), "create test bid window");

    // ---- as an agent
    const myAgents = await asUser("GET", "agents?select=email");
    check("agent sees only their own agent row",
      myAgents.ok && myAgents.data.length === 1 && myAgents.data[0].email === email, myAgents);
    const myShells = await asUser("POST", "rpc/my_shift_shells", {});
    check("agent sees their LOB's shift shells", myShells.ok && myShells.data.length === 1 && myShells.data[0].id === testShell.id, myShells);
    check("agent does not see the admin-only set name", myShells.ok && myShells.data.every(s => !("set_name" in s)), myShells.data);
    const directShells = await asUser("GET", "shift_shells?select=id,set_name");
    check("agent cannot read shift shells directly (so sets stay hidden)", directShells.ok && directShells.data.length === 0, directShells);
    const myAssignments = await asUser("GET", "assignments?select=id");
    check("agent sees no assignments", myAssignments.ok && myAssignments.data.length === 0, myAssignments);
    const agentShell = await asUser("POST", "shift_shells", shell("agent"));
    check("agent cannot add a shift shell", !agentShell.ok, agentShell);
    const agentRank = await asUser("PATCH", `agents?id=eq.${me.id}`, { rank: 1 });
    check("agent cannot change their rank", agentRank.ok && agentRank.data.length === 0, agentRank);
    const agentAccom = await asUser("PATCH", `agents?id=eq.${me.id}`, { accommodation: true });
    check("agent cannot approve their own accommodation", agentAccom.ok && agentAccom.data.length === 0, agentAccom);
    const agentTier = await asUser("PATCH", `agents?id=eq.${me.id}`, { accommodation_tier: 1 });
    check("agent cannot set their own accommodation tier", agentTier.ok && agentTier.data.length === 0, agentTier);

    const ownBid = await asUser("POST", "bids2", { agent_id: me.id, shift_id: testShell.id, priority: 1 });
    check("agent cannot write bids directly (only through the save function)", !ownBid.ok, ownBid);
    const otherBid = await asUser("POST", "bids2", { agent_id: other.id, shift_id: testShell.id, priority: 1 });
    check("agent cannot bid for someone else", !otherBid.ok, otherBid);
    const savedBids = await asUser("POST", "rpc/replace_my_bids", { p_bids: [{ shift_id: testShell.id, priority: 1 }] });
    const myBids = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    check("agent can save their choices while window is open", savedBids.ok && myBids.length === 1, savedBids);
    const submittedAt = async () => ((await svc("GET", `agents?select=bid_submitted_at&id=eq.${me.id}`)).data || [])[0]?.bid_submitted_at;
    const firstSubmitted = await submittedAt();
    check("saving a bid records when it was first submitted", !!firstSubmitted, firstSubmitted);
    const agentTime = await asUser("PATCH", `agents?id=eq.${me.id}`, { bid_submitted_at: "2020-01-01T00:00:00Z" });
    check("agent cannot change their own submission time", agentTime.ok && agentTime.data.length === 0, agentTime);
    // Full ranking: with require_full_ranking on (the default), every shell in the LOB must be ranked.
    const [shell2] = must(await svc("POST", "shift_shells", shell("second")), "create second test shell");
    const partial = await asUser("POST", "rpc/replace_my_bids", { p_bids: [{ shift_id: testShell.id, priority: 1 }] });
    check("full ranking required: partial ranking is rejected", !partial.ok, partial);
    const dupRank = await asUser("POST", "rpc/replace_my_bids", {
      p_bids: [{ shift_id: testShell.id, priority: 1 }, { shift_id: shell2.id, priority: 1 }] });
    check("the same rank number cannot be used twice", !dupRank.ok, dupRank);
    const dupShift = await asUser("POST", "rpc/replace_my_bids", {
      p_bids: [{ shift_id: testShell.id, priority: 1 }, { shift_id: testShell.id, priority: 2 }] });
    check("the same shift cannot be ranked twice", !dupShift.ok, dupShift);
    const full = await asUser("POST", "rpc/replace_my_bids", {
      p_bids: [{ shift_id: shell2.id, priority: 1 }, { shift_id: testShell.id, priority: 2 }] });
    const fullSaved = (await svc("GET", `bids2?select=shift_id,priority&agent_id=eq.${me.id}&order=priority`)).data || [];
    check("full ranking required: ranking every shell saves",
      full.ok && fullSaved.length === 2 && fullSaved[0].shift_id === shell2.id, { full, fullSaved });
    must(await svc("PATCH", `bid_windows?id=eq.${win.id}`, { require_full_ranking: false }), "turn off full ranking");
    const partialOk = await asUser("POST", "rpc/replace_my_bids", { p_bids: [{ shift_id: testShell.id, priority: 1 }] });
    check("full ranking off: partial ranking saves", partialOk.ok, partialOk);
    check("changing a bid keeps the first submission time", (await submittedAt()) === firstSubmitted, { firstSubmitted, now: await submittedAt() });
    const emptied = await asUser("POST", "rpc/replace_my_bids", { p_bids: [] });
    check("withdrawing every pick clears the submission time", emptied.ok && (await submittedAt()) === null, { emptied, now: await submittedAt() });
    must(await asUser("POST", "rpc/replace_my_bids", { p_bids: [{ shift_id: testShell.id, priority: 1 }] }), "save the test bid again");
    const resubmitted = await submittedAt();
    check("submitting again starts a new time", !!resubmitted && resubmitted > firstSubmitted, { firstSubmitted, resubmitted });
    const [foreignShell] = must(await svc("POST", "shift_shells", { ...shell("foreign"), lob: `${LOB}other` }), "create other-LOB shell");
    const foreign = await asUser("POST", "rpc/replace_my_bids", {
      p_bids: [{ shift_id: testShell.id, priority: 1 }, { shift_id: foreignShell.id, priority: 2 }] });
    check("agent cannot rank another LOB's shift", !foreign.ok, foreign);
    // Pick limit: at most 20 shells, and "use all picks" means 20 once the LOB has more than 20.
    const extra = must(await svc("POST", "shift_shells", Array.from({ length: 21 }, (_, i) => shell(`extra ${i}`))), "create 21 extra test shells");
    const lobShellIds = [testShell.id, shell2.id, ...extra.map(s => s.id)];   // 23 shells in the LOB
    const picks = n => ({ p_bids: lobShellIds.slice(0, n).map((shift_id, i) => ({ shift_id, priority: i + 1 })) });
    const tooMany = await asUser("POST", "rpc/replace_my_bids", picks(21));
    check("agent cannot pick more than 20 shells", !tooMany.ok, tooMany);
    must(await svc("PATCH", `bid_windows?id=eq.${win.id}`, { require_full_ranking: true }), "turn full ranking back on");
    const short = await asUser("POST", "rpc/replace_my_bids", picks(19));
    check("use all picks with 23 shells: 19 picks is rejected", !short.ok, short);
    const twenty = await asUser("POST", "rpc/replace_my_bids", picks(20));
    const twentySaved = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    check("use all picks with 23 shells: 20 picks saves", twenty.ok && twentySaved.length === 20, { twenty, saved: twentySaved.length });
    must(await svc("DELETE", `bids2?agent_id=eq.${me.id}&shift_id=neq.${testShell.id}`), "delete bids on extra test shells");
    must(await svc("DELETE", `shift_shells?id=in.(${extra.map(s => s.id).join(",")})`), "delete extra test shells");
    must(await svc("DELETE", `shift_shells?id=in.(${shell2.id},${foreignShell.id})`), "delete extra test shells");

    must(await svc("PATCH", `agents?id=eq.${me.id}`, { excluded: true }), "remove test agent from bidding");
    const removedShells = await asUser("POST", "rpc/my_shift_shells", {});
    check("removed agent sees no shift shells", removedShells.ok && removedShells.data.length === 0, removedShells);
    const removedSave = await asUser("POST", "rpc/replace_my_bids", { p_bids: [{ shift_id: testShell.id, priority: 1 }] });
    check("removed agent cannot save choices", !removedSave.ok, removedSave);
    const removedBid = await asUser("POST", "bids2", { agent_id: me.id, shift_id: testShell.id, priority: 3 });
    check("removed agent cannot add a bid", !removedBid.ok, removedBid);
    const selfRestore = await asUser("PATCH", `agents?id=eq.${me.id}`, { excluded: false });
    check("removed agent cannot restore themselves", selfRestore.ok && selfRestore.data.length === 0, selfRestore);
    must(await svc("PATCH", `agents?id=eq.${me.id}`, { excluded: false }), "restore test agent");

    const agentAssign = await asUser("POST", "rpc/replace_assignments", { p_agent_ids: [me.id], p_rows: [] });
    check("agent cannot run auto assign", !agentAssign.ok, agentAssign);
    const agentWindow = await asUser("POST", "rpc/replace_bid_window", {
      p_lob: LOB, p_opens: new Date().toISOString(), p_closes: new Date(Date.now() + hour).toISOString(),
    });
    check("agent cannot change the bid window", !agentWindow.ok, agentWindow);
    const agentCancel = await asUser("DELETE", `bid_windows?lob=eq.${LOB}`);
    const windowStill = (await svc("GET", `bid_windows?select=id&lob=eq.${LOB}`)).data || [];
    check("agent cannot cancel the bid window", agentCancel.ok && agentCancel.data.length === 0 && windowStill.length === 1, agentCancel);
    const agentClose = await asUser("PATCH", `bid_windows?lob=eq.${LOB}`, { closes_at: new Date().toISOString() });
    check("agent cannot close the bid window early", agentClose.ok && agentClose.data.length === 0, agentClose);

    must(await svc("PATCH", `bid_windows?id=eq.${win.id}`, {
      opens_at: new Date(Date.now() - 2 * hour).toISOString(), closes_at: new Date(Date.now() - hour).toISOString(),
    }), "close test bid window");
    const lateBid = await asUser("POST", "bids2", { agent_id: me.id, shift_id: testShell.id, priority: 2 });
    check("agent cannot bid after window closes", !lateBid.ok, lateBid);
    const lateDelete = await asUser("DELETE", `bids2?agent_id=eq.${me.id}`);
    check("agent cannot remove bids after window closes", lateDelete.ok && lateDelete.data.length === 0, lateDelete);
    const lateSave = await asUser("POST", "rpc/replace_my_bids", { p_bids: [] });
    const bidsAfterLateSave = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    check("agent cannot save choices after window closes", !lateSave.ok && bidsAfterLateSave.length === 1, lateSave);

    // ---- as an admin
    must(await svc("POST", "admins", { email }), "make temp user an admin");
    const adminAgents = await asUser("GET", `agents?select=id&lob=eq.${LOB}`);
    check("admin sees all agents", adminAgents.ok && adminAgents.data.length === 2, adminAgents);
    const adminShell = await asUser("POST", "shift_shells", shell("admin"));
    check("admin can add a shift shell", adminShell.ok && adminShell.data.length === 1, adminShell);
    const adminRank = await asUser("PATCH", `agents?id=eq.${other.id}`, { rank: 5 });
    check("admin can change ranks", adminRank.ok && adminRank.data.length === 1, adminRank);
    const adminRemove = await asUser("PATCH", `agents?id=in.(${other.id})`, { excluded: true });
    const adminRestore = await asUser("PATCH", `agents?id=in.(${other.id})`, { excluded: false });
    check("admin can bulk remove and restore people",
      adminRemove.ok && adminRemove.data.length === 1 && adminRestore.ok && adminRestore.data.length === 1, { adminRemove, adminRestore });
    const adminAccom = await asUser("PATCH", `agents?id=in.(${other.id})`, { accommodation: true });
    const adminAccomOff = await asUser("PATCH", `agents?id=in.(${other.id})`, { accommodation: false });
    const adminTier = await asUser("PATCH", `agents?id=in.(${other.id})`, { accommodation: true, accommodation_tier: 2 });
    const badTier = await asUser("PATCH", `agents?id=in.(${other.id})`, { accommodation_tier: 4 });
    check("admin can set an accommodation tier, and only 1 to 3", adminTier.ok && adminTier.data[0]?.accommodation_tier === 2 && !badTier.ok, { adminTier, badTier });
    check("admin can approve and clear accommodation",
      adminAccom.ok && adminAccom.data[0]?.accommodation === true && adminAccomOff.ok && adminAccomOff.data[0]?.accommodation === false, { adminAccom, adminAccomOff });

    // Rank import saves a whole LOB in one upsert keyed by email (same as the Agents tab).
    const rankUpsert = await call("POST", `${SUPABASE_URL}/rest/v1/agents?on_conflict=email`, SUPABASE_ANON_KEY, userToken,
      [{ email, rank: 1 }, { email: otherEmail, rank: null }], "resolution=merge-duplicates,return=representation");
    const afterRanks = (await svc("GET", `agents?select=email,name,lob,rank&lob=eq.${LOB}&order=email`)).data || [];
    const mine = afterRanks.find(a => a.email === email), theirs = afterRanks.find(a => a.email === otherEmail);
    check("admin rank import updates only ranks and adds no one",
      rankUpsert.ok && afterRanks.length === 2 && mine?.rank === 1 && theirs?.rank === null &&
      mine?.name === "RLS Test" && mine?.lob === LOB, { rankUpsert, afterRanks });
    const adminAssign = await asUser("POST", "assignments", { agent_id: other.id, shift_id: testShell.id });
    check("admin can save assignments", adminAssign.ok && adminAssign.data.length === 1, adminAssign);

    const assignmentsFor = async () =>
      (await svc("GET", `assignments?select=agent_id&agent_id=in.(${me.id},${other.id})`)).data || [];
    const replaced = await asUser("POST", "rpc/replace_assignments", {
      p_agent_ids: [me.id, other.id], p_rows: [{ agent_id: me.id, shift_id: testShell.id }],
    });
    const afterReplace = await assignmentsFor();
    check("admin auto assign replaces previous results",
      replaced.ok && afterReplace.length === 1 && afterReplace[0].agent_id === me.id, { replaced, afterReplace });
    const broken = await asUser("POST", "rpc/replace_assignments", {
      p_agent_ids: [me.id, other.id], p_rows: [{ agent_id: other.id, shift_id: -1 }],
    });
    const afterBroken = await assignmentsFor();
    check("failed auto assign keeps the previous results",
      !broken.ok && afterBroken.length === 1 && afterBroken[0].agent_id === me.id, { broken, afterBroken });

    const adminWindow = await asUser("POST", "rpc/replace_bid_window", {
      p_lob: LOB, p_opens: new Date().toISOString(), p_closes: new Date(Date.now() + hour).toISOString(),
    });
    const windows = (await svc("GET", `bid_windows?select=id&lob=eq.${LOB}`)).data || [];
    check("admin can replace the bid window", adminWindow.ok && windows.length === 1, adminWindow);
    const optionalWindow = await asUser("POST", "rpc/replace_bid_window", {
      p_lob: LOB, p_opens: new Date().toISOString(), p_closes: new Date(Date.now() + hour).toISOString(), p_require_full_ranking: false,
    });
    const savedSetting = ((await svc("GET", `bid_windows?select=require_full_ranking&lob=eq.${LOB}`)).data || [])[0];
    check("admin can turn off 'rank every shift' for an LOB",
      optionalWindow.ok && savedSetting && savedSetting.require_full_ranking === false, { optionalWindow, savedSetting });
    const badWindow = await asUser("POST", "rpc/replace_bid_window", {
      p_lob: LOB, p_opens: new Date().toISOString(), p_closes: new Date(Date.now() - hour).toISOString(),
    });
    check("bid window must close after it opens", !badWindow.ok, badWindow);

    // Close bidding now (Bid window tab): move an open window's close time to now, keeping rankings.
    const openBefore = await asUser("POST", "rpc/my_bidding_open", {});
    const bidsBeforeClose = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    const closedEarly = await asUser("PATCH", `bid_windows?lob=eq.${LOB}`, { closes_at: new Date(Date.now() - 1000).toISOString() });
    const openAfter = await asUser("POST", "rpc/my_bidding_open", {});
    const bidsAfterClose = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    const closedSave = await asUser("POST", "rpc/replace_my_bids", { p_bids: [{ shift_id: testShell.id, priority: 1 }] });
    check("admin can close bidding early: window was open, now closed and saves are refused",
      openBefore.data === true && closedEarly.ok && closedEarly.data.length === 1 && openAfter.data === false && !closedSave.ok,
      { openBefore, closedEarly, openAfter, closedSave });
    check("closing early keeps saved rankings", bidsAfterClose.length === bidsBeforeClose.length && bidsBeforeClose.length > 0,
      { before: bidsBeforeClose.length, after: bidsAfterClose.length });

    // Cancelling a window (Bid window tab): delete it, and optionally the LOB's saved rankings.
    const bidsBefore = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    const cancelled = await asUser("DELETE", `bid_windows?lob=eq.${LOB}`);
    const windowsAfter = (await svc("GET", `bid_windows?select=id&lob=eq.${LOB}`)).data || [];
    const bidsKept = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    check("admin can cancel a bid window, keeping saved rankings",
      cancelled.ok && cancelled.data.length === 1 && windowsAfter.length === 0 && bidsBefore.length > 0 && bidsKept.length === bidsBefore.length,
      { cancelled, windowsAfter, bidsBefore: bidsBefore.length, bidsKept: bidsKept.length });
    const cleared = await asUser("DELETE", `bids2?agent_id=in.(${me.id},${other.id})`);
    const bidsGone = (await svc("GET", `bids2?select=id&agent_id=eq.${me.id}`)).data || [];
    check("admin can also clear the LOB's saved rankings", cleared.ok && bidsGone.length === 0, cleared);
  } catch (err) {
    failures++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    // ---- clean up everything this script created
    const agents = (await svc("GET", `agents?select=id&lob=eq.${LOB}`)).data || [];
    if (agents.length) {
      const ids = agents.map(a => a.id).join(",");
      await svc("DELETE", `assignments?agent_id=in.(${ids})`);
      await svc("DELETE", `bids2?agent_id=in.(${ids})`);
    }
    await svc("DELETE", `bid_windows?lob=eq.${LOB}`);
    await svc("DELETE", `shift_shells?lob=in.(${LOB},${LOB}other)`);
    await svc("DELETE", `agents?lob=eq.${LOB}`);
    await svc("DELETE", `admins?email=eq.${encodeURIComponent(email)}`);
    if (userId) {
      await call("DELETE", `${SUPABASE_URL}/auth/v1/admin/users/${userId}`, SUPABASE_SERVICE_KEY, SUPABASE_SERVICE_KEY);
    }
    const leftover = (await svc("GET", `shift_shells?select=id&lob=eq.${LOB}`)).data || [];
    console.log(leftover.length ? `WARNING: ${leftover.length} test shift shells were not cleaned up` : "Cleanup done.");
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
