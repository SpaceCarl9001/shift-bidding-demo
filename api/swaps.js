// Admin only: review day swaps that both agents have agreed to.
// Required env vars: ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)
//
// Body: { action: "preview" | "approve" | "reject", id, date?, note? }
//   preview: shows what would be removed from and added to each agent's days in Assembled.
//   approve: makes the change in Assembled and marks the swap approved.
//   reject:  marks the swap rejected. Nothing changes in Assembled.
// Rest-day swaps (give_date/take_date): each agent's own working day moves onto their day off in
// the same week, as Shift Swap with breaks and lunch kept, so daily and weekly hours stay the same.
// Older one-day swaps (no give_date): each agent gets a copy of the other's day; `date` can change it.

const { isAdminEmail, hasPermission } = require("../lib/admins");
const { planDaySwap, planRestDaySwap } = require("../lib/schedule");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!ASSEMBLED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }
  const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };

  // ---- auth ----------------------------------------------------------
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not signed in" });
  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!userResp.ok) return res.status(401).json({ error: "Invalid session" });
  const me = await userResp.json();
  if (!(await isAdminEmail(me.email))) return res.status(403).json({ error: "Admins only" });

  // ---- input and the swap -------------------------------------------
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { action, id, note } = body || {};
  if (["approve", "reject"].includes(action) && !(await hasPermission(me.email, "swaps"))) {
    return res.status(403).json({ error: "You do not have permission to approve or reject swaps. You can still preview them." });
  }
  if (!["preview", "approve", "reject"].includes(action) || !Number.isInteger(Number(id))) {
    return res.status(400).json({ error: "Need an action (preview, approve or reject) and a swap id." });
  }

  async function sb(method, path, payload) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method, headers: { ...sbHeaders, Prefer: "return=representation" }, body: payload ? JSON.stringify(payload) : undefined,
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  const agentCols = "id,name,lob,assembled_agent_id,excluded";
  const shellCols = "id,days,start_local,end_local,timezone,schedule";
  let swap;
  try {
    [swap] = await sb("GET",
      `swap_requests?id=eq.${Number(id)}&select=*,` +
      `requester:agents!swap_requests_requester_id_fkey(${agentCols}),partner:agents!swap_requests_partner_id_fkey(${agentCols}),` +
      `requester_shift:shift_shells!swap_requests_requester_shift_id_fkey(${shellCols}),` +
      `partner_shift:shift_shells!swap_requests_partner_shift_id_fkey(${shellCols})`);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
  if (!swap) return res.status(404).json({ error: "Swap not found." });
  if (swap.status !== "pending_admin") {
    return res.status(409).json({ error: `This swap is not waiting for approval any more (it is ${swap.status.replace("_", " ")}).` });
  }
  const decided = { decided_at: new Date().toISOString(), decided_by: me.email, admin_note: (note || "").trim() || null };

  if (action === "reject") {
    await sb("PATCH", `swap_requests?id=eq.${swap.id}&status=eq.pending_admin`, { status: "rejected", ...decided });
    return res.status(200).json({ ok: true, status: "rejected" });
  }

  // ---- the date and checks -------------------------------------------
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  const restDay = !!swap.give_date;
  const date = restDay ? swap.give_date : body.date || body.startDate || swap.start_date;
  if (!isDate(date)) return res.status(400).json({ error: "Pick the day to swap." });
  const days = restDay ? [swap.give_date, swap.take_date] : [date];
  const firstDay = [...days].sort()[0], lastDay = [...days].sort().pop();

  const A = swap.requester, B = swap.partner;
  if (!swap.requester_shift || !swap.partner_shift) return res.status(409).json({ error: "One of the shifts in this swap has been deleted." });
  if (A.excluded || B.excluded) return res.status(409).json({ error: `${A.excluded ? A.name : B.name} has been removed from bidding.` });
  for (const p of [A, B]) {
    if (!p.assembled_agent_id) return res.status(409).json({ error: `${p.name} has no Assembled agent id. Run the sync on the Agents tab.` });
  }
  // A day swap changes real events in Assembled, so both agents' new schedules must be pushed first.
  // (Before the push, agents trade shifts instead; see shift-trades.sql.)
  const pushedRows = await sb("GET", `assignments?select=agent_id,pushed_at&agent_id=in.(${A.id},${B.id})`);
  const notPushed = [A, B].filter(p => !pushedRows.some(r => r.agent_id === p.id && r.pushed_at));
  if (notPushed.length) {
    return res.status(409).json({ error: `${notPushed.map(p => p.name).join(" and ")} ${notPushed.length === 1 ? "is" : "are"} not in Assembled yet. Push the schedule first, then approve day swaps.` });
  }
  const others = (await sb("GET",
    `swap_requests?select=id,give_date,take_date,start_date,end_date&id=neq.${swap.id}&status=in.(pending_partner,pending_admin,approved)` +
    `&or=(requester_id.in.(${A.id},${B.id}),partner_id.in.(${A.id},${B.id}))&start_date=lte.${lastDay}&end_date=gte.${firstDay}`))
    .filter(o => o.give_date ? days.includes(o.give_date) || days.includes(o.take_date) : days.some(d => d >= o.start_date && d <= o.end_date));
  if (others.length) {
    return res.status(409).json({ error: `${A.name} or ${B.name} already has another swap on ${days.join(" or ")}.` });
  }

  // ---- what is in Assembled -----------------------------------------
  const aHeaders = { Authorization: "Basic " + Buffer.from(ASSEMBLED_API_KEY + ":").toString("base64"), "Content-Type": "application/json" };
  const from = Math.floor(Date.parse(`${firstDay}T00:00:00Z`) / 1000) - 2 * 86400;
  const to = Math.floor(Date.parse(`${lastDay}T00:00:00Z`) / 1000) + 3 * 86400;
  async function agentActivities(agentId) {
    const r = await fetch(`https://api.assembledhq.com/v0/activities?start_time=${from}&end_time=${to}&agents=${encodeURIComponent(agentId)}`, { headers: aHeaders });
    if (!r.ok) throw new Error(`Assembled activities (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const found = (await r.json()).activities || {};
    return (Array.isArray(found) ? found : Object.values(found)).filter(a => a.agent_id === agentId);
  }
  let activitiesA, activitiesB, types = [];
  try {
    [activitiesA, activitiesB] = await Promise.all([agentActivities(A.assembled_agent_id), agentActivities(B.assembled_agent_id)]);
    const tr = await fetch("https://api.assembledhq.com/v0/activity_types", { headers: aHeaders });
    if (!tr.ok) throw new Error(`Assembled activity types (${tr.status})`);
    const inner = (await tr.json()).activity_types || {};
    types = Array.isArray(inner) ? inner : Object.values(inner);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
  const typeName = Object.fromEntries(types.map(t => [t.id, t.name]));
  const swapType = types.find(t => !t.deleted && /^shift swap$/i.test(String(t.name || "").trim()));
  if (!swapType) return res.status(409).json({ error: 'Assembled has no "Shift Swap" activity type. Create one in Assembled first.' });
  // Breaks and lunch are copied as they are; everything else in the day becomes Shift Swap.
  const keepType = id => /break|lunch/i.test(typeName[id] || "");

  const common = { shellA: swap.requester_shift, shellB: swap.partner_shift, activitiesA, activitiesB,
    nameA: A.name, nameB: B.name, swapTypeId: swapType.id, keepType };
  const plan = restDay ? planRestDaySwap({ giveDate: swap.give_date, takeDate: swap.take_date, ...common }) : planDaySwap({ date, ...common });
  const events = list => list.map(a => ({ start: a.start_time, end: a.end_time, type: typeName[a.type_id] || "Unknown type" }));
  const summary = {
    date, restDay, giveDate: swap.give_date, takeDate: swap.take_date,
    requester: { name: A.name, timezone: swap.requester_shift.timezone },
    partner: { name: B.name, timezone: swap.partner_shift.timezone },
    // For a rest-day swap: A's day on giveDate is removed and A works takeDate; B the other way round.
    a: { removed: events(plan.blockA), added: events(plan.toA), removedDate: restDay ? swap.give_date : date, addedDate: restDay ? swap.take_date : date },
    b: { removed: events(plan.blockB), added: events(plan.toB), removedDate: restDay ? swap.take_date : date, addedDate: restDay ? swap.give_date : date },
    issues: plan.issues,
  };
  if (action === "preview") return res.status(200).json({ preview: true, ...summary });

  // ---- approve --------------------------------------------------------
  if (plan.issues.length) return res.status(409).json({ error: "This swap has issues to sort out first.", ...summary });

  const asmId = { A: A.assembled_agent_id, B: B.assembled_agent_id };
  const create = (a, agentId) => ({ action: "create", activity: { agent_id: agentId, type_id: a.type_id, start_time: a.start_time, end_time: a.end_time } });
  async function createAll(list) {
    for (let i = 0; i < list.length; i += 200) {
      const r = await fetch("https://api.assembledhq.com/v0/activities/bulk", {
        method: "POST", headers: aHeaders, body: JSON.stringify({ activities: list.slice(i, i + 200) }),
      });
      if (!r.ok) throw new Error(`Assembled create failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    }
  }
  const originals = who => (who === "A" ? plan.blockA : plan.blockB).map(a => create(a, asmId[who]));

  // 1. Remove both agents' working days. Assembled can only delete by agent and time range, and
  //    each day's range contains exactly that day's events.
  const deleted = [];
  try {
    for (const w of plan.deletes) {
      const r = await fetch("https://api.assembledhq.com/v0/activities", {
        method: "DELETE", headers: aHeaders,
        body: JSON.stringify({ start_time: w.start, end_time: w.end, agent_ids: [asmId[w.who]] }),
      });
      if (!r.ok) throw new Error(`Assembled delete failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
      deleted.push(w.who);
    }
  } catch (err) {
    // Put back whatever was already removed, so neither agent is left without a schedule.
    let restored = true;
    try { await createAll(deleted.flatMap(originals)); } catch { restored = false; }
    return res.status(502).json({
      error: `${err.message}. ${restored ? "Nothing was changed: the schedules were put back." : `Some of ${A.name}'s and ${B.name}'s events could not be put back; check their schedules in Assembled for ${days.join(" and ")}.`}`,
    });
  }

  // 2. Give each agent the other's day: Shift Swap for the work, breaks and lunch as they were.
  try {
    await createAll([...plan.toA.map(a => create(a, asmId.A)), ...plan.toB.map(a => create(a, asmId.B))]);
  } catch (err) {
    let restored = true;
    try { await createAll([...originals("A"), ...originals("B")]); } catch { restored = false; }
    return res.status(502).json({
      error: `${err.message}. ${restored
        ? `The original schedules were put back, but check ${A.name} and ${B.name} in Assembled for ${days.join(" and ")} in case some Shift Swap events were also created.`
        : `Check ${A.name}'s and ${B.name}'s schedules in Assembled for ${days.join(" and ")}: the swap only partly went through.`}`,
    });
  }

  await sb("PATCH", `swap_requests?id=eq.${swap.id}&status=eq.pending_admin`, {
    status: "approved", ...(restDay ? {} : { start_date: date, end_date: date }), ...decided,
    result: { removed: plan.blockA.length + plan.blockB.length, added: plan.toA.length + plan.toB.length, toRequester: plan.toA.length, toPartner: plan.toB.length },
  });
  return res.status(200).json({ ok: true, status: "approved", ...summary });
};
