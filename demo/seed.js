// Sample data for the browser demo. Every person, email and schedule here is made up.
// Dates are worked out from "now", so the demo is always mid-cycle whenever someone opens it:
//   Support: the bid window is open; most agents have ranked their shifts; nothing assigned yet.
//   Sales:   bidding finished, results published and in (fake) Assembled, day swaps waiting,
//            coach groups published, and the two Sales coaches won their coach shifts.
window.DemoSeed = function seed() {
  const { schedule, coaching } = window.DemoLib;
  const now = Date.now(), H = 3600e3, D = 24 * H;
  const iso = ms => new Date(ms).toISOString();
  const ET = "America/New_York";
  const etDate = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: ET });
  const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const today = etDate(now);
  const monday = coaching.mondayFrom(today);              // this week's Monday (ET)
  const nextMonday = addDays(monday, 7);

  const t = {}; const seq = {};
  const add = (table, row) => { (t[table] ||= []).push(row); return row; };
  const id = table => (seq[table] = (seq[table] || 0) + 1);

  // ---- admins ----------------------------------------------------------------
  const ALL = ["roster", "shells", "windows", "assign", "swaps", "push", "manual", "admins"];
  add("admins", { email: "owner@example.com", permissions: ALL });
  add("admins", { email: "scheduler@example.com", permissions: ["roster", "shells", "windows", "assign", "swaps", "push"] });
  add("admins", { email: "lead@example.com", permissions: ["swaps", "windows"] });

  // ---- people -----------------------------------------------------------------
  const email = name => name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".") + "@example.com";
  const person = (name, lob, extra = {}) => {
    const n = id("agents");
    return add("agents", { id: n, assembled_id: `p-${n}`, assembled_agent_id: `a-${n}`, name, email: email(name), lob, rank: null,
      excluded: false, accommodation: false, accommodation_tier: null, bid_submitted_at: null, lob_locked: false, ...extra });
  };
  const support = ["Alex Kim", "Chris Lee", "Maria Santos", "Dana Cruz", "Ethan Brooks", "Fiona Walsh", "Gabriel Ortiz",
    "Hana Sato", "Ivan Petrov", "Julia Moreno", "Kevin Osei", "Laura Chen", "Noah Patel", "Olivia Grant"]
    .map((name, i) => person(name, "Support", { rank: i + 1 }));
  const by = name => t.agents.find(a => a.name === name);
  Object.assign(by("Fiona Walsh"), { accommodation: true, accommodation_tier: 1 });
  by("Laura Chen").rank = 11;                                    // shares rank 11 with Kevin Osei
  const sales = ["Jordan Reyes", "Priya Nair", "Mei Lin", "Sam Okafor", "Henry Adams", "Diego Alvarez", "Isla Novak",
    "Grace Kim", "Kara Singh", "Jamal Wright"].map((name, i) => person(name, "Sales", { rank: i + 1 }));
  // Coaches: the Support coaches are on the roster but not in the agents' bid; the Sales coaches
  // have their own finished coach bid ("Sales Coaches").
  const supportCoachPeople = ["Lena Ford", "Omar Haddad", "Rosa Diaz"].map(name => person(name, "Support", { excluded: true }));
  const nora = person("Nora Quinn", "Sales Coaches", { rank: 1, lob_locked: true });
  const marco = person("Marco Diaz", "Sales Coaches", { rank: 2, lob_locked: true });

  // ---- shift shells -------------------------------------------------------------
  const shell = (lob, days, start_local, end_local, seats, set_name = null) => {
    const s = { id: id("shift_shells"), lob, days, start_local, end_local, timezone: ET, seats, set_name, schedule: null };
    s.schedule = `${days.split(",").map(n => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n]).join(",")} ${start_local} to ${end_local} ${ET}`;
    return add("shift_shells", s);
  };
  const sup = [
    shell("Support", "1,2,3,4,5", "08:00", "17:00", 3, "A"),
    shell("Support", "1,2,3,4,5", "11:00", "20:00", 3, "A"),
    shell("Support", "0,1,2,3,4", "09:00", "18:00", 3, "B"),
    shell("Support", "2,3,4,5,6", "12:00", "21:00", 3, "B"),
    shell("Support", "3,4,5,6", "07:00", "18:00", 2),
    shell("Support", "0,1,5,6", "14:00", "01:00", 2),
  ];
  const [s11, s12, s13, s14] = [
    shell("Sales", "1,2,3,4,5", "09:00", "18:00", 3),
    shell("Sales", "0,1,2,3,4", "10:00", "19:00", 3),
    shell("Sales", "2,3,4,5,6", "08:00", "17:00", 2),
    shell("Sales", "3,4,5,6", "12:00", "23:00", 3),
  ];
  const c1 = shell("Sales Coaches", "1,2,3,4,5", "09:00", "18:00", 1);
  const c2 = shell("Sales Coaches", "3,4,5,6", "12:00", "23:00", 1);

  // ---- bids ---------------------------------------------------------------------
  const bid = (agent, shellList, at) => {
    shellList.forEach((s, i) => add("bids2", { id: id("bids2"), agent_id: agent.id, shift_id: s.id, priority: i + 1 }));
    agent.bid_submitted_at = iso(at);
  };
  // Support: everyone but Maria (the demo agent), Kevin and Olivia has ranked all six shells.
  const orders = [[0, 1, 2, 3, 4, 5], [1, 0, 2, 4, 3, 5], [2, 0, 1, 3, 5, 4], [0, 2, 1, 3, 4, 5], [4, 0, 1, 2, 3, 5],
    [1, 2, 0, 3, 4, 5], [3, 1, 0, 2, 4, 5], [0, 1, 4, 2, 3, 5], [5, 3, 2, 1, 0, 4], [2, 3, 0, 1, 4, 5], [1, 0, 3, 2, 5, 4]];
  support.filter(a => !["Maria Santos", "Kevin Osei", "Olivia Grant"].includes(a.name))
    .forEach((a, i) => bid(a, orders[i].map(k => sup[k]), now - (40 - i * 3) * H));
  // Sales: finished. Each got their first pick that still had a seat in rank order.
  const salesPicks = {
    "Jordan Reyes": [s11, s12, s13, s14], "Priya Nair": [s14, s11, s12, s13], "Mei Lin": [s11, s13, s12, s14],
    "Sam Okafor": [s12, s11, s13, s14], "Henry Adams": [s14, s12, s11, s13], "Diego Alvarez": [s13, s11, s12, s14],
    "Isla Novak": [s11, s12, s14, s13], "Grace Kim": [s12, s13, s11, s14], "Kara Singh": [s11, s14, s12, s13],
    "Jamal Wright": [s11, s14, s13, s12],
  };
  sales.forEach((a, i) => bid(a, salesPicks[a.name], now - 13 * D + i * H));
  bid(nora, [c1, c2], now - 9 * D); bid(marco, [c1, c2], now - 9 * D + H);

  // ---- windows, results, publishing -------------------------------------------------
  add("bid_windows", { id: id("bid_windows"), lob: "Support", opens_at: iso(now - 2 * D), closes_at: iso(now + 3 * D), require_full_ranking: true });
  add("bid_windows", { id: id("bid_windows"), lob: "Sales", opens_at: iso(now - 14 * D), closes_at: iso(now - 11 * D), require_full_ranking: true });
  add("bid_windows", { id: id("bid_windows"), lob: "Sales Coaches", opens_at: iso(now - 10 * D), closes_at: iso(now - 9 * D), require_full_ranking: true });
  const left = Object.fromEntries(t.shift_shells.map(s => [s.id, s.seats]));
  const pushedAt = iso(now - 9 * D);
  for (const a of [...sales, nora, marco]) {
    const pick = t.bids2.filter(b => b.agent_id === a.id).sort((x, y) => x.priority - y.priority).find(b => left[b.shift_id] > 0);
    left[pick.shift_id]--;
    add("assignments", { id: id("assignments"), agent_id: a.id, shift_id: pick.shift_id, run_at: iso(now - 10 * D),
      pushed_at: a.lob === "Sales" ? pushedAt : null, push_error: null });
  }
  add("published_results", { lob: "Sales", published_at: iso(now - 10 * D), published_by: "owner@example.com" });
  add("published_results", { lob: "Sales Coaches", published_at: iso(now - 8 * D), published_by: "owner@example.com" });
  // Sales trades reopened after the push: approving one rewrites both schedules in (fake) Assembled from a Monday.
  add("swap_windows", { lob: "Sales", kind: "trade", opens_at: iso(now - 1 * D), closes_at: iso(now + 7 * D), updated_at: iso(now - 1 * D) });
  add("swap_windows", { lob: "Support", kind: "trade", opens_at: iso(now - 2 * D), closes_at: iso(now + 10 * D), updated_at: iso(now - 2 * D) });

  // ---- coaches ------------------------------------------------------------------------
  const teams = [
    { id: "t-sales", name: "Sales", parent_id: null }, { id: "t-support", name: "Support", parent_id: null },
    { id: "t-sales-coaches", name: "Sales Coaches", parent_id: null }, { id: "t-support-coaches", name: "Support Coaches", parent_id: null },
    { id: "t-coach-nora", name: "Coach Nora", parent_id: "t-sales-coaches" }, { id: "t-coach-marco", name: "Coach Marco", parent_id: "t-sales-coaches" },
    { id: "t-coach-lena", name: "Coach Lena", parent_id: "t-support-coaches" }, { id: "t-coach-omar", name: "Coach Omar", parent_id: "t-support-coaches" },
    { id: "t-coach-rosa", name: "Coach Rosa", parent_id: "t-support-coaches" },
  ];
  const coachRow = (lob, name, team, s, agent = null) => add("coaches", { id: id("coaches"), lob, name, assembled_team_id: team,
    days: s.days, start_local: s.start_local, end_local: s.end_local, timezone: ET, created_at: iso(now - 20 * D), agent_id: agent && agent.id });
  const won = a => t.shift_shells.find(s => s.id === t.assignments.find(x => x.agent_id === a.id).shift_id);
  const noraCoach = coachRow("Sales", "Nora Quinn", "t-coach-nora", won(nora), nora);
  const marcoCoach = coachRow("Sales", "Marco Diaz", "t-coach-marco", won(marco), marco);
  coachRow("Support", "Lena Ford", "t-coach-lena", { days: "1,2,3,4,5", start_local: "08:00", end_local: "17:00" });
  coachRow("Support", "Omar Haddad", "t-coach-omar", { days: "0,1,2,3,4", start_local: "10:00", end_local: "19:00" });
  coachRow("Support", "Rosa Diaz", "t-coach-rosa", { days: "2,3,4,5,6", start_local: "12:00", end_local: "21:00" });
  add("coach_lob_settings", { lob: "Sales", coach_count: 2, updated_at: iso(now - 12 * D), coaches_published_at: iso(now - 7 * D), coaches_published_by: "owner@example.com" });
  add("coach_lob_settings", { lob: "Support", coach_count: 3, updated_at: iso(now - 3 * D), coaches_published_at: null, coaches_published_by: null });
  // Sales coach groups: the real even split by schedule overlap (lib/coaching.js).
  const withShift = sales.map(a => ({ id: a.id, shift: won(a) }));
  const { rows } = coaching.distribute({ agents: withShift, coaches: [noraCoach, marcoCoach], weekStart: monday });
  for (const r of rows) add("coach_assignments", { agent_id: r.agent_id, coach_id: r.coach_id, overlap_minutes: r.overlap,
    saved_at: iso(now - 7 * D), saved_by: "owner@example.com", synced_at: iso(now - 7 * D) });

  // ---- trades and day swaps (Sales) -----------------------------------------------------
  const shiftOf = a => t.assignments.find(x => x.agent_id === a.id).shift_id;
  const day = (w, dow) => addDays(w, (dow + 6) % 7);           // dow 0 = Sunday, weeks start Monday
  const swap = (req, part, give, take, status, extra = {}) => add("swap_requests", {
    id: id("swap_requests"), lob: "Sales", requester_id: req.id, partner_id: part.id, requester_shift_id: shiftOf(req), partner_shift_id: shiftOf(part),
    start_date: give < take ? give : take, end_date: give < take ? take : give, give_date: give, take_date: take, note: null, status,
    created_at: iso(now - 20 * H), partner_responded_at: null, decided_at: null, decided_by: null, admin_note: null, result: null, ...extra });
  const [jordan, priya, mei, sam, , , , grace, kara] = sales;
  // Jordan (Mon-Fri) gives Monday to Priya (Wed-Sat) and takes her Saturday: waiting for an admin.
  swap(jordan, priya, day(nextMonday, 1), day(nextMonday, 6), "pending_admin", { note: "Family event on Monday", partner_responded_at: iso(now - 10 * H) });
  // Sam (Sun-Thu) asks Jordan to take his Sunday, giving Jordan's Friday: waiting for Jordan.
  swap(sam, jordan, day(addDays(nextMonday, 7), 0), day(addDays(nextMonday, 7), 5), "pending_partner", { note: "Can I have your Friday?", created_at: iso(now - 3 * H) });
  // Earlier, approved: Mei (Mon-Fri) and Grace (Sun-Thu).
  swap(mei, grace, day(monday, 5), day(monday, 0), "approved",
    { created_at: iso(now - 6 * D), partner_responded_at: iso(now - 6 * D + 2 * H), decided_at: iso(now - 5 * D), decided_by: "owner@example.com" });
  add("shift_trades", { id: id("shift_trades"), lob: "Sales", requester_id: kara.id, partner_id: priya.id, requester_shift_id: shiftOf(kara), partner_shift_id: shiftOf(priya),
    note: "Would like weekends off", status: "declined", auto_declined: true, created_at: iso(now - 9 * D - 6 * H), partner_responded_at: iso(now - 9 * D),
    decided_at: null, decided_by: null, admin_note: null });

  // ---- fake Assembled ---------------------------------------------------------------------
  const activityTypes = [
    { id: "et-phones", name: "Phones", productive: true, timeoff: false }, { id: "et-break", name: "Break", productive: false, timeoff: false },
    { id: "et-lunch", name: "Lunch", productive: false, timeoff: false }, { id: "et-training", name: "Training", productive: false, timeoff: false },
    { id: "et-pto", name: "PTO", productive: false, timeoff: true }, { id: "et-swap", name: "Shift Swap", productive: true, timeoff: false },
  ];
  const teamOf = { Sales: "t-sales", Support: "t-support", "Sales Coaches": "t-sales-coaches" };
  const people = t.agents.map(a => ({ id: a.assembled_id, agent_id: a.assembled_agent_id, first_name: a.name.split(" ")[0], last_name: a.name.split(" ").slice(1).join(" "),
    email: a.email, deleted: false, teams: [a.excluded ? "t-support-coaches" : teamOf[a.lob]] }));
  for (const r of t.coach_assignments) {
    const p = people.find(x => x.id === t.agents.find(a => a.id === r.agent_id).assembled_id);
    p.teams.push(t.coaches.find(c => c.id === r.coach_id).assembled_team_id);
  }
  // New hires who are in Assembled but not synced yet: Sync from Assembled brings them in.
  people.push({ id: "p-901", agent_id: "a-901", first_name: "Nina", last_name: "Castro", email: "nina.castro@example.com", deleted: false, teams: ["t-support"] });
  people.push({ id: "p-902", agent_id: "a-902", first_name: "Leo", last_name: "Mendoza", email: "leo.mendoza@example.com", deleted: false, teams: ["t-support"] });
  // A working day as Assembled holds it: shift segments with two breaks and a lunch.
  const events = [];
  const workday = (agentId, win, type = "et-phones") => {
    const m = 60, cuts = [[0, 120, type], [120, 135, "et-break"], [135, 270, type], [270, 330, "et-lunch"]];
    const len = (win.end - win.start) / m;
    cuts.push([330, len - 90, type], [len - 90, len - 75, "et-break"], [len - 75, len, type]);
    for (const [a, b, ty] of cuts) events.push({ id: `ev-${events.length + 1}`, agent_id: agentId, type_id: ty, start_time: win.start + a * m, end_time: win.start + b * m });
  };
  // Sales is in Assembled from this week's Monday for four weeks.
  for (const a of sales) {
    const s = won(a);
    for (const date of schedule.eachDate(monday, addDays(monday, 27))) { const w = schedule.shellWindow(s, date); if (w) workday(a.assembled_agent_id, w); }
  }
  // Some Support agents already have things in Assembled for the coming weeks (the push skips those days).
  const allDay = (agentId, date, type) => { const s = schedule.localToUnix(...date.split("-").map(Number), 8, 0, ET);
    events.push({ id: `ev-${events.length + 1}`, agent_id: agentId, type_id: type, start_time: s, end_time: s + 9 * 3600 }); };
  allDay(by("Alex Kim").assembled_agent_id, day(nextMonday, 3), "et-pto");
  allDay(by("Hana Sato").assembled_agent_id, day(nextMonday, 2), "et-training");
  allDay(by("Hana Sato").assembled_agent_id, day(nextMonday, 4), "et-training");

  // Logins: everyone has one except Olivia Grant (never signed in) and Kevin Osei (reset by an admin).
  const logins = {};
  for (const a of t.agents) logins[a.email] = "active";
  for (const ad of t.admins) logins[ad.email] = "active";
  delete logins["olivia.grant@example.com"];
  logins["kevin.osei@example.com"] = "reset";

  return { version: 1, seededAt: iso(now), tables: t, seq, user: "owner@example.com", logins,
    assembled: { teams, people, activityTypes, events, nextEvent: events.length + 1 } };
};
