// Shared schedule helpers for the API functions: turning shift shells into real times, and
// planning shift swaps against the events already in Assembled.

// Offset in ms between UTC and the wall clock in timeZone at a given instant.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) m[p.type] = p.value;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, (+m.hour) % 24, +m.minute, +m.second);
  return asUTC - utcMs;
}

// Converts a local wall clock time in a zone to a UNIX timestamp in seconds.
function localToUnix(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, timeZone);
  utc = guess - tzOffsetMs(utc, timeZone);
  return Math.floor(utc / 1000);
}

// Every "YYYY-MM-DD" from startDate to endDate inclusive.
function eachDate(startDate, endDate) {
  const out = [], end = new Date(endDate + "T00:00:00Z");
  for (let d = new Date(startDate + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Start and end (UNIX seconds) of a shell on a local date, or null if the shell does not work
// that weekday or is missing details. An end time at or before the start means overnight.
function shellWindow(shell, date) {
  if (!shell || !shell.days || !shell.start_local || !shell.end_local || !shell.timezone) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const weekdays = String(shell.days).split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (!weekdays.includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())) return null;
  const [sh, sm] = String(shell.start_local).split(":").map(Number);
  const [eh, em] = String(shell.end_local).split(":").map(Number);
  const start = localToUnix(y, mo, d, sh, sm, shell.timezone);
  if ((eh * 60 + em) > (sh * 60 + sm)) return { start, end: localToUnix(y, mo, d, eh, em, shell.timezone) };
  const next = new Date(Date.UTC(y, mo - 1, d));
  next.setUTCDate(next.getUTCDate() + 1);
  return { start, end: localToUnix(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), eh, em, shell.timezone) };
}

// An agent's working block around a shift window: every event overlapping the window, plus any
// event that touches the block, repeated until nothing more joins. In Assembled a working day is
// a chain of back-to-back events (shift segments, breaks, lunch), so this is that whole chain.
function chainAround(activities, win) {
  const block = new Set(activities.filter(a => a.start_time < win.end && a.end_time > win.start));
  if (!block.size) return [];
  let lo = Math.min(...[...block].map(a => a.start_time)), hi = Math.max(...[...block].map(a => a.end_time));
  for (let grew = true; grew;) {
    grew = false;
    for (const a of activities) {
      if (!block.has(a) && a.start_time <= hi && a.end_time >= lo) {
        block.add(a); lo = Math.min(lo, a.start_time); hi = Math.max(hi, a.end_time); grew = true;
      }
    }
  }
  return [...block].sort((x, y) => x.start_time - y.start_time);
}
const spanOf = block => block.length
  ? { start: block[0].start_time, end: Math.max(...block.map(a => a.end_time)) } : null;

// Plans a one-day swap between agent A (requester) and agent B (partner). Each agent's working
// day around their own shell on that date is removed, and each gets a copy of the other's day:
// the work parts become the "Shift Swap" event type, while breaks and lunch (keepType) are copied
// as they are, at the same times. If one of them is off that day, the other ends up off.
// Returns what is removed and created for each agent, and any issues that must block approval.
function planDaySwap({ date, shellA, shellB, activitiesA, activitiesB, nameA = "A", nameB = "B", swapTypeId, keepType = () => false, maxBlockHours = 16 }) {
  const winA = shellWindow(shellA, date), winB = shellWindow(shellB, date);
  const blockA = winA ? chainAround(activitiesA, winA) : [], blockB = winB ? chainAround(activitiesB, winB) : [];
  const issues = [];
  if (!winA && !winB) issues.push(`Neither ${nameA} nor ${nameB} works on ${date}, so there is nothing to swap.`);
  for (const [win, block, name] of [[winA, blockA, nameA], [winB, blockB, nameB]]) {
    if (win && !block.length) issues.push(`${name} has nothing scheduled in Assembled at their shift time on ${date}. Check their schedule first.`);
    const span = spanOf(block);
    if (span && (span.end - span.start) / 3600 > maxBlockHours) {
      issues.push(`${name}'s schedule on ${date} is ${((span.end - span.start) / 3600).toFixed(1)} hours without a gap. Check it in Assembled.`);
    }
  }
  // Each agent's new day is a copy of the other's: work becomes Shift Swap, breaks and lunch stay.
  const copyFor = block => block.map(a => ({ type_id: keepType(a.type_id) ? a.type_id : swapTypeId, start_time: a.start_time, end_time: a.end_time }));
  const toA = copyFor(blockB), toB = copyFor(blockA);
  // Anything else they already have at those times (not being removed) would double-book them.
  for (const [incoming, own, removed, name] of [[spanOf(blockB), activitiesA, blockA, nameA], [spanOf(blockA), activitiesB, blockB, nameB]]) {
    if (!incoming) continue;
    const clash = own.filter(a => !removed.includes(a) && a.start_time < incoming.end && a.end_time > incoming.start);
    if (clash.length) issues.push(`${name} already has ${clash.length} other event${clash.length === 1 ? "" : "s"} during the time they would take over on ${date}.`);
  }
  return {
    date, winA, winB, blockA, blockB, toA, toB, issues,
    deletes: [
      ...(blockA.length ? [{ who: "A", ...spanOf(blockA) }] : []),
      ...(blockB.length ? [{ who: "B", ...spanOf(blockB) }] : []),
    ],
  };
}

// Plans a rest-day swap between agent A (requester) and agent B (partner), two days in one week:
//   giveDate: A works, B is off -> A's working day is removed; B works it instead.
//   takeDate: A is off, B works -> B's working day is removed; A works it instead.
// On the day they pick up, each agent starts at the partner's usual start time that day but works
// their own day: their own length (9 or 11 hours), breaks and lunch at the same places, with the
// work parts as the "Shift Swap" type. So a 5x9 taking a 12pm 4x11 day works 12pm-9pm, and a 4x11
// taking a 9am 5x9 day works 9am-8pm. Each keeps their daily and weekly hours.
function planRestDaySwap({ giveDate, takeDate, shellA, shellB, activitiesA, activitiesB, nameA = "A", nameB = "B", swapTypeId, keepType = () => false, maxBlockHours = 16 }) {
  const issues = [];
  const winA = shellWindow(shellA, giveDate), winB = shellWindow(shellB, takeDate);
  if (!winA) issues.push(`${nameA} is not scheduled to work on ${giveDate}.`);
  if (!winB) issues.push(`${nameB} is not scheduled to work on ${takeDate}.`);
  if (shellWindow(shellB, giveDate)) issues.push(`${nameB} already works on ${giveDate}.`);
  if (shellWindow(shellA, takeDate)) issues.push(`${nameA} already works on ${takeDate}.`);
  const blockA = winA ? chainAround(activitiesA, winA) : [], blockB = winB ? chainAround(activitiesB, winB) : [];
  if (winA && !blockA.length) issues.push(`${nameA} has nothing scheduled in Assembled at their shift time on ${giveDate}. Check their schedule first.`);
  if (winB && !blockB.length) issues.push(`${nameB} has nothing scheduled in Assembled at their shift time on ${takeDate}. Check their schedule first.`);
  for (const [block, name, date] of [[blockA, nameA, giveDate], [blockB, nameB, takeDate]]) {
    const span = spanOf(block);
    if (span && (span.end - span.start) / 3600 > maxBlockHours) {
      issues.push(`${name}'s schedule on ${date} is ${((span.end - span.start) / 3600).toFixed(1)} hours without a gap. Check it in Assembled.`);
    }
  }
  // Own day, moved so it starts at the partner's start time (startAt) on the new date.
  const moveDay = (block, startAt) => {
    if (!block.length || startAt == null) return [];
    const shift = startAt - Math.min(...block.map(a => a.start_time));
    return block.map(a => ({ type_id: keepType(a.type_id) ? a.type_id : swapTypeId, start_time: a.start_time + shift, end_time: a.end_time + shift }));
  };
  const toA = moveDay(blockA, winB && winB.start);   // A's own day, starting when B starts on takeDate
  const toB = moveDay(blockB, winA && winA.start);   // B's own day, starting when A starts on giveDate
  // Anything they already have at the new times (not being removed) would double-book them.
  for (const [incoming, own, removed, name, date] of [[spanOf(toA), activitiesA, blockA, nameA, takeDate], [spanOf(toB), activitiesB, blockB, nameB, giveDate]]) {
    if (!incoming) continue;
    const clash = own.filter(a => !removed.includes(a) && a.start_time < incoming.end && a.end_time > incoming.start);
    if (clash.length) issues.push(`${name} already has ${clash.length} other event${clash.length === 1 ? "" : "s"} in Assembled at the time they would work on ${date}.`);
  }
  return {
    giveDate, takeDate, blockA, blockB, toA, toB, issues,
    deletes: [
      ...(blockA.length ? [{ who: "A", ...spanOf(blockA) }] : []),
      ...(blockB.length ? [{ who: "B", ...spanOf(blockB) }] : []),
    ],
  };
}

// ---- transition week ---------------------------------------------------
// When a new schedule starts, an agent's last days on the old schedule plus the first days of
// the new one can add up to too many working days in a row. These helpers find those days.

// Local "YYYY-MM-DD" of a UNIX time in a timezone.
function localDate(unix, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unix * 1000));
}

// Local dates an agent works, from their Assembled events. Time off does not count as working.
function workedDates(activities, timeZone, isTimeOff) {
  const dates = new Set();
  for (const a of activities) if (!isTimeOff(a.type_id)) dates.add(localDate(a.start_time, timeZone));
  return dates;
}

// How many days in a row the agent worked right up to the day before startDate.
function streakBefore(worked, startDate, lookBack = 14) {
  let n = 0;
  const d = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < lookBack; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (!worked.has(d.toISOString().slice(0, 10))) break;
    n++;
  }
  return n;
}

// In the first `days` dates from startDate, the shifts to leave out so the agent never works
// more than maxDays in a row. `works(date)` says whether the new schedule has them working.
// A left-out shift is a day off, so the count starts again after it.
function transitionSkips({ startDate, endDate, works, priorStreak, maxDays = 5, days = 7 }) {
  const last = new Date(`${startDate}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + days - 1);
  const cutoff = last.toISOString().slice(0, 10);
  const skips = [];
  let streak = priorStreak;
  for (const date of eachDate(startDate, endDate < cutoff ? endDate : cutoff)) {
    if (!works(date)) { streak = 0; continue; }
    if (streak + 1 > maxDays) { skips.push({ date, inARow: streak + 1 }); streak = 0; }
    else streak++;
  }
  return skips;
}

// The transition week is the new schedule's first Monday-to-Sunday week. The agent keeps every
// shift of that week (so their full weekly hours) and never works more than maxRun days in a row,
// counting the old schedule's last days before weekStart and the final schedule's first days the
// week after. When the planned week breaks that, shifts move to the agent's days off in the same
// week, at the same hours: the fewest moves possible, each as close to the day it left as possible.
// works(date): the new schedule has them working that date. priorStreak: days in a row just before.
// timeOff(date): the agent already has time off (PTO) in Assembled that date. A PTO day counts as one
// of their working days that week (for days in a row and for how many days they work); the push
// skips it, and no shift moves onto it. busy(date): something else is already there, so no shift
// moves onto it either.
// Returns { moves: [{ from, to }], covered: [{ date, by }] (shifts a PTO day counts for, not pushed),
// dropped: [date] (no free day found for these), firstBreak: { date, inARow } }.
function planTransitionWeek({ weekStart, works, priorStreak, maxRun, timeOff = () => false, busy = () => false }) {
  const week = [], d = new Date(`${weekStart}T00:00:00Z`);
  for (let i = 0; i < 7; i++) { week.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  let after = 0;   // days in a row the final schedule starts the next week with
  for (let i = 0; i < 14 && works(d.toISOString().slice(0, 10)); i++) { after++; d.setUTCDate(d.getUTCDate() + 1); }

  const planned = week.map(date => !!works(date));
  const pto = week.map(date => !!timeOff(date));
  const taken = week.map((date, i) => pto[i] || !!busy(date));
  const firstBreakOf = on => {
    let run = priorStreak;
    for (let i = 0; i < 7; i++) {
      if (!on[i]) { run = 0; continue; }
      if (++run > maxRun) return { date: week[i], inARow: run };
    }
    if (run && run + after > maxRun) return { date: week[6], inARow: run + after };
    return null;
  };
  const need = planned.filter(Boolean).length;
  const asPlanned = week.map((_, i) => planned[i] || pto[i]);
  const firstBreak = firstBreakOf(asPlanned);
  if (!firstBreak && asPlanned.filter(Boolean).length <= need) return { moves: [], covered: [], dropped: [], firstBreak: null };

  // Every way to work some days of the week, best first: as many working days as planned (PTO days
  // count), then the fewest changes, then moves that stay closest to where they were. PTO days are
  // always working days; a shift only moves onto a day that is free in Assembled.
  let best = null;
  for (let mask = 0; mask < 128; mask++) {
    const on = week.map((_, i) => !!(mask & (1 << i)));
    if (week.some((_, i) => pto[i] && !on[i]) || week.some((_, i) => on[i] && !planned[i] && !pto[i] && taken[i])) continue;
    const size = on.filter(Boolean).length;
    if (size > need || firstBreakOf(on)) continue;
    const removed = week.map((_, i) => i).filter(i => planned[i] && !on[i]);
    const added = week.map((_, i) => i).filter(i => !planned[i] && !pto[i] && on[i]);
    const distance = removed.reduce((n, r, k) => n + (added[k] != null ? Math.abs(added[k] - r) : 0), 0);
    const score = [need - size, removed.length, distance, added.join()];
    if (!best || cmp(score, best.score) < 0) best = { score, removed, added, size };
  }
  const pairs = best.removed.map((r, k) => ({ r, a: best.added[k] }));
  const unmatched = pairs.filter(p => p.a == null).map(p => week[p.r]);
  // PTO on a day they were not scheduled stands in for a shift; any other unmatched shift is short.
  const ptoDays = week.filter((_, i) => pto[i] && !planned[i]);
  const covered = unmatched.slice(0, ptoDays.length).map((date, k) => ({ date, by: ptoDays[k] }));
  return {
    moves: pairs.filter(p => p.a != null).map(p => ({ from: week[p.r], to: week[p.a] })),
    covered,
    dropped: unmatched.slice(ptoDays.length),
    firstBreak: firstBreak || { date: ptoDays[0], inARow: 0 },
  };
}
function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ---- permanent trade after the push --------------------------------------
// The events of one working block as Assembled stores them: a shift comes back cut into pieces around
// whatever sits on top of it, every piece with the shift's id, so pieces with one id are one event.
// (Repeating events share an id across days, so this only merges within one block.)
function mergeBlock(block) {
  const byId = new Map();
  for (const a of block) {
    const x = byId.get(a.id);
    if (x) { x.start_time = Math.min(x.start_time, a.start_time); x.end_time = Math.max(x.end_time, a.end_time); }
    else byId.set(a.id, { type_id: a.type_id, start_time: a.start_time, end_time: a.end_time, description: a.description || null });
  }
  return [...byId.values()].sort((x, y) => x.start_time - y.start_time);
}

// The last date from startDate to endDate on which an agent has a working block in Assembled at their
// shell's time (a block with work in it), or null: how far their schedule has been pushed.
function pushedThrough({ shell, startDate, endDate, activities, kind }) {
  let last = null;
  for (const date of eachDate(startDate, endDate)) {
    const win = shellWindow(shell, date);
    if (win && chainAround(activities, win).some(a => kind(a.type_id) === "work")) last = date;
  }
  return last;
}

// Plans one agent's side of a permanent trade made after the push: from startDate (a Monday) to
// endDate they move from oldShell to newShell in Assembled.
//   Each working day of the old shell is removed as a whole block (the shift and everything on it).
//   The new shell's shift is created on its days, as shiftTypeId (the old shift's event type).
//   Breaks and lunch are not carried over: the hours are different, so they are added again with
//   the Breaks tool. Everything else in a removed block (training, meetings, time off) is put back
//   exactly as it was; anything that no longer sits inside the new hours is listed for the admin.
//   The first week follows the push's transition rule (planTransitionWeek): at most maxRun days in a
//   row, counting the days just before startDate, with shifts moved to a day off that week if needed.
//   Where a new shift lands on something already there outside the removed blocks: another shift
//   means that day is skipped and listed (as the push does); training, meetings or time off are taken
//   off and put back on top of the new shift.
// activities: the agent's Assembled pieces from at least 15 days before startDate to after endDate.
// kind(type_id): "work" | "break" | "lunch" | "timeoff" | "other".
// Returns { deletes: [{ date, start, end, restore }], shifts, kept, removedDays, addedDays, droppedBreaks,
//   conflicts, outside (kept events outside the new hours), notes, moves, issues }.
function planShiftChange({ oldShell, newShell, startDate, endDate, activities, kind, shiftTypeId, maxRun, name = "This agent", maxBlockHours = 16 }) {
  const issues = [], notes = [], conflicts = [], outside = [], deletes = [], kept = [], shifts = [];
  const removedDays = [], addedDays = [];
  let droppedBreaks = 0;
  if (!endDate || endDate < startDate) {
    return { deletes, shifts, kept, removedDays, addedDays, droppedBreaks, conflicts, outside, notes, moves: [], issues };
  }
  const dates = eachDate(startDate, endDate);
  const tz = newShell.timezone;

  // 1. The old working days to remove.
  const removed = new Set();
  for (const date of dates) {
    const win = shellWindow(oldShell, date);
    if (!win) continue;
    const block = chainAround(activities, win);
    if (!block.length) continue;
    const span = spanOf(block);
    if ((span.end - span.start) / 3600 > maxBlockHours) {
      issues.push(`${name}'s schedule on ${niceDate(date)} is ${((span.end - span.start) / 3600).toFixed(1)} hours without a gap. Check it in Assembled.`);
      continue;
    }
    for (const a of block) removed.add(a);
    const events = mergeBlock(block);
    deletes.push({ date, start: span.start, end: span.end, restore: events });
    removedDays.push({ date, start: span.start, end: span.end });
    for (const e of events) {
      const k = kind(e.type_id);
      if (k === "break" || k === "lunch") droppedBreaks++;
      else if (k !== "work") kept.push({ ...e, date });
    }
  }
  const remaining = activities.filter(a => !removed.has(a));

  // 2. The first week: the push's transition rule.
  const worked = workedDates(activities.filter(a => a.end_time <= dayStartIn(startDate, tz)), tz, id => kind(id) === "timeoff");
  const onDate = (list, date) => list.filter(a => localDate(a.start_time, tz) === date);
  const plan = planTransitionWeek({
    weekStart: startDate, maxRun, priorStreak: streakBefore(worked, startDate),
    works: date => !!shellWindow(newShell, date),
    timeOff: date => onDate([...remaining, ...kept], date).some(a => kind(a.type_id) === "timeoff"),
    busy: date => onDate([...remaining, ...kept], date).length > 0,
  });
  const out = new Set([...plan.moves.map(m => m.from), ...plan.dropped, ...plan.covered.map(c => c.date)]);
  const extra = new Map(plan.moves.map(m => [m.to, m.from]));
  for (const date of plan.dropped) notes.push(`${name}'s shift on ${niceDate(date)} is left out so they don't work more than ${maxRun} days in a row, and no day off that week was free to take it.`);
  for (const c of plan.covered) notes.push(`${name}'s time off on ${niceDate(c.by)} counts for the shift on ${niceDate(c.date)}, so no shift is added on ${niceDate(c.date)}.`);

  // 3. The new shifts.
  for (const date of dates) {
    const win = out.has(date) ? null
      : extra.has(date) ? shellWindow({ ...newShell, days: "0,1,2,3,4,5,6" }, date)
      : shellWindow(newShell, date);
    if (!win) continue;
    // Something already there: another shift means the day is skipped and listed; anything else
    // (training, a meeting, time off) is taken off and put back on top of the new shift.
    const there = chainAround(remaining, win);
    if (there.some(a => kind(a.type_id) === "work")) { conflicts.push({ date, found: [...new Set(there.map(a => a.type_id))] }); continue; }
    if (there.length) {
      const span = spanOf(there), events = mergeBlock(there);
      deletes.push({ date, start: span.start, end: span.end, restore: events });
      for (const e of events) kept.push({ ...e, date });
    }
    shifts.push({ type_id: shiftTypeId, start_time: win.start, end_time: win.end });
    addedDays.push({ date, start: win.start, end: win.end, moved: extra.get(date) || null });
  }

  // 4. Kept events that no longer fit the new hours.
  for (const e of kept) {
    const inside = shifts.some(s => e.start_time >= s.start_time && e.end_time <= s.end_time);
    if (!inside) outside.push({ date: e.date, type_id: e.type_id, start: e.start_time, end: e.end_time, timeoff: kind(e.type_id) === "timeoff" });
  }
  if (shifts.length && !shiftTypeId) issues.push(`Could not tell which event type ${name}'s shifts use in Assembled.`);
  return { deletes, shifts, kept, removedDays, addedDays, droppedBreaks, conflicts, outside, notes, moves: plan.moves, issues };
}
// "2026-11-09" as "Mon, Nov 9", for messages.
const niceDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
// The start of a date in a time zone, as UNIX seconds.
function dayStartIn(date, timeZone) {
  const [y, mo, d] = date.split("-").map(Number);
  return localToUnix(y, mo, d, 0, 0, timeZone);
}

module.exports = {
  tzOffsetMs, localToUnix, eachDate, shellWindow, chainAround, planDaySwap, planRestDaySwap,
  localDate, workedDates, streakBefore, transitionSkips, planTransitionWeek,
  mergeBlock, pushedThrough, planShiftChange, niceDate,
};
