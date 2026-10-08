// Coach groups: share a LOB's agents out between its coaches so that each coach gets about the
// same number of agents (within one), and inside that, agents whose shifts overlap their coach's
// schedule as much as possible.
//
// A schedule is a shift shell or a coach's schedule: { days: "1,2,3", start_local: "HH:MM",
// end_local: "HH:MM", timezone }. Overlap is measured over one Monday-to-Sunday week in ET, so
// overnight shifts and different time zones count correctly.

const { localToUnix, shellWindow } = require("./schedule");

const APP_TZ = "America/New_York";

const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// The Monday on or after a "YYYY-MM-DD" date.
function mondayFrom(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, (8 - d.getUTCDay()) % 7);
}

// Working windows (UNIX seconds) of a schedule within the ET week starting on weekStart (a Monday).
// Includes the end of a shift that starts the Sunday before and runs past midnight.
function weekWindows(schedule, weekStart) {
  const midnight = date => { const [y, mo, d] = date.split("-").map(Number); return localToUnix(y, mo, d, 0, 0, APP_TZ); };
  const from = midnight(weekStart), to = midnight(addDays(weekStart, 7));
  const out = [];
  for (let i = -1; i < 7; i++) {
    const win = shellWindow(schedule, addDays(weekStart, i));
    if (!win) continue;
    const s = Math.max(win.start, from), e = Math.min(win.end, to);
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

// Minutes both lists of windows are working.
function windowsOverlap(wa, wb) {
  let secs = 0;
  for (const x of wa) for (const y of wb) secs += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return Math.round(secs / 60);
}
// Minutes per week that two schedules are both working.
const overlapMinutes = (a, b, weekStart) => windowsOverlap(weekWindows(a, weekStart), weekWindows(b, weekStart));

const weekMinutes = (schedule, weekStart) => Math.round(weekWindows(schedule, weekStart).reduce((n, w) => n + w.end - w.start, 0) / 60);

// Weekdays both have off.
function sharedDaysOff(a, b) {
  const days = s => new Set(String(s.days || "").split(",").map(x => parseInt(x, 10)).filter(n => !isNaN(n)));
  const on = new Set([...days(a), ...days(b)]);
  return 7 - on.size;
}

// Minimum-cost assignment (Hungarian method). cost is n rows by m columns with n <= m; returns,
// for each row, the column it gets. Costs must be finite numbers.
function hungarian(cost) {
  const n = cost.length, m = n ? cost[0].length : 0;
  if (n > m) throw new Error("More rows than columns");
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

// agents: [{ id, shift }]; coaches: [{ id, ...schedule }]. Every coach gets floor(n/k) or
// floor(n/k)+1 agents, and the total weekly overlap is as large as it can be (shared days off
// break ties). Returns { rows: [{ agent_id, coach_id, overlap, agentMinutes }], overlap: { agentId: { coachId: minutes } } }.
// shuffle: { current: { agentId: coachId }, random } shares them out at random instead, still
// evenly, with as many agents as possible on a different coach than in `current`.
// keep: { agentId: coachId } keeps those agents with their coach and only places the others
// (for example agents added later): see placeNew.
function distribute({ agents, coaches, weekStart, shuffle = null, keep = null }) {
  const overlap = {}, score = {};
  const coachWins = coaches.map(c => weekWindows(c, weekStart));
  for (const a of agents) {
    overlap[a.id] = {}; score[a.id] = {};
    const agentWins = weekWindows(a.shift, weekStart);
    for (const [ci, c] of coaches.entries()) {
      const mins = windowsOverlap(agentWins, coachWins[ci]);
      overlap[a.id][c.id] = mins;
      score[a.id][c.id] = shuffle
        ? Math.floor((shuffle.random || Math.random)() * 1e6) - (String(shuffle.current?.[a.id]) === String(c.id) ? 1e8 : 0)
        : mins * 10 + sharedDaysOff(a.shift, c);
    }
  }
  if (!agents.length || !coaches.length) return { rows: [], overlap };
  if (keep && !shuffle) return placeNew({ agents, coaches, weekStart, keep, overlap, score });
  const n = agents.length, k = coaches.length, base = Math.floor(n / k), extra = n % k;
  // Each coach has `base` seats that must be filled (worth a large bonus) and, when the agents do
  // not split evenly, one more seat that may be. So sizes differ by at most one.
  const slots = [];
  for (const c of coaches) {
    for (let i = 0; i < base; i++) slots.push({ coach: c, required: true });
    if (extra) slots.push({ coach: c, required: false });
  }
  const BONUS = 1e9;
  const cost = agents.map(a => slots.map(s => -(score[a.id][s.coach.id] + (s.required ? BONUS : 0))));
  const pick = hungarian(cost);
  const rows = agents.map((a, i) => {
    const c = slots[pick[i]].coach;
    return { agent_id: a.id, coach_id: c.id, overlap: overlap[a.id][c.id], agentMinutes: weekMinutes(a.shift, weekStart) };
  });
  return { rows, overlap };
}

// Agents already with a coach stay put; the others go to the coaches with fewer agents first and,
// among those, to the closest schedule. Coaches are filled toward an even split (sizes within one
// where the kept agents allow it); a coach already over that size gets nobody new unless there is
// no other place. Returns the same shape as distribute, plus placed: [agentId].
function placeNew({ agents, coaches, weekStart, keep, overlap, score }) {
  const coachIds = new Set(coaches.map(c => String(c.id)));
  const kept = agents.filter(a => keep[a.id] != null && coachIds.has(String(keep[a.id])));
  const free = agents.filter(a => !kept.includes(a));
  const coachOf = Object.fromEntries(kept.map(a => [a.id, coaches.find(c => String(c.id) === String(keep[a.id]))]));
  const count = Object.fromEntries(coaches.map(c => [c.id, kept.filter(a => coachOf[a.id] === c).length]));
  if (free.length) {
    const n = agents.length, k = coaches.length, base = Math.floor(n / k), extra = n % k;
    // Seats left before each coach reaches the even size (worth a large bonus), one more seat for
    // an uneven split, and fallback seats (heavily penalised) so everyone always gets a coach.
    const slots = [];
    for (const c of coaches) {
      const cur = count[c.id];
      for (let i = cur; i < base; i++) slots.push({ coach: c, bonus: 2e9 });
      if (extra && cur <= base) slots.push({ coach: c, bonus: 1e9 });
      for (let i = 0; i < free.length; i++) slots.push({ coach: c, bonus: -i * 1e6 });
    }
    const pick = hungarian(free.map(a => slots.map(s => -(score[a.id][s.coach.id] + s.bonus))));
    free.forEach((a, i) => { coachOf[a.id] = slots[pick[i]].coach; });
  }
  const rows = agents.map(a => ({ agent_id: a.id, coach_id: coachOf[a.id].id, overlap: overlap[a.id][coachOf[a.id].id], agentMinutes: weekMinutes(a.shift, weekStart) }));
  return { rows, overlap, placed: free.map(a => a.id) };
}

// Coach schedules for a LOB: picks `count` of the LOB's shift shells (candidates) as coach
// schedules so that, after the even split above, agents share as many hours as possible with
// their own coach. A greedy start, then swapping one schedule at a time while it improves.
// Ties go to more of the agents' hours having at least one coach on.
// Returns { schedules: [{ shell, agents, together, hours }], together, hours, covered }, in minutes.
function suggestSchedules({ agents, candidates, count, weekStart, maxRounds = 20 }) {
  const n = agents.length, k = Math.max(1, Math.min(count, n || 1));
  const keyOf = s => `${s.days}|${s.start_local}|${s.end_local}|${s.timezone}`;
  const cands = [...new Map(candidates.map(s => [keyOf(s), s])).values()];
  if (!n || !cands.length) return { schedules: [], together: 0, hours: 0, covered: 0 };
  const aw = agents.map(a => weekWindows(a.shift, weekStart)), cw = cands.map(c => weekWindows(c, weekStart));
  const M = aw.map(w => cw.map(c => windowsOverlap(w, c)));            // agent x candidate minutes together
  const mins = aw.map(w => Math.round(w.reduce((t, x) => t + x.end - x.start, 0) / 60)), total = mins.reduce((a, b) => a + b, 0);
  const union = ws => { const out = []; for (const w of [...ws].sort((a, b) => a.start - b.start)) { const l = out[out.length - 1]; if (l && w.start <= l.end) l.end = Math.max(l.end, w.end); else out.push({ ...w }); } return out; };
  function evaluate(set) {
    const base = Math.floor(n / set.length), extra = n % set.length, slots = [];
    set.forEach((_, j) => { for (let i = 0; i < base; i++) slots.push({ j, req: true }); if (extra) slots.push({ j, req: false }); });
    const pick = hungarian(agents.map((_, a) => slots.map(s => -(M[a][set[s.j]] * 10 + (s.req ? 1e9 : 0)))));
    const sizes = set.map(() => 0), together = set.map(() => 0), hours = set.map(() => 0);
    pick.forEach((si, a) => { const j = slots[si].j; sizes[j]++; together[j] += M[a][set[j]]; hours[j] += mins[a]; });
    const all = union(set.flatMap(c => cw[c]));
    const covered = aw.reduce((t, w) => t + windowsOverlap(w, all), 0);
    return { set, sizes, together, hours, own: together.reduce((a, b) => a + b, 0), covered };
  }
  const better = (x, y) => !y || x.own > y.own || (x.own === y.own && x.covered > y.covered);
  let cur = null;
  for (let j = 0; j < k; j++) {
    let best = null;
    for (let c = 0; c < cands.length; c++) { const e = evaluate([...(cur ? cur.set : []), c]); if (better(e, best)) best = e; }
    cur = best;
  }
  for (let round = 0, improved = true; improved && round < maxRounds; round++) {
    improved = false;
    for (let j = 0; j < k; j++) for (let c = 0; c < cands.length; c++) {
      if (c === cur.set[j]) continue;
      const trial = cur.set.slice(); trial[j] = c;
      const e = evaluate(trial);
      if (better(e, cur)) { cur = e; improved = true; }
    }
  }
  // Earliest start first, then by first weekday.
  const order = cur.set.map((c, j) => j).sort((x, y) => String(cands[cur.set[x]].start_local).localeCompare(String(cands[cur.set[y]].start_local)) || String(cands[cur.set[x]].days).localeCompare(String(cands[cur.set[y]].days)));
  return {
    schedules: order.map(j => ({ shell: cands[cur.set[j]], agents: cur.sizes[j], together: cur.together[j], hours: cur.hours[j] })),
    together: cur.own, hours: total, covered: cur.covered,
  };
}

// How well a set of coach schedules fits, with the even split: { together, hours, covered } in minutes.
function scoreSchedules({ agents, coaches, weekStart }) {
  if (!agents.length || !coaches.length) return { together: 0, hours: 0, covered: 0 };
  const { rows } = distribute({ agents, coaches, weekStart });
  const aw = agents.map(a => weekWindows(a.shift, weekStart));
  const all = []; for (const c of coaches) all.push(...weekWindows(c, weekStart));
  const merged = []; for (const w of all.sort((a, b) => a.start - b.start)) { const l = merged[merged.length - 1]; if (l && w.start <= l.end) l.end = Math.max(l.end, w.end); else merged.push({ ...w }); }
  return { together: rows.reduce((t, r) => t + r.overlap, 0), hours: rows.reduce((t, r) => t + r.agentMinutes, 0), covered: aw.reduce((t, w) => t + windowsOverlap(w, merged), 0) };
}

// A person's teams after moving them into coachTeamId: every team under the LOB's coach groups
// (coachTeamIds) is dropped and coachTeamId is added. All their other teams stay.
function nextTeams(current, coachTeamIds, coachTeamId) {
  const keep = (current || []).filter(t => !coachTeamIds.has(t));
  return coachTeamId ? [...keep, coachTeamId] : keep;
}
const sameTeams = (a, b) => [...(a || [])].sort().join() === [...(b || [])].sort().join();

module.exports = { mondayFrom, weekWindows, overlapMinutes, weekMinutes, sharedDaysOff, hungarian, distribute, suggestSchedules, scoreSchedules, nextTeams, sameTeams };
