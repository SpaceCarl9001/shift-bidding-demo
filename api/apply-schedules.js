// Pushes assigned shifts into Assembled as scheduled activities.
// Required env vars: ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (admins: the admins table and/or ADMIN_EMAILS)
//
// Body: { lob: "Support", startDate: "2026-10-05", endDate: "2026-10-11",
//         typeId: "<activity type uuid>", dryRun: true|false,
//         transition: { limits: { 4: 5, 5: 6 } },  (optional: transition week for a new schedule, see below)
//         agentIds: [12, 34] }          (optional: only these agents; everyone else is left alone)

const { isAdminEmail, hasPermission } = require("../lib/admins");
const { assembledClient } = require("../lib/assembled");
const { eachDate, shellWindow, localDate, workedDates, streakBefore, planTransitionWeek } = require("../lib/schedule");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { ASSEMBLED_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!ASSEMBLED_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Server is missing environment variables. Check Vercel settings." });
  }

  // ---- auth ----------------------------------------------------------
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

  // ---- input ---------------------------------------------------------
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { lob, startDate, endDate, typeId, dryRun } = body || {};
  // Any admin can preview; pushing real events needs the "push" permission.
  if (!dryRun && !(await hasPermission(user.email, "push"))) {
    return res.status(403).json({ error: "You do not have permission to push schedules to Assembled. You can still preview." });
  }
  if (!lob || !startDate || !endDate || !typeId) {
    return res.status(400).json({ error: "Need lob, startDate, endDate and typeId." });
  }
  // Transition week: most days in a row, by how many days a week the agent's schedule has
  // (for example 4-day schedules at most 5, 5-day schedules at most 6). Others: days + 1.
  const transition = body.transition ? { limits: {} } : null;
  if (transition) {
    for (const [days, most] of Object.entries(body.transition.limits || {})) {
      const n = Number(most);
      if (!Number.isInteger(n) || n < 1 || n > 13) {
        return res.status(400).json({ error: "Days in a row must be a whole number from 1 to 13." });
      }
      transition.limits[Number(days)] = n;
    }
    const start = new Date(`${startDate}T00:00:00Z`), sunday = new Date(start);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    if (start.getUTCDay() !== 1) {
      return res.status(400).json({ error: "With the transition week on, the From date must be a Monday (the first day of the new work week)." });
    }
    if (endDate < sunday.toISOString().slice(0, 10)) {
      return res.status(400).json({ error: "With the transition week on, push at least the whole first week: To must be the Sunday after From or later." });
    }
  }
  const maxRunFor = shell => {
    const days = String(shell.days || "").split(",").filter(s => s.trim() !== "").length;
    return transition.limits[days] || Math.min(13, days + 1);
  };
  // Optional: only these agents (app agent ids). Everyone else in the LOB is left alone.
  let onlyAgents = null;
  if (body.agentIds != null) {
    if (!Array.isArray(body.agentIds) || !body.agentIds.length || !body.agentIds.every(id => Number.isInteger(Number(id)))) {
      return res.status(400).json({ error: "Pick at least one agent to update." });
    }
    onlyAgents = new Set(body.agentIds.map(Number));
  }
  if (new Date(startDate) > new Date(endDate)) {
    return res.status(400).json({ error: "End date must be on or after start date." });
  }

  // All Assembled requests go through one paced client, so a big push stays under the rate limit.
  const assembled = assembledClient(ASSEMBLED_API_KEY);
  const asm = (path, options) => assembled.call(`https://api.assembledhq.com${path}`, options);

  // ---- load data from Supabase ---------------------------------------
  async function sbGet(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase ${path}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  let assignments;
  try {
    assignments = await sbGet(
      "assignments?select=id,agent_id,shift_id," +
      "agents(id,name,email,lob,assembled_agent_id,excluded)," +
      "shift_shells(id,schedule,days,start_local,end_local,timezone)"
    );
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }

  const rows = (assignments || []).filter(a => a.agents && a.shift_shells && a.agents.lob === lob && !a.agents.excluded
    && (!onlyAgents || onlyAgents.has(a.agent_id)));
  if (!rows.length) {
    return res.status(200).json({ error: onlyAgents
      ? `None of the selected agents have a saved ${lob} assignment. Run auto-assign first, or pick again.`
      : `No saved assignments found for ${lob}. Run auto-assign first.` });
  }

  // Approved day swaps. Approving one already wrote those days to Assembled (as Shift Swap), so the
  // push leaves those agent-days alone; the transition week counts whether they work each day.
  //   Rest-day swaps: the requester is off on give_date and works take_date; the partner the reverse.
  //   Older one-day swaps: each agent works the other's shell on those dates.
  // (If the swaps table does not exist yet, there are simply no swaps.)
  const swapDays = {};   // agent id -> Map(date -> works that day?)
  const setDay = (agentId, date, works) => (swapDays[agentId] ||= new Map()).set(date, works);
  try {
    const swaps = await sbGet(
      `swap_requests?select=requester_id,partner_id,start_date,end_date,give_date,take_date,` +
      `requester_shift:shift_shells!swap_requests_requester_shift_id_fkey(id,days,start_local,end_local,timezone),` +
      `partner_shift:shift_shells!swap_requests_partner_shift_id_fkey(id,days,start_local,end_local,timezone)` +
      `&status=eq.approved&lob=eq.${encodeURIComponent(lob)}&start_date=lte.${endDate}&end_date=gte.${startDate}`
    );
    for (const s of swaps) {
      if (s.give_date) {
        setDay(s.requester_id, s.give_date, false); setDay(s.requester_id, s.take_date, true);
        setDay(s.partner_id, s.give_date, true); setDay(s.partner_id, s.take_date, false);
      } else {
        for (const date of eachDate(s.start_date, s.end_date)) {
          setDay(s.requester_id, date, !!shellWindow(s.partner_shift, date));
          setDay(s.partner_id, date, !!shellWindow(s.requester_shift, date));
        }
      }
    }
  } catch { /* no swaps */ }
  const daySwapped = (agentId, date) => !!swapDays[agentId] && swapDays[agentId].has(date);
  const worksOn = (agentId, date, own) => daySwapped(agentId, date) ? swapDays[agentId].get(date) : !!shellWindow(own, date);
  let swapDaysSkipped = 0;

  // ---- transition week --------------------------------------------------
  // For the first push of a new schedule: count the days each agent is already working in
  // Assembled right before startDate (a Monday), then plan that first Monday-to-Sunday week so
  // they keep every shift but never work more than their limit in a row. A shift that would
  // break the limit moves to one of their days off that week, at the same hours. From the
  // second week on, the new schedule applies as it is.
  const transitionOut = {};          // agent id -> Set of dates whose shift moves away
  const transitionAdd = {};          // agent id -> [{ date, from }] shifts moved onto a day off
  const transitionMoves = [];        // { name, from, to, inARow, limit } for the admin
  const transitionShort = [];        // { name, date, inARow, limit }: no day off could take it
  const transitionCovered = [];      // { name, date, pto }: a PTO day that week counts for this shift
  // ---- what each agent already has in Assembled ------------------------
  // One look per agent covers everything the push needs: the 15 days before startDate (for the
  // transition week) and the push dates themselves (to skip shifts already there, and days where
  // the agent already has something). Assembled allows at most 62 days per query.
  const pushable = rows.filter(r => r.agents.assembled_agent_id && r.shift_shells.timezone);
  const dayStart = date => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  const lookFrom = dayStart(startDate) - (transition ? 15 : 1) * 86400, lookTo = dayStart(endDate) + 2 * 86400;
  const MAX_SPAN = 62 * 86400;
  const existingByAgent = {}, typeName = {}, timeOff = new Set();
  try {
    const tr = await asm("/v0/activity_types");
    if (!tr.ok) throw new Error(`activity types (${tr.status})`);
    const inner = (await tr.json()).activity_types || {};
    for (const t of Array.isArray(inner) ? inner : Object.values(inner)) { typeName[t.id] = t.name; if (t.timeoff) timeOff.add(t.id); }
    await Promise.all([...new Set(pushable.map(r => r.agents.assembled_agent_id))].map(async asmId => {
      const list = [];
      for (let from = lookFrom; from < lookTo; from += MAX_SPAN) {
        const r = await asm(`/v0/activities?start_time=${from}&end_time=${Math.min(from + MAX_SPAN, lookTo)}&agents=${encodeURIComponent(asmId)}`);
        if (!r.ok) throw new Error(`(${r.status}): ${(await r.text()).slice(0, 200)}`);
        const found = (await r.json()).activities || {};
        list.push(...(Array.isArray(found) ? found : Object.values(found)).filter(a => a.agent_id === asmId));
      }
      existingByAgent[asmId] = list;
    }));
  } catch (err) {
    return res.status(502).json({ error: `Could not check Assembled for existing schedules ${err.message}` });
  }

  if (transition) {
    for (const row of pushable) {
      const asmId = row.agents.assembled_agent_id, tz = row.shift_shells.timezone;
      const mine = existingByAgent[asmId] || [];
      // Time off counts as a working day, both just before the new schedule and in its first week.
      const worked = workedDates(mine, tz, () => false);
      const ptoDays = new Set(mine.filter(a => timeOff.has(a.type_id)).map(a => localDate(a.start_time, tz)));
      const busyDays = new Set(mine.filter(a => !timeOff.has(a.type_id)).map(a => localDate(a.start_time, tz)));
      const limit = maxRunFor(row.shift_shells);
      const plan = planTransitionWeek({
        weekStart: startDate, maxRun: limit, priorStreak: streakBefore(worked, startDate),
        works: date => worksOn(row.agent_id, date, row.shift_shells),
        timeOff: date => ptoDays.has(date), busy: date => busyDays.has(date),
      });
      if (plan.moves.length || plan.dropped.length || plan.covered.length) {
        transitionOut[row.agent_id] = new Set([...plan.moves.map(m => m.from), ...plan.dropped, ...plan.covered.map(c => c.date)]);
        transitionAdd[row.agent_id] = plan.moves.map(m => ({ date: m.to, from: m.from }));
        const inARow = plan.firstBreak.inARow;
        for (const m of plan.moves) transitionMoves.push({ name: row.agents.name, from: m.from, to: m.to, inARow, limit });
        for (const c of plan.covered) transitionCovered.push({ name: row.agents.name, date: c.date, pto: c.by });
        for (const date of plan.dropped) transitionShort.push({ name: row.agents.name, date, inARow, limit });
      }
    }
    transitionMoves.sort((a, b) => a.from.localeCompare(b.from) || a.name.localeCompare(b.name));
    transitionShort.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    transitionCovered.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  }

  // ---- build the activity list ---------------------------------------
  const activities = [];
  const skipped = [];
  const rowIdsWithShifts = new Set();

  for (const row of rows) {
    const agent = row.agents;
    const shell = row.shift_shells;

    if (!agent.assembled_agent_id) {
      skipped.push(`${agent.name}: no Assembled agent id, re-run the sync`);
      continue;
    }
    if (!shell.days || !shell.start_local || !shell.end_local || !shell.timezone) {
      skipped.push(`${agent.name}: shift shell is missing day or time details`);
      continue;
    }

    for (const date of eachDate(startDate, endDate)) {
      if (transitionOut[row.agent_id] && transitionOut[row.agent_id].has(date)) continue;
      if (daySwapped(row.agent_id, date)) { swapDaysSkipped++; continue; }
      const win = shellWindow(shell, date);
      if (!win) continue;
      activities.push({
        action: "create",
        activity: {
          agent_id: agent.assembled_agent_id,
          type_id: typeId,
          start_time: win.start,
          end_time: win.end,
        },
      });
      rowIdsWithShifts.add(row.id);
    }
    // Transition week: the moved shifts, on the agent's day off, at the hours of the day they left.
    for (const add of transitionAdd[row.agent_id] || []) {
      if (add.date < startDate || add.date > endDate || daySwapped(row.agent_id, add.date)) continue;
      const win = shellWindow({ ...shell, days: "0,1,2,3,4,5,6" }, add.date);
      if (!win) continue;
      activities.push({
        action: "create",
        activity: { agent_id: agent.assembled_agent_id, type_id: typeId, start_time: win.start, end_time: win.end },
      });
      rowIdsWithShifts.add(row.id);
    }
  }

  if (!activities.length) {
    return res.status(200).json({ created: 0, skipped, transitionMoves, transitionShort, transitionCovered, swapDaysSkipped, note: "No shifts fell inside that date range." });
  }

  // ---- skip shifts already there, and days where the agent has something -----
  // A shift that is already there (same agent, type, start and end) was pushed before and is
  // skipped. A shift that would overlap anything else the agent has (time off, training, a change
  // made by hand, or an old schedule not deleted yet) is skipped too, and listed, so the push
  // never stacks a shift on top of what is already there.
  const activityKey = a => `${a.agent_id}|${a.start_time}|${a.end_time}`;

  const nameOf = Object.fromEntries(rows.map(r => [r.agents.assembled_agent_id, r.agents.name]));
  const tzOf = Object.fromEntries(rows.map(r => [r.agents.assembled_agent_id, r.shift_shells.timezone]));
  const toCreate = [], conflicts = [];
  let alreadyInAssembled = 0;
  for (const a of activities) {
    const mine = existingByAgent[a.activity.agent_id] || [];
    if (mine.some(x => x.type_id === typeId && activityKey(x) === activityKey(a.activity))) { alreadyInAssembled++; continue; }
    const overlap = mine.filter(x => x.start_time < a.activity.end_time && x.end_time > a.activity.start_time);
    if (overlap.length) {
      conflicts.push({
        name: nameOf[a.activity.agent_id] || a.activity.agent_id,
        date: localDate(a.activity.start_time, tzOf[a.activity.agent_id] || "America/New_York"),
        found: [...new Set(overlap.map(x => typeName[x.type_id] || "Another event"))].join(", "),
      });
      continue;
    }
    toCreate.push(a);
  }
  conflicts.sort((x, y) => x.date.localeCompare(y.date) || String(x.name).localeCompare(String(y.name)));

  if (dryRun) {
    const preview = toCreate.slice(0, 5).map(a => ({
      agent_id: a.activity.agent_id,
      name: nameOf[a.activity.agent_id],
      start: new Date(a.activity.start_time * 1000).toISOString(),
      end: new Date(a.activity.end_time * 1000).toISOString(),
    }));
    return res.status(200).json({ dryRun: true, wouldCreate: toCreate.length, alreadyInAssembled, conflicts, preview, skipped, transitionMoves, transitionShort, transitionCovered, swapDaysSkipped });
  }

  // ---- push to Assembled in batches ----------------------------------
  let created = 0;
  const errors = [];
  const BATCH = 200;

  for (let i = 0; i < toCreate.length; i += BATCH) {
    const chunk = toCreate.slice(i, i + BATCH);
    const r = await asm("/v0/activities/bulk", { method: "POST", body: JSON.stringify({ activities: chunk }) });
    if (!r.ok) {
      errors.push(`Batch ${Math.floor(i / BATCH) + 1} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    } else {
      created += chunk.length;
    }
    if (i + BATCH < toCreate.length) await new Promise(s => setTimeout(s, 400));
  }

  // ---- mark as pushed --------------------------------------------------
  // Only rows that produced shifts, and only once every shift is in Assembled.
  if (!errors.length && rowIdsWithShifts.size) {
    const ids = [...rowIdsWithShifts];
    await fetch(`${SUPABASE_URL}/rest/v1/assignments?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ pushed_at: new Date().toISOString(), push_error: null }),
    });
  }

  const note = toCreate.length ? undefined : conflicts.length
    ? "Nothing new was created: every shift in this range is either already in Assembled or skipped because the agent already has something there at that time."
    : "Every shift in this range is already in Assembled. Nothing new was created.";
  return res.status(200).json({ created, alreadyInAssembled, conflicts, skipped, transitionMoves, transitionShort, transitionCovered, swapDaysSkipped, errors, note });
};
