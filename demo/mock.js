// Browser demo backend. Stands in for Supabase (tables, database functions, sign-in) and for the
// /api/* server functions (which talk to Assembled), so the real app (public/app.js) runs unchanged
// with sample data. Everything lives in this browser's localStorage; nothing is sent anywhere.
// The database functions and API handlers below follow supabase/*.sql and api/*.js.
(function () {
  const KEY = "shiftBiddingDemo.db.v1";
  const { schedule, coaching } = window.DemoLib;
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
  const nowIso = () => new Date().toISOString();

  let db = null;
  try { db = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { db = null; }
  if (!db || db.version !== 1) db = window.DemoSeed();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private window: this visit only */ } };
  save();
  window.DemoDB = { get: () => db, reset() { try { localStorage.removeItem(KEY); } catch {} } };

  // ---- table rules -------------------------------------------------------------------------
  const T = name => (db.tables[name] ||= []);
  const AUTO_ID = ["agents", "shift_shells", "bid_windows", "bids2", "assignments", "swap_requests", "shift_trades", "coaches"];
  const KEYS = { admins: ["email"], manual_assignments: ["agent_id"], published_results: ["lob"], swap_windows: ["lob", "kind"],
    coach_assignments: ["agent_id"], coach_lob_settings: ["lob"] };
  const UNIQUE = { agents: [["email"]] };
  const keyOf = table => KEYS[table] || ["id"];
  const REL = {
    assignments: { agent_id: "agents", shift_id: "shift_shells" }, bids2: { agent_id: "agents", shift_id: "shift_shells" },
    manual_assignments: { agent_id: "agents", shift_id: "shift_shells" },
    shift_trades: { requester_id: "agents", partner_id: "agents", requester_shift_id: "shift_shells", partner_shift_id: "shift_shells" },
    swap_requests: { requester_id: "agents", partner_id: "agents", requester_shift_id: "shift_shells", partner_shift_id: "shift_shells" },
    coach_assignments: { agent_id: "agents", coach_id: "coaches" }, coaches: { agent_id: "agents" },
  };
  const STANDARD = ["roster", "shells", "windows", "assign", "swaps", "push"];
  const DEFAULTS = {
    agents: () => ({ excluded: false, accommodation: false, accommodation_tier: null, rank: null, lob_locked: false, bid_submitted_at: null, assembled_id: null, assembled_agent_id: null }),
    shift_shells: () => ({ seats: 1, set_name: null, schedule: null }),
    bid_windows: () => ({ require_full_ranking: true }),
    assignments: () => ({ run_at: nowIso(), pushed_at: null, push_error: null }),
    admins: () => ({ permissions: [...STANDARD] }),
    manual_assignments: () => ({ assigned_by: me(), assigned_at: nowIso() }),
    published_results: () => ({ published_at: nowIso(), published_by: me() }),
    swap_requests: () => ({ status: "pending_partner", created_at: nowIso(), note: null, admin_note: null, partner_responded_at: null, decided_at: null, decided_by: null, result: null, give_date: null, take_date: null }),
    shift_trades: () => ({ status: "pending_partner", created_at: nowIso(), note: null, admin_note: null, partner_responded_at: null, decided_at: null, decided_by: null, auto_declined: false }),
    swap_windows: () => ({ kind: "trade", updated_at: nowIso() }),
    coaches: () => ({ timezone: "America/New_York", created_at: nowIso(), agent_id: null, assembled_team_id: null }),
    coach_assignments: () => ({ overlap_minutes: null, saved_at: nowIso(), saved_by: me(), synced_at: null }),
    coach_lob_settings: () => ({ coach_count: null, updated_at: nowIso(), coaches_published_at: null, coaches_published_by: null }),
  };
  // Who may change each table (the row-level security policies in supabase/*.sql).
  const WRITE_PERM = { agents: "roster", shift_shells: "shells", bid_windows: "windows", bids2: "windows", assignments: "assign",
    admins: "admins", manual_assignments: "manual", published_results: "assign", swap_requests: "swaps", shift_trades: "swaps",
    swap_windows: "windows", coaches: "roster", coach_assignments: "roster", coach_lob_settings: "roster" };
  const nextId = table => { db.seq[table] = Math.max(db.seq[table] || 0, ...T(table).map(r => Number(r.id) || 0)) + 1; return db.seq[table]; };

  // ---- who is signed in --------------------------------------------------------------------
  const me = () => (db.user || "").toLowerCase() || null;
  const adminRow = () => T("admins").find(a => a.email === me());
  const isAdmin = () => !!adminRow();
  const hasPerm = p => !!adminRow() && adminRow().permissions.includes(p);
  const myAgent = () => T("agents").find(a => a.email === me());
  const myLob = () => { const a = myAgent(); return a && !a.excluded ? a.lob : null; };

  class DbError extends Error { constructor(message, code) { super(message); this.code = code || "P0001"; } }
  const fail = (message, code) => { throw new DbError(message, code); };
  const rls = table => fail(`new row violates row-level security policy for table "${table}"`, "42501");

  // ---- PostgREST-style filters, selects and embedding -----------------------------------------
  const same = (a, b) => a == null || b == null ? a == b : String(a) === String(b);
  const cmp = (a, b) => typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  const likeRe = pattern => new RegExp("^" + String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*") + "$", "i");
  const splitTop = str => {
    const out = []; let depth = 0, cur = "";
    for (const ch of str) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const parseSelect = str => splitTop(String(str || "*")).map(item => {
    const m = item.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s);
    if (m) return { embed: true, alias: m[1] || m[2], table: m[2], fk: m[3], cols: parseSelect(m[4]) };
    return item === "*" ? { all: true } : { col: item.trim() };
  });
  function project(table, row, items) {
    const out = items.some(i => i.all) ? clone(row) : {};
    for (const it of items) {
      if (it.col) out[it.col] = clone(row[it.col]);
      if (!it.embed) continue;
      const rel = REL[table] || {};
      const col = it.fk ? it.fk.replace(`${table}_`, "").replace(/_fkey$/, "") : Object.keys(rel).find(c => rel[c] === it.table);
      const target = col && row[col] != null ? T(it.table).find(r => same(r.id, row[col])) : null;
      out[it.alias] = target ? project(it.table, target, it.cols) : null;
    }
    return out;
  }
  const opTest = (op, value) => {
    switch (op) {
      case "eq": return v => same(v, value);
      case "neq": return v => !same(v, value);
      case "gt": return v => v != null && cmp(v, value) > 0;
      case "gte": return v => v != null && cmp(v, value) >= 0;
      case "lt": return v => v != null && cmp(v, value) < 0;
      case "lte": return v => v != null && cmp(v, value) <= 0;
      case "like": case "ilike": { const re = likeRe(value); return v => v != null && re.test(String(v)); }
      case "is": return v => value === null || value === "null" ? v == null : String(v) === String(value);
      case "in": { const list = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(","); return v => list.some(x => same(v, x)); }
      default: throw new DbError(`demo database: unsupported filter "${op}"`);
    }
  };

  class Query {
    constructor(table) { Object.assign(this, { table, op: "select", items: parseSelect("*"), filters: [], orders: [], from: 0, to: Infinity, one: null, head: false, count: null, payload: null, opts: {}, returning: null }); }
    select(cols = "*", opts = {}) {
      if (this.op === "select") { this.items = parseSelect(cols); this.head = !!opts.head; this.count = opts.count || null; }
      else this.returning = parseSelect(cols);
      return this;
    }
    insert(rows, opts = {}) { this.op = "insert"; this.payload = rows; this.opts = opts; return this; }
    upsert(rows, opts = {}) { this.op = "upsert"; this.payload = rows; this.opts = opts; return this; }
    update(patch) { this.op = "update"; this.payload = patch; return this; }
    delete() { this.op = "delete"; return this; }
    filter(col, op, value) { const test = opTest(op, value); this.filters.push(r => test(r[col])); return this; }
    eq(c, v) { return this.filter(c, "eq", v); } neq(c, v) { return this.filter(c, "neq", v); }
    gt(c, v) { return this.filter(c, "gt", v); } gte(c, v) { return this.filter(c, "gte", v); }
    lt(c, v) { return this.filter(c, "lt", v); } lte(c, v) { return this.filter(c, "lte", v); }
    like(c, v) { return this.filter(c, "like", v); } ilike(c, v) { return this.filter(c, "ilike", v); }
    is(c, v) { return this.filter(c, "is", v); } in(c, v) { return this.filter(c, "in", v); }
    match(obj) { for (const [c, v] of Object.entries(obj)) this.eq(c, v); return this; }
    not(col, op, value) { const test = opTest(op, value); this.filters.push(r => !test(r[col])); return this; }
    or(expr) {
      const parts = splitTop(expr).map(p => { const [col, op, ...rest] = p.split("."); return { col, test: opTest(op, rest.join(".")) }; });
      this.filters.push(r => parts.some(p => p.test(r[p.col])));
      return this;
    }
    order(col, { ascending = true, nullsFirst } = {}) { this.orders.push({ col, ascending, nullsFirst: nullsFirst ?? !ascending }); return this; }
    range(a, b) { this.from = a; this.to = b; return this; }
    limit(n) { this.to = this.from + n - 1; return this; }
    single() { this.one = "single"; return this; }
    maybeSingle() { this.one = "maybe"; return this; }
    then(resolve, reject) { return run(() => this.exec()).then(resolve, reject); }
    matching() { return T(this.table).filter(r => this.filters.every(f => f(r))); }
    exec() {
      const out = rows => {
        let data = rows;
        for (const o of [...this.orders].reverse()) {
          data = [...data].sort((a, b) => {
            const x = a[o.col], y = b[o.col];
            if (x == null || y == null) return x == y ? 0 : (x == null) === o.nullsFirst ? -1 : 1;
            return o.ascending ? cmp(x, y) : cmp(y, x);
          });
        }
        const count = data.length;
        data = data.slice(this.from, this.to + 1);
        if (this.head) return { data: null, count };
        if (this.one) {
          if (data.length > 1 || (this.one === "single" && !data.length)) fail("JSON object requested, multiple (or no) rows returned", "PGRST116");
          return { data: data[0] || null, count };
        }
        return { data, count: this.count ? count : null };
      };
      if (this.op === "select") return out(this.matching().map(r => project(this.table, r, this.items)));
      const changed = mutate(this);
      return this.returning ? out(changed.map(r => project(this.table, r, this.returning))) : { data: null, count: null };
    }
  }

  // ---- writes, with the database's triggers and constraints ------------------------------------
  function checkWrite(table) {
    if (!me()) rls(table);
    if (!hasPerm(WRITE_PERM[table])) rls(table);
  }
  function conflict(table, row, ignore) {
    const sets = [keyOf(table), ...(UNIQUE[table] || [])];
    for (const cols of sets) {
      const hit = T(table).find(r => r !== ignore && cols.every(c => same(r[c], row[c])));
      if (hit) fail(`duplicate key value violates unique constraint "${table}_${cols.join("_")}_key"`, "23505");
    }
  }
  function beforeWrite(table, op, row, old) {
    if (table === "admins") {
      if (op !== "delete") {
        row.email = String(row.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) fail("That is not a valid email address.");
      }
      if (op === "delete" && old.email === me()) fail("You cannot remove yourself as an admin.");
      if (op === "update" && old.email === me() && !(row.permissions || []).includes("admins")) fail("You cannot take away your own right to manage admins.");
    }
    if (table === "manual_assignments" && op !== "delete") {
      const agent = T("agents").find(a => same(a.id, row.agent_id)), shell = T("shift_shells").find(s => same(s.id, row.shift_id));
      if (!shell) fail("That shift shell does not exist.");
      if ((agent && agent.lob) !== shell.lob) fail(`That shell is in ${shell.lob}, but this agent is in ${agent && agent.lob}.`);
      const used = T("manual_assignments").filter(m => same(m.shift_id, row.shift_id) && !same(m.agent_id, row.agent_id)).length;
      if (used >= shell.seats) fail(`All ${shell.seats} seat(s) on that shell are already manually assigned.`);
      row.assigned_by = me(); row.assigned_at = nowIso();
    }
    if (table === "swap_windows" && op !== "insert" && old.kind === "trade") expireClosedTrades();
    if (table === "swap_windows" && op !== "delete" && !(Date.parse(row.closes_at) > Date.parse(row.opens_at))) {
      fail('new row for relation "swap_windows" violates check constraint "swap_window_closes_after_opens"', "23514");
    }
  }
  function onDelete(table, row) {
    if (table === "shift_shells") {
      for (const ref of ["bids2", "assignments", "manual_assignments"]) {
        if (T(ref).some(r => same(r.shift_id, row.id))) {
          fail(`update or delete on table "shift_shells" violates foreign key constraint "${ref}_shift_id_fkey" on table "${ref}"`, "23503");
        }
      }
      for (const ref of ["swap_requests", "shift_trades"]) for (const r of T(ref)) {
        if (same(r.requester_shift_id, row.id)) r.requester_shift_id = null;
        if (same(r.partner_shift_id, row.id)) r.partner_shift_id = null;
      }
    }
    if (table === "coaches") {
      db.tables.coach_assignments = T("coach_assignments").filter(r => !same(r.coach_id, row.id));
    }
    if (table === "agents") {
      for (const ref of ["swap_requests", "shift_trades"]) db.tables[ref] = T(ref).filter(r => !same(r.requester_id, row.id) && !same(r.partner_id, row.id));
      for (const ref of ["manual_assignments", "coach_assignments"]) db.tables[ref] = T(ref).filter(r => !same(r.agent_id, row.id));
      for (const c of T("coaches")) if (same(c.agent_id, row.id)) c.agent_id = null;
    }
  }
  function insertRow(table, given) {
    const row = { ...(DEFAULTS[table] ? DEFAULTS[table]() : {}), ...clone(given) };
    if (AUTO_ID.includes(table) && row.id == null) row.id = nextId(table);
    beforeWrite(table, "insert", row);
    conflict(table, row);
    T(table).push(row);
    return row;
  }
  function mutate(q) {
    const table = q.table;
    checkWrite(table);
    const list = q.payload == null ? [] : Array.isArray(q.payload) ? q.payload : [q.payload];
    let changed = [];
    if (q.op === "insert") changed = list.map(r => insertRow(table, r));
    if (q.op === "upsert") {
      const cols = q.opts.onConflict ? q.opts.onConflict.split(",").map(s => s.trim()) : keyOf(table);
      for (const given of list) {
        const hit = T(table).find(r => cols.every(c => same(r[c], given[c])));
        if (!hit) { changed.push(insertRow(table, given)); continue; }
        const next = { ...hit, ...clone(given) };
        beforeWrite(table, "update", next, hit);
        conflict(table, next, hit);
        Object.assign(hit, next); changed.push(hit);
      }
    }
    if (q.op === "update") {
      for (const hit of q.matching()) {
        const next = { ...hit, ...clone(q.payload) };
        beforeWrite(table, "update", next, hit);
        conflict(table, next, hit);
        Object.assign(hit, next); changed.push(hit);
      }
    }
    if (q.op === "delete") {
      changed = q.matching();
      for (const row of changed) { beforeWrite(table, "delete", null, row); onDelete(table, row); }
      const gone = new Set(changed);
      db.tables[table] = T(table).filter(r => !gone.has(r));
    }
    if (table === "swap_windows") expireClosedTrades();
    return changed;
  }

  // Every request is all-or-nothing, like a database transaction, and takes a moment like a real one.
  async function run(fn) {
    await new Promise(r => setTimeout(r, 40));
    const before = JSON.stringify(db.tables);
    try { const result = fn(); save(); return { error: null, status: 200, ...result }; }
    catch (err) {
      db.tables = JSON.parse(before);
      if (!(err instanceof DbError)) console.error(err);
      return { data: null, count: null, error: { message: err.message, code: err.code || "500", details: null, hint: null } };
    }
  }

  // ---- database functions (supabase/*.sql) ----------------------------------------------------
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const between = (w, t = Date.now()) => !!w && t >= Date.parse(w.opens_at) && t <= Date.parse(w.closes_at);
  const lobPublished = lob => T("published_results").some(p => p.lob === lob);
  const noSet = s => { if (!s) return null; const { set_name: _s, ...rest } = s; return clone(rest); };
  const shellById = id => T("shift_shells").find(s => same(s.id, id));
  const agentById = id => T("agents").find(a => same(a.id, id));
  const assignmentOf = agentId => T("assignments").find(x => same(x.agent_id, agentId));
  const window_ = (lob, kind) => T("swap_windows").find(w => w.lob === lob && w.kind === kind);
  const myTradingOpen = () => !!myLob() && between(window_(myLob(), "trade"));
  const shellWorks = (days, date) => String(days || "").replace(/ /g, "").split(",").includes(String(new Date(`${date}T00:00:00Z`).getUTCDay()));
  const fmtDay = date => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", timeZone: "UTC" }).replace(",", "");
  function expireClosedTrades() {
    let n = 0;
    for (const t of T("shift_trades")) {
      if (t.status === "pending_partner" && !between(window_(t.lob, "trade"))) { t.status = "declined"; t.auto_declined = true; t.partner_responded_at = nowIso(); n++; }
    }
    return n;
  }
  const signedInAgent = () => {
    const a = myAgent();
    if (!a) fail("Your login is not linked to an agent record.");
    if (a.excluded) fail("You are not part of this shift bid.");
    return a;
  };
  const needPerm = (p, message) => { if (!hasPerm(p)) fail(message, "42501"); };
  const board = (rows, meId) => rows.map(r => {
    const q = agentById(r.requester_id), p = agentById(r.partner_id), mine = same(r.requester_id, meId);
    const rs = noSet(shellById(r.requester_shift_id)), ps = noSet(shellById(r.partner_shift_id));
    return { ...r, mine, other_name: mine ? p && p.name : q && q.name, my_shift: mine ? rs : ps, their_shift: mine ? ps : rs };
  }).sort((a, b) => cmp(b.created_at, a.created_at));

  const RPC = {
    my_permissions: () => adminRow() ? [...adminRow().permissions] : null,
    can_assign_manually: () => hasPerm("manual"),
    my_shift_shells: () => T("shift_shells").filter(s => s.lob === myLob()).sort((a, b) => a.id - b.id).map(noSet),
    replace_assignments({ p_agent_ids, p_rows }) {
      needPerm("assign", "You do not have permission to run auto assign.");
      const ids = new Set((p_agent_ids || []).map(String));
      db.tables.assignments = T("assignments").filter(x => !ids.has(String(x.agent_id)));
      for (const r of p_rows || []) T("assignments").push({ id: nextId("assignments"), agent_id: Number(r.agent_id), shift_id: Number(r.shift_id), run_at: nowIso(), pushed_at: null, push_error: null });
    },
    replace_bid_window({ p_lob, p_opens, p_closes, p_require_full_ranking }) {
      needPerm("windows", "You do not have permission to change bid windows.");
      if (Date.parse(p_closes) <= Date.parse(p_opens)) fail("The close time must be after the open time.");
      db.tables.bid_windows = T("bid_windows").filter(w => w.lob !== p_lob);
      T("bid_windows").push({ id: nextId("bid_windows"), lob: p_lob, opens_at: new Date(p_opens).toISOString(), closes_at: new Date(p_closes).toISOString(), require_full_ranking: p_require_full_ranking !== false });
    },
    replace_my_bids({ p_bids }) {
      const a = signedInAgent();
      const w = T("bid_windows").find(x => x.lob === a.lob);
      if (!between(w)) fail("Bidding is closed for your LOB.");
      const bids = p_bids || [], n = bids.length, pr = bids.map(b => Number(b.priority));
      if (new Set(bids.map(b => String(b.shift_id))).size !== n) fail("Each shift can only be ranked once.");
      if (new Set(pr).size !== n) fail("Each rank number can only be used once.");
      if (n && Math.min(...pr) < 1) fail("Rank numbers start at 1.");
      if (n > 20) fail(`You can pick at most 20 shifts: ${n} picked.`);
      if (bids.some(b => !T("shift_shells").some(s => same(s.id, b.shift_id) && s.lob === a.lob))) fail("You can only rank shifts in your own LOB.");
      if (w.require_full_ranking) {
        const need = Math.min(20, T("shift_shells").filter(s => s.lob === a.lob).length);
        if (n !== need || (n && (Math.min(...pr) !== 1 || Math.max(...pr) !== n))) fail(`Pick and rank ${need} shifts before saving: ${n} picked.`);
      }
      db.tables.bids2 = T("bids2").filter(b => b.agent_id !== a.id);
      for (const b of bids) T("bids2").push({ id: nextId("bids2"), agent_id: a.id, shift_id: Number(b.shift_id), priority: Number(b.priority) });
      a.bid_submitted_at = n ? a.bid_submitted_at || nowIso() : null;
    },
    replace_coach_assignments({ p_lob, p_rows }) {
      needPerm("roster", "You do not have permission to change coach groups.");
      for (const r of p_rows || []) {
        const a = agentById(r.agent_id), c = T("coaches").find(x => same(x.id, r.coach_id));
        if (!a || !c || a.lob !== p_lob || c.lob !== p_lob) fail(`Every agent and coach must be in ${p_lob}.`);
      }
      const inLob = new Set(T("agents").filter(a => a.lob === p_lob).map(a => a.id));
      db.tables.coach_assignments = T("coach_assignments").filter(x => !inLob.has(x.agent_id));
      for (const r of p_rows || []) T("coach_assignments").push({ agent_id: Number(r.agent_id), coach_id: Number(r.coach_id), overlap_minutes: r.overlap_minutes ?? null, saved_at: nowIso(), saved_by: me(), synced_at: null });
    },
    my_coach() {
      const a = myAgent();
      if (!a || a.excluded || !lobPublished(a.lob)) return null;
      if (!T("coach_lob_settings").some(s => s.lob === a.lob && s.coaches_published_at)) return null;
      const x = T("coach_assignments").find(r => r.agent_id === a.id), c = x && T("coaches").find(k => k.id === x.coach_id && k.lob === a.lob);
      return c ? { name: c.name } : null;
    },
    my_coach_agents() {
      const a = myAgent();
      if (!a || a.excluded) return null;
      const c = T("coaches").find(k => same(k.agent_id, a.id));
      if (!c) return null;
      if (!T("coach_lob_settings").some(s => s.lob === c.lob && s.coaches_published_at)) return { lob: c.lob, published: false, agents: [] };
      const agents = T("coach_assignments").filter(x => x.coach_id === c.id).map(x => agentById(x.agent_id))
        .filter(p => p && !p.excluded && p.lob === c.lob).sort((x, y) => cmp(x.name, y.name)).map(p => {
          const s = shellById((assignmentOf(p.id) || {}).shift_id);
          const shift = s ? (({ set_name: _a, seats: _b, id: _c, lob: _d, ...rest }) => rest)(s) : null;
          return { name: p.name, shift };
        });
      return { lob: c.lob, published: true, agents };
    },
    swap_board() {
      const a = myAgent();
      if (!a || a.excluded) return null;
      const meRow = { id: a.id, name: a.name, lob: a.lob, shift: null };
      if (!lobPublished(a.lob)) return { published: false, me: meRow, colleagues: [], requests: [] };
      const w = window_(a.lob, "swap");
      meRow.shift = noSet(shellById((assignmentOf(a.id) || {}).shift_id));
      const colleagues = T("agents").filter(p => p.lob === a.lob && !p.excluded && p.id !== a.id && assignmentOf(p.id))
        .map(p => ({ id: p.id, name: p.name, shift: noSet(shellById(assignmentOf(p.id).shift_id)) })).filter(c => c.shift).sort((x, y) => cmp(x.name, y.name));
      return { published: true, window: w ? { opens_at: w.opens_at, closes_at: w.closes_at, open: between(w) } : null, me: meRow, colleagues,
        requests: board(T("swap_requests").filter(r => r.requester_id === a.id || r.partner_id === a.id), a.id) };
    },
    expire_closed_trades: () => expireClosedTrades(),
    trade_board() {
      expireClosedTrades();
      const a = myAgent();
      if (!a || a.excluded) return null;
      if (!lobPublished(a.lob)) return { published: false, window: null, pushed: false, trades: [] };
      const w = window_(a.lob, "trade");
      return { published: true, window: w ? { opens_at: w.opens_at, closes_at: w.closes_at, open: between(w) } : null,
        pushed: !!(assignmentOf(a.id) || {}).pushed_at,
        trades: board(T("shift_trades").filter(t => t.requester_id === a.id || t.partner_id === a.id), a.id) };
    },
    request_trade({ p_partner_id, p_note }) {
      const a = signedInAgent();
      if (!lobPublished(a.lob)) fail(`The ${a.lob} results are not published yet.`);
      if (!myTradingOpen()) fail(`Shift trades are not open for ${a.lob} right now.`);
      const p = agentById(p_partner_id);
      if (p && p.id === a.id) fail("You cannot trade with yourself.");
      if (!p || p.excluded || p.lob !== a.lob) fail("You can only trade with someone in your own LOB.");
      const mine = (assignmentOf(a.id) || {}).shift_id, theirs = (assignmentOf(p.id) || {}).shift_id;
      if (mine == null) fail("You do not have an assigned shift to trade yet.");
      if (theirs == null) fail(`${p.name} does not have an assigned shift yet.`);
      if (mine === theirs) fail(`You and ${p.name} have the same shift, so there is nothing to trade.`);
      if (!!assignmentOf(a.id).pushed_at !== !!assignmentOf(p.id).pushed_at) fail(`Your schedule and ${p.name}'s are not both in Assembled yet, so you cannot trade right now. Ask your admin.`);
      if (T("shift_trades").some(t => ["pending_partner", "pending_admin"].includes(t.status) && [t.requester_id, t.partner_id].some(x => x === a.id || x === p.id))) {
        fail(`You or ${p.name} already have a shift trade waiting. Finish or cancel it first.`);
      }
      return insertRow("shift_trades", { lob: a.lob, requester_id: a.id, partner_id: p.id, requester_shift_id: mine, partner_shift_id: theirs, note: (p_note || "").trim() || null }).id;
    },
    respond_trade({ p_id, p_accept }) {
      const a = T("agents").find(x => x.email === me() && !x.excluded);
      if (p_accept && !lobPublished(myLob())) fail("Your results are not published yet.");
      if (p_accept && !myTradingOpen()) fail("Shift trades are not open right now, so this trade cannot be accepted. You can still decline it.");
      const t = T("shift_trades").find(x => same(x.id, p_id) && a && x.partner_id === a.id && x.status === "pending_partner");
      if (!t) fail("This trade request is no longer waiting for you.");
      t.status = p_accept ? "pending_admin" : "declined"; t.partner_responded_at = nowIso();
    },
    cancel_trade({ p_id }) {
      const a = myAgent(), t = T("shift_trades").find(x => same(x.id, p_id) && a && x.requester_id === a.id && ["pending_partner", "pending_admin"].includes(x.status));
      if (!t) fail("This trade can no longer be cancelled.");
      t.status = "cancelled";
    },
    decide_trade({ p_id, p_approve, p_note }) {
      needPerm("swaps", "You do not have permission to approve or reject trades.");
      const t = T("shift_trades").find(x => same(x.id, p_id));
      if (!t) fail("That trade does not exist.");
      if (t.status !== "pending_admin") fail("This trade is not waiting for approval any more.");
      if (p_approve) {
        const A = assignmentOf(t.requester_id), B = assignmentOf(t.partner_id);
        if (!A || !B) fail("One of these agents no longer has an assigned shift. Reject this trade.");
        if (A.shift_id !== t.requester_shift_id || B.shift_id !== t.partner_shift_id) {
          fail("Their assigned shifts have changed since they asked (auto assign was re-run or another trade was approved). Reject this trade and ask them to request it again.");
        }
        if (A.pushed_at || B.pushed_at) fail("Their schedules are already in Assembled. Pick the date the new shifts start, then use Preview changes and Approve trade.");
        A.shift_id = t.partner_shift_id; B.shift_id = t.requester_shift_id;
      }
      Object.assign(t, { status: p_approve ? "approved" : "rejected", decided_at: nowIso(), decided_by: me(), admin_note: (p_note || "").trim() || null });
    },
    request_swap: () => fail("Day swaps now swap a work day for a day off. Refresh the page and try again."),
    request_day_swap({ p_partner_id, p_give, p_take, p_note }) {
      const a = signedInAgent();
      if (!lobPublished(a.lob)) fail(`The ${a.lob} results are not published yet.`);
      const p = agentById(p_partner_id);
      if (p && p.id === a.id) fail("You cannot swap with yourself.");
      if (!p || p.excluded || p.lob !== a.lob) fail("You can only swap with someone in your own LOB.");
      const mine = (assignmentOf(a.id) || {}).shift_id, theirs = (assignmentOf(p.id) || {}).shift_id;
      if (mine == null) fail("You do not have an assigned shift to swap yet.");
      if (theirs == null) fail(`${p.name} does not have an assigned shift yet.`);
      if (mine === theirs) fail(`You and ${p.name} have the same shift, so there is nothing to swap.`);
      const myDays = shellById(mine).days, theirDays = shellById(theirs).days;
      if (!p_give || !p_take || p_give === p_take) fail("Pick two different days.");
      const yesterday = (() => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
      if ((p_give < p_take ? p_give : p_take) < yesterday) fail("The swap cannot be in the past.");
      if (coaching.mondayFrom(p_give) !== coaching.mondayFrom(p_take)) fail("Both days must be in the same Monday-to-Sunday week, so your weekly hours stay the same.");
      if (!shellWorks(myDays, p_give)) fail(`You are not scheduled on ${fmtDay(p_give)}. The day you give must be one of your work days.`);
      if (shellWorks(theirDays, p_give)) fail(`${p.name} also works on ${fmtDay(p_give)}, so they cannot take it.`);
      if (shellWorks(myDays, p_take)) fail(`You already work on ${fmtDay(p_take)}. The day you take must be one of your days off.`);
      if (!shellWorks(theirDays, p_take)) fail(`${p.name} is off on ${fmtDay(p_take)} too, so there is no shift to take.`);
      const days = [p_give, p_take];
      if (T("swap_requests").some(r => ["pending_partner", "pending_admin", "approved"].includes(r.status)
        && [r.requester_id, r.partner_id].some(x => x === a.id || x === p.id)
        && (r.give_date ? days.includes(r.give_date) || days.includes(r.take_date) : r.start_date <= days.sort()[1] && r.end_date >= days.sort()[0]))) {
        fail(`You or ${p.name} already have a swap on one of these days.`);
      }
      return insertRow("swap_requests", { lob: a.lob, requester_id: a.id, partner_id: p.id, requester_shift_id: mine, partner_shift_id: theirs,
        start_date: p_give < p_take ? p_give : p_take, end_date: p_give < p_take ? p_take : p_give, give_date: p_give, take_date: p_take, note: (p_note || "").trim() || null }).id;
    },
    respond_swap({ p_id, p_accept }) {
      const a = T("agents").find(x => x.email === me() && !x.excluded);
      if (p_accept && !lobPublished(myLob())) fail("Your results are not published yet.");
      const r = T("swap_requests").find(x => same(x.id, p_id) && a && x.partner_id === a.id && x.status === "pending_partner");
      if (!r) fail("This swap request is no longer waiting for you.");
      r.status = p_accept ? "pending_admin" : "declined"; r.partner_responded_at = nowIso();
    },
    cancel_swap({ p_id }) {
      const a = myAgent(), r = T("swap_requests").find(x => same(x.id, p_id) && a && x.requester_id === a.id && ["pending_partner", "pending_admin"].includes(x.status));
      if (!r) fail("This swap can no longer be cancelled.");
      r.status = "cancelled";
    },
    assign_open_seat({ p_agent_id, p_shift_id }) {
      needPerm("manual", "You do not have permission to assign shifts directly.");
      const a = agentById(p_agent_id), s = shellById(p_shift_id);
      if (!a || a.excluded) fail("That agent is not part of the shift bid.");
      if (!s) fail("That shift shell does not exist.");
      if (s.lob !== a.lob) fail(`That shell is in ${s.lob}, but ${a.name} is in ${a.lob}.`);
      if (assignmentOf(a.id)) fail(`${a.name} already has an assigned shift.`);
      if (taken(s.id) >= s.seats) fail("That shell has no open seats left. Pick another.");
      T("assignments").push({ id: nextId("assignments"), agent_id: a.id, shift_id: s.id, run_at: nowIso(), pushed_at: null, push_error: null });
      keepManual(a.id, s.id);
    },
    move_to_open_seat({ p_agent_id, p_shift_id, p_pushed_ok }) {
      needPerm("manual", "You do not have permission to assign shifts directly.");
      const a = agentById(p_agent_id), s = shellById(p_shift_id);
      if (!a || a.excluded) fail("That agent is not part of the shift bid.");
      if (!s) fail("That shift shell does not exist.");
      if (s.lob !== a.lob) fail(`That shell is in ${s.lob}, but ${a.name} is in ${a.lob}.`);
      const cur = assignmentOf(a.id);
      if (!cur) fail(`${a.name} has no shift yet. Use Give open seat instead.`);
      if (cur.shift_id === s.id) fail(`${a.name} is already on that shell.`);
      if (cur.pushed_at && !p_pushed_ok) fail(`${a.name}'s schedule is already in Assembled. Delete their shifts there first, then move them and push again.`);
      const waiting = rows => rows.some(r => ["pending_partner", "pending_admin"].includes(r.status) && (r.requester_id === a.id || r.partner_id === a.id));
      if (waiting(T("shift_trades")) || waiting(T("swap_requests"))) fail(`${a.name} has a trade or day swap waiting. Reject it or have it cancelled first.`);
      if (T("swap_requests").some(r => r.status === "approved" && (r.requester_id === a.id || r.partner_id === a.id)
        && [r.give_date || r.end_date, r.take_date || r.end_date].sort()[1] >= today())) {
        fail(`${a.name} has an approved day swap still to come, set up from their current shift. Move them after it.`);
      }
      if (taken(s.id) >= s.seats) fail("That shell has no open seats left. Pick another.");
      Object.assign(cur, { shift_id: s.id, pushed_at: null, push_error: null });
      keepManual(a.id, s.id);
    },
  };
  const taken = shellId => T("assignments").filter(x => x.shift_id === shellId && !(agentById(x.agent_id) || {}).excluded).length;
  const keepManual = (agentId, shellId) => {
    const m = T("manual_assignments").find(x => x.agent_id === agentId);
    if (m) Object.assign(m, { shift_id: shellId, assigned_by: me(), assigned_at: nowIso() });
    else T("manual_assignments").push({ agent_id: agentId, shift_id: shellId, assigned_by: me(), assigned_at: nowIso() });
  };

  // ---- sign-in ---------------------------------------------------------------------------------
  const onRoster = email => T("agents").find(a => a.email === email) || T("admins").find(a => a.email === email);
  const auth = {
    async getUser() { return { data: { user: me() ? { id: me(), email: me() } : null }, error: null }; },
    async getSession() { return { data: { session: me() ? { access_token: "demo-session", user: { email: me() } } : null }, error: null }; },
    async signInWithPassword({ email, password }) {
      await new Promise(r => setTimeout(r, 150));
      email = String(email || "").toLowerCase();
      if (!password || !onRoster(email) || db.logins[email] !== "active") return { data: null, error: { message: "Invalid login credentials" } };
      db.user = email; save();
      return { data: { user: { email } }, error: null };
    },
    async signOut() { db.user = null; save(); return { error: null }; },
    async updateUser() { return { data: { user: { email: me() } }, error: null }; },
  };

  window.supabase = {
    createClient: () => ({
      auth,
      from: table => new Query(table),
      rpc: (fn, args = {}) => run(() => {
        if (!RPC[fn]) fail(`Could not find the function public.${fn} in the schema cache`, "PGRST202");
        if (!me()) fail("Not signed in", "42501");
        return { data: clone(RPC[fn](args) ?? null) };
      }),
    }),
  };

  // ---- /api/* (api/*.js), with a fake Assembled behind them ----------------------------------------
  const A = () => db.assembled;
  const typeName = () => Object.fromEntries(A().activityTypes.map(x => [x.id, x.name]));
  const eventsOf = (asmId, from = -Infinity, to = Infinity) => A().events.filter(e => e.agent_id === asmId && e.end_time > from && e.start_time < to);
  const newEvent = e => ({ id: `ev-${A().nextEvent++}`, ...e });
  const LOB_TEAMS = ["Sales", "Support", "Retention", "Billing"];

  // Permanent shift trades after the push: lib/tradeAfterPush.js on the fake Assembled (no Zoho here).
  function tradeAfterPush({ action, id, startDate, note }) {
    if (action === "approve" && !hasPerm("swaps")) return [403, { error: "You do not have permission to approve trades. You can still preview them." }];
    if (!["preview", "approve"].includes(action)) return [400, { error: "Need an action (preview or approve) and a trade id." }];
    const addD = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || ""))) return [400, { error: "Pick the date the new shifts start." }];
    if (new Date(`${startDate}T00:00:00Z`).getUTCDay() !== 1) return [400, { error: "The new shifts start on a Monday, the first day of a work week. Pick a Monday." }];
    if (startDate <= today()) return [400, { error: "Pick a Monday after today: days that have started are not changed." }];
    const t = T("shift_trades").find(x => same(x.id, id));
    if (!t) return [404, { error: "Trade not found." }];
    if (t.status !== "pending_admin") return [409, { error: `This trade is not waiting for approval any more (it is ${t.status.replace("_", " ")}).` }];
    const A_ = agentById(t.requester_id), B_ = agentById(t.partner_id), shA = shellById(t.requester_shift_id), shB = shellById(t.partner_shift_id);
    if (!shA || !shB) return [409, { error: "One of the shifts in this trade has been deleted. Reject it." }];
    const xA = assignmentOf(A_.id), xB = assignmentOf(B_.id);
    if (!xA || !xB || xA.shift_id !== t.requester_shift_id || xB.shift_id !== t.partner_shift_id) {
      return [409, { error: "Their assigned shifts have changed since they asked (auto assign was re-run or another trade was approved). Reject this trade and ask them to request it again." }];
    }
    if (!xA.pushed_at || !xB.pushed_at) return [409, { error: "Both schedules must be in Assembled first." }];
    const sides = [{ who: "A", person: A_, oldShell: shA, newShell: shB }, { who: "B", person: B_, oldShell: shB, newShell: shA }];
    const issues = [], warnings = [];
    for (const s of T("swap_requests").filter(r => ["pending_partner", "pending_admin", "approved"].includes(r.status) && r.end_date >= startDate
      && [r.requester_id, r.partner_id].some(x => x === A_.id || x === B_.id))) {
      const names = [A_, B_].filter(p => [s.requester_id, s.partner_id].includes(p.id)).map(p => p.name).join(" and ");
      const verb = names.includes(" and ") ? "have" : "has", days = `${schedule.niceDate(s.give_date)} and ${schedule.niceDate(s.take_date)}`;
      issues.push(s.status === "approved" ? `${names} ${verb} an approved day swap on ${days}, which used the old shifts. Pick a start date after it.`
        : `${names} ${verb} a day swap waiting on ${days}. Reject or approve it first, or pick a start date after it.`);
    }
    const lastDate = addD(startDate, 83);
    const from = Math.floor(Date.parse(`${addD(startDate, -15)}T00:00:00Z`) / 1000), to = Math.floor(Date.parse(`${addD(lastDate, 2)}T00:00:00Z`) / 1000);
    const typeOf = Object.fromEntries(A().activityTypes.map(x => [x.id, x])), tn = tid => (typeOf[tid] || {}).name || "Unknown type";
    const kind = tid => /break/i.test(tn(tid)) ? "break" : /lunch/i.test(tn(tid)) ? "lunch" : !typeOf[tid] ? "other" : typeOf[tid].timeoff ? "timeoff" : typeOf[tid].productive ? "work" : "other";
    for (const s of sides) {
      s.activities = eventsOf(s.person.assembled_agent_id, from, to);
      const last = schedule.pushedThrough({ shell: s.oldShell, startDate, endDate: lastDate, activities: s.activities, kind });
      s.through = last && [addD(last, (7 - new Date(`${last}T00:00:00Z`).getUTCDay()) % 7), lastDate].sort()[0];
      const count = {};
      for (const date of s.through ? schedule.eachDate(startDate, s.through) : []) {
        const win = schedule.shellWindow(s.oldShell, date);
        if (win) for (const a of schedule.chainAround(s.activities, win)) if (kind(a.type_id) === "work") count[a.type_id] = (count[a.type_id] || 0) + (a.end_time - a.start_time);
      }
      s.shiftTypeId = Object.keys(count).sort((x, y) => count[y] - count[x])[0] || null;
    }
    for (const s of sides) if (!s.shiftTypeId) s.shiftTypeId = (sides.find(o => o.shiftTypeId) || {}).shiftTypeId || null;
    for (const s of sides) {
      const days = String(s.newShell.days || "").split(",").filter(x => x.trim() !== "").length;
      s.plan = schedule.planShiftChange({ oldShell: s.oldShell, newShell: s.newShell, startDate, endDate: s.through, activities: s.activities,
        kind, shiftTypeId: s.shiftTypeId, maxRun: Math.min(13, days + 1), name: s.person.name });
      issues.push(...s.plan.issues);
      if (!s.through) warnings.push(`${s.person.name} has no shifts in Assembled from ${schedule.niceDate(startDate)}, so nothing changes there for them. The next push uses their new shift.`);
    }
    const summary = { trade: true, id: t.id, startDate, issues, warnings,
      people: sides.map(s => ({ name: s.person.name, from: noSet(s.oldShell), to: noSet(s.newShell), through: s.through,
        removed: s.plan.removedDays, added: s.plan.addedDays, moves: s.plan.moves, droppedBreaks: s.plan.droppedBreaks, kept: s.plan.kept.length, notes: s.plan.notes,
        outside: s.plan.outside.map(o => ({ ...o, type: tn(o.type_id) })),
        conflicts: s.plan.conflicts.map(c => ({ date: c.date, found: c.found.map(tn).join(", ") })), shiftType: s.shiftTypeId ? tn(s.shiftTypeId) : null })),
      zoho: { off: "Zoho is not connected in the demo." } };
    if (action === "preview") return { preview: true, ...summary };
    if (issues.length) return [409, { error: "This trade has issues to sort out first.", ...summary }];
    for (const s of sides) {
      const asmId = s.person.assembled_agent_id;
      A().events = A().events.filter(e => !(e.agent_id === asmId && s.plan.deletes.some(d => e.start_time >= d.start && e.end_time <= d.end)));
      for (const e of [...s.plan.shifts, ...s.plan.kept]) A().events.push(newEvent({ agent_id: asmId, type_id: e.type_id, start_time: e.start_time, end_time: e.end_time,
        ...(e.description ? { description: e.description } : {}) }));
    }
    xA.shift_id = t.partner_shift_id; xB.shift_id = t.requester_shift_id;
    Object.assign(t, { status: "approved", start_date: startDate, decided_at: nowIso(), decided_by: me(), admin_note: (note || "").trim() || null,
      result: { removed: sides.reduce((n, s) => n + s.plan.removedDays.length, 0), added: sides.reduce((n, s) => n + s.plan.addedDays.length, 0) } });
    return { ok: true, status: "approved", ...summary };
  }

  const API = {
    "config": () => ({ url: "demo", anonKey: "demo", adminEmails: T("admins").map(a => a.email) }),
    "setup-account"({ email, password, action }) {
      email = String(email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [400, { error: "Enter a valid email address." }];
      const agent = T("agents").find(a => a.email === email), admin = T("admins").some(a => a.email === email);
      if (!agent && !admin) return { status: "not_found" };
      if (agent && agent.excluded && !admin) return { status: "removed" };
      const login = db.logins[email];
      if (action === "check") return login === "active" ? { status: "has_account" } : { status: "can_setup", reason: login === "reset" ? "reset" : "new" };
      if (action !== "setup") return [400, { error: "Unknown action." }];
      if (login === "active") return [409, { error: "You already have an account. Sign in with your password, or ask your admin to reset it." }];
      if (String(password || "").length < 8) return [400, { error: "Your password must be at least 8 characters." }];
      db.logins[email] = "active";
      return { ok: true };
    },
    "accounts"(body, method) {
      if (!isAdmin()) return [403, { error: "Admins only" }];
      if (method === "GET") return { accounts: clone(db.logins) };
      if (!hasPerm("roster")) return [403, { error: "You do not have permission to reset logins." }];
      const emails = [...new Set(((body && body.emails) || []).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
      if (emails.includes(me())) return [400, { error: "You cannot reset your own login here. Use Change password instead." }];
      let reset = 0; const noLogin = [];
      for (const e of emails) { if (db.logins[e]) { db.logins[e] = "reset"; reset++; } else noLogin.push(e); }
      return { reset, noLogin };
    },
    "activity-types": () => isAdmin() ? { activity_types: clone(A().activityTypes).sort((a, b) => cmp(a.name, b.name)) } : [403, { error: "Admins only" }],
    "sync-assembled"() {
      if (!isAdmin()) return [403, { error: "Admins only" }];
      if (!hasPerm("roster")) return [403, { error: "You do not have permission to sync the roster." }];
      const byId = Object.fromEntries(A().teams.map(x => [x.id, x]));
      const lobOfTeam = tid => {
        let x = byId[tid];
        for (let i = 0; x && x.parent_id && byId[x.parent_id] && i < 10; i++) x = byId[x.parent_id];
        const root = String((x && x.name) || ""), coachOf = root.replace(/ Coaches$/, "");
        return LOB_TEAMS.includes(root) ? { lob: root, coach: false } : coachOf !== root && LOB_TEAMS.includes(coachOf) ? { lob: coachOf, coach: true } : null;
      };
      const lobFor = ids => {
        const regular = {}, all = {};
        for (const tid of ids || []) { const h = lobOfTeam(tid); if (!h) continue; all[h.lob] = (all[h.lob] || 0) + 1; if (!h.coach) regular[h.lob] = (regular[h.lob] || 0) + 1; }
        let c = Object.keys(regular);
        if (c.length === 1) return c[0];
        if (!c.length) c = Object.keys(all);
        if (!c.length) return "Unassigned";
        const ranked = c.sort((a, b) => all[b] - all[a]);
        return ranked.length > 1 && all[ranked[0]] === all[ranked[1]] ? "Multiple LOBs" : ranked[0];
      };
      const rows = A().people.filter(p => !p.deleted && p.email).map(p => ({ assembled_id: String(p.id), assembled_agent_id: p.agent_id || null,
        name: [p.first_name, p.last_name].filter(Boolean).join(" "), email: p.email.toLowerCase(), lob: lobFor(p.teams) }));
      for (const r of rows) {
        const hit = T("agents").find(a => a.email === r.email);
        if (!hit) insertRow("agents", r);
        else Object.assign(hit, hit.lob_locked ? (({ lob: _l, ...x }) => x)(r) : r);
      }
      return { synced: rows.length, lobs: [...new Set(rows.map(r => r.lob))].sort(), missingAgentId: rows.filter(r => !r.assembled_agent_id).length,
        removed: T("agents").filter(a => a.excluded).length };
    },
    "apply-schedules"(body) {
      if (!isAdmin()) return [403, { error: "Admins only" }];
      const { lob, startDate, endDate, typeId, dryRun } = body || {};
      if (!dryRun && !hasPerm("push")) return [403, { error: "You do not have permission to push schedules to Assembled. You can still preview." }];
      if (!lob || !startDate || !endDate || !typeId) return [400, { error: "Need lob, startDate, endDate and typeId." }];
      const transition = body.transition ? { limits: {} } : null;
      if (transition) {
        for (const [days, most] of Object.entries(body.transition.limits || {})) {
          const n = Number(most);
          if (!Number.isInteger(n) || n < 1 || n > 13) return [400, { error: "Days in a row must be a whole number from 1 to 13." }];
          transition.limits[Number(days)] = n;
        }
        const start = new Date(`${startDate}T00:00:00Z`), sunday = new Date(start); sunday.setUTCDate(sunday.getUTCDate() + 6);
        if (start.getUTCDay() !== 1) return [400, { error: "With the transition week on, the From date must be a Monday (the first day of the new work week)." }];
        if (endDate < sunday.toISOString().slice(0, 10)) return [400, { error: "With the transition week on, push at least the whole first week: To must be the Sunday after From or later." }];
      }
      const maxRunFor = s => { const n = String(s.days || "").split(",").filter(x => x.trim() !== "").length; return transition.limits[n] || Math.min(13, n + 1); };
      const only = body.agentIds != null ? new Set(body.agentIds.map(Number)) : null;
      if (only && !only.size) return [400, { error: "Pick at least one agent to update." }];
      if (new Date(startDate) > new Date(endDate)) return [400, { error: "End date must be on or after start date." }];
      const rows = T("assignments").map(x => ({ ...x, agents: agentById(x.agent_id), shift_shells: shellById(x.shift_id) }))
        .filter(x => x.agents && x.shift_shells && x.agents.lob === lob && !x.agents.excluded && (!only || only.has(x.agent_id)));
      if (!rows.length) return { error: only ? `None of the selected agents have a saved ${lob} assignment. Run auto-assign first, or pick again.` : `No saved assignments found for ${lob}. Run auto-assign first.` };
      const swapDays = {}, setDay = (id, date, works) => (swapDays[id] ||= new Map()).set(date, works);
      for (const s of T("swap_requests").filter(r => r.status === "approved" && r.lob === lob && r.start_date <= endDate && r.end_date >= startDate)) {
        if (s.give_date) { setDay(s.requester_id, s.give_date, false); setDay(s.requester_id, s.take_date, true); setDay(s.partner_id, s.give_date, true); setDay(s.partner_id, s.take_date, false); }
      }
      const daySwapped = (id, date) => !!swapDays[id] && swapDays[id].has(date);
      const worksOn = (id, date, own) => daySwapped(id, date) ? swapDays[id].get(date) : !!schedule.shellWindow(own, date);
      let swapDaysSkipped = 0;
      const names = typeName(), timeOff = new Set(A().activityTypes.filter(x => x.timeoff).map(x => x.id));
      const dayStart = date => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
      const lookFrom = dayStart(startDate) - (transition ? 15 : 1) * 86400, lookTo = dayStart(endDate) + 2 * 86400;
      const existing = {};
      for (const r of rows) if (r.agents.assembled_agent_id) existing[r.agents.assembled_agent_id] = eventsOf(r.agents.assembled_agent_id, lookFrom, lookTo);
      const tOut = {}, tAdd = {}, transitionMoves = [], transitionShort = [], transitionCovered = [];
      if (transition) {
        for (const row of rows.filter(r => r.agents.assembled_agent_id)) {
          const tz = row.shift_shells.timezone, mine = existing[row.agents.assembled_agent_id] || [];
          const worked = schedule.workedDates(mine, tz, () => false);
          const pto = new Set(mine.filter(a => timeOff.has(a.type_id)).map(a => schedule.localDate(a.start_time, tz)));
          const busy = new Set(mine.filter(a => !timeOff.has(a.type_id)).map(a => schedule.localDate(a.start_time, tz)));
          const limit = maxRunFor(row.shift_shells);
          const plan = schedule.planTransitionWeek({ weekStart: startDate, maxRun: limit, priorStreak: schedule.streakBefore(worked, startDate),
            works: date => worksOn(row.agent_id, date, row.shift_shells), timeOff: date => pto.has(date), busy: date => busy.has(date) });
          if (plan.moves.length || plan.dropped.length || plan.covered.length) {
            tOut[row.agent_id] = new Set([...plan.moves.map(m => m.from), ...plan.dropped, ...plan.covered.map(c => c.date)]);
            tAdd[row.agent_id] = plan.moves.map(m => ({ date: m.to, from: m.from }));
            const inARow = plan.firstBreak.inARow;
            for (const m of plan.moves) transitionMoves.push({ name: row.agents.name, from: m.from, to: m.to, inARow, limit });
            for (const c of plan.covered) transitionCovered.push({ name: row.agents.name, date: c.date, pto: c.by });
            for (const d of plan.dropped) transitionShort.push({ name: row.agents.name, date: d, inARow, limit });
          }
        }
      }
      const activities = [], skipped = [], withShifts = new Set();
      for (const row of rows) {
        const agent = row.agents, s = row.shift_shells;
        if (!agent.assembled_agent_id) { skipped.push(`${agent.name}: no Assembled agent id, re-run the sync`); continue; }
        for (const date of schedule.eachDate(startDate, endDate)) {
          if (tOut[row.agent_id] && tOut[row.agent_id].has(date)) continue;
          if (daySwapped(row.agent_id, date)) { swapDaysSkipped++; continue; }
          const win = schedule.shellWindow(s, date);
          if (!win) continue;
          activities.push({ agent_id: agent.assembled_agent_id, type_id: typeId, start_time: win.start, end_time: win.end, row: row.id });
        }
        for (const add of tAdd[row.agent_id] || []) {
          if (add.date < startDate || add.date > endDate || daySwapped(row.agent_id, add.date)) continue;
          const win = schedule.shellWindow({ ...s, days: "0,1,2,3,4,5,6" }, add.date);
          if (win) activities.push({ agent_id: agent.assembled_agent_id, type_id: typeId, start_time: win.start, end_time: win.end, row: row.id });
        }
      }
      if (!activities.length) return { created: 0, skipped, transitionMoves, transitionShort, transitionCovered, swapDaysSkipped, note: "No shifts fell inside that date range." };
      const nameOf = Object.fromEntries(rows.map(r => [r.agents.assembled_agent_id, r.agents.name]));
      const tzOf = Object.fromEntries(rows.map(r => [r.agents.assembled_agent_id, r.shift_shells.timezone]));
      const toCreate = [], conflicts = []; let alreadyInAssembled = 0;
      for (const a of activities) {
        const mine = existing[a.agent_id] || [];
        if (mine.some(x => x.type_id === typeId && x.start_time === a.start_time && x.end_time === a.end_time)) { alreadyInAssembled++; continue; }
        const overlap = mine.filter(x => x.start_time < a.end_time && x.end_time > a.start_time);
        if (overlap.length) { conflicts.push({ name: nameOf[a.agent_id], date: schedule.localDate(a.start_time, tzOf[a.agent_id]), found: [...new Set(overlap.map(x => names[x.type_id] || "Another event"))].join(", ") }); continue; }
        toCreate.push(a);
      }
      conflicts.sort((x, y) => cmp(x.date, y.date) || cmp(x.name, y.name));
      if (dryRun) {
        return { dryRun: true, wouldCreate: toCreate.length, alreadyInAssembled, conflicts, skipped, transitionMoves, transitionShort, transitionCovered, swapDaysSkipped,
          preview: toCreate.slice(0, 5).map(a => ({ agent_id: a.agent_id, name: nameOf[a.agent_id], start: new Date(a.start_time * 1000).toISOString(), end: new Date(a.end_time * 1000).toISOString() })) };
      }
      for (const a of toCreate) A().events.push(newEvent({ agent_id: a.agent_id, type_id: a.type_id, start_time: a.start_time, end_time: a.end_time }));
      const done = new Set(activities.map(a => a.row));
      for (const x of T("assignments")) if (done.has(x.id)) { x.pushed_at = nowIso(); x.push_error = null; }
      const note = toCreate.length ? undefined : conflicts.length
        ? "Nothing new was created: every shift in this range is either already in Assembled or skipped because the agent already has something there at that time."
        : "Every shift in this range is already in Assembled. Nothing new was created.";
      return { created: toCreate.length, alreadyInAssembled, conflicts, skipped, transitionMoves, transitionShort, transitionCovered, swapDaysSkipped, errors: [], note };
    },
    "swaps"(body) {
      if (!isAdmin()) return [403, { error: "Admins only" }];
      if (body && body.trade) return tradeAfterPush(body);
      const { action, id, note } = body || {};
      if (["approve", "reject"].includes(action) && !hasPerm("swaps")) return [403, { error: "You do not have permission to approve or reject swaps. You can still preview them." }];
      const swap = T("swap_requests").find(r => same(r.id, id));
      if (!swap) return [404, { error: "Swap not found." }];
      if (swap.status !== "pending_admin") return [409, { error: `This swap is not waiting for approval any more (it is ${swap.status.replace("_", " ")}).` }];
      const decided = { decided_at: nowIso(), decided_by: me(), admin_note: (note || "").trim() || null };
      if (action === "reject") { Object.assign(swap, { status: "rejected", ...decided }); return { ok: true, status: "rejected" }; }
      const A_ = agentById(swap.requester_id), B_ = agentById(swap.partner_id), shellA = shellById(swap.requester_shift_id), shellB = shellById(swap.partner_shift_id);
      if (!shellA || !shellB) return [409, { error: "One of the shifts in this swap has been deleted." }];
      if (A_.excluded || B_.excluded) return [409, { error: `${A_.excluded ? A_.name : B_.name} has been removed from bidding.` }];
      const notPushed = [A_, B_].filter(p => !(assignmentOf(p.id) || {}).pushed_at);
      if (notPushed.length) return [409, { error: `${notPushed.map(p => p.name).join(" and ")} ${notPushed.length === 1 ? "is" : "are"} not in Assembled yet. Push the schedule first, then approve day swaps.` }];
      const days = [swap.give_date, swap.take_date];
      if (T("swap_requests").some(o => o !== swap && ["pending_partner", "pending_admin", "approved"].includes(o.status)
        && [o.requester_id, o.partner_id].some(x => x === A_.id || x === B_.id) && (days.includes(o.give_date) || days.includes(o.take_date)))) {
        return [409, { error: `${A_.name} or ${B_.name} already has another swap on ${days.join(" or ")}.` }];
      }
      const from = Math.floor(Date.parse(`${days.slice().sort()[0]}T00:00:00Z`) / 1000) - 2 * 86400, to = Math.floor(Date.parse(`${days.slice().sort()[1]}T00:00:00Z`) / 1000) + 3 * 86400;
      const actA = eventsOf(A_.assembled_agent_id, from, to), actB = eventsOf(B_.assembled_agent_id, from, to);
      const names = typeName(), swapType = A().activityTypes.find(x => /^shift swap$/i.test(x.name));
      const plan = schedule.planRestDaySwap({ giveDate: swap.give_date, takeDate: swap.take_date, shellA, shellB, activitiesA: actA, activitiesB: actB,
        nameA: A_.name, nameB: B_.name, swapTypeId: swapType.id, keepType: tid => /break|lunch/i.test(names[tid] || "") });
      const events = l => l.map(a => ({ start: a.start_time, end: a.end_time, type: names[a.type_id] || "Unknown type" }));
      const summary = { date: swap.give_date, restDay: true, giveDate: swap.give_date, takeDate: swap.take_date,
        requester: { name: A_.name, timezone: shellA.timezone }, partner: { name: B_.name, timezone: shellB.timezone },
        a: { removed: events(plan.blockA), added: events(plan.toA), removedDate: swap.give_date, addedDate: swap.take_date },
        b: { removed: events(plan.blockB), added: events(plan.toB), removedDate: swap.take_date, addedDate: swap.give_date }, issues: plan.issues };
      if (action === "preview") return { preview: true, ...summary };
      if (plan.issues.length) return [409, { error: "This swap has issues to sort out first.", ...summary }];
      const gone = new Set([...plan.blockA, ...plan.blockB].map(e => e.id));
      A().events = A().events.filter(e => !gone.has(e.id));
      for (const e of plan.toA) A().events.push(newEvent({ agent_id: A_.assembled_agent_id, ...e }));
      for (const e of plan.toB) A().events.push(newEvent({ agent_id: B_.assembled_agent_id, ...e }));
      Object.assign(swap, { status: "approved", ...decided, result: { removed: gone.size, added: plan.toA.length + plan.toB.length, toRequester: plan.toA.length, toPartner: plan.toB.length } });
      return { ok: true, status: "approved", ...summary };
    },
    "coaching"(body) {
      if (!isAdmin()) return [403, { error: "Admins only" }];
      const { action, lob, agentIds, shuffle, current, count, keep } = body || {};
      if (!["groups", "plan", "suggest", "teams", "apply"].includes(action) || !lob) return [400, { error: "Need an action (groups, plan, suggest, teams or apply) and a LOB." }];
      if (action === "apply" && !hasPerm("push")) return [403, { error: "You do not have permission to change Assembled. You can still preview the changes." }];
      const teams = A().teams, parent = teams.find(x => x.name === `${lob} Coaches`);
      const groupIds = new Set(parent ? [parent.id] : []);
      for (let grew = !!parent; grew;) { grew = false; for (const x of teams) if (x.parent_id && groupIds.has(x.parent_id) && !groupIds.has(x.id)) { groupIds.add(x.id); grew = true; } }
      if (action === "groups") {
        if (!parent) return { groups: [], note: `There is no "${lob} Coaches" team in Assembled.` };
        return { groups: teams.filter(x => x.parent_id === parent.id).map(g => ({ id: g.id, name: g.name, members: A().people.filter(p => !p.deleted && p.teams.includes(g.id)).length }))
          .sort((a, b) => cmp(a.name, b.name)) };
      }
      const agents = T("agents").filter(a => a.lob === lob && !a.excluded);
      const weekStart = coaching.mondayFrom(today());
      const withShift = agents.map(a => ({ id: a.id, shift: shellById((assignmentOf(a.id) || {}).shift_id) })).filter(a => a.shift)
        .map(a => ({ id: a.id, shift: (({ days, start_local, end_local, timezone }) => ({ days, start_local, end_local, timezone }))(a.shift) }));
      const coaches = T("coaches").filter(c => c.lob === lob).sort((a, b) => cmp(a.name, b.name));
      if (action === "suggest") {
        const k = Math.round(Number(count));
        if (!(k >= 1 && k <= 50)) return [400, { error: "The number of coaches must be between 1 and 50." }];
        if (!withShift.length) return { schedules: [], note: `No ${lob} agents have an assigned shift yet, so there is nothing to base coach schedules on.` };
        const candidates = T("shift_shells").filter(s => s.lob === lob).map(({ days, start_local, end_local, timezone }) => ({ days, start_local, end_local, timezone }));
        return { weekStart, agents: withShift.length, ...coaching.suggestSchedules({ agents: withShift, candidates, count: k, weekStart }),
          currentFit: coaches.length ? coaching.scoreSchedules({ agents: withShift, coaches, weekStart }) : null };
      }
      if (action === "plan") {
        if (!coaches.length) return { rows: [], overlap: {}, note: `Add the ${lob} coaches and their schedules first.` };
        const has = new Set(withShift.map(a => a.id));
        const { rows, overlap, placed } = coaching.distribute({ agents: withShift, coaches, weekStart,
          shuffle: shuffle ? { current: current && typeof current === "object" ? current : {} } : null,
          keep: keep && typeof keep === "object" && !shuffle ? keep : null });
        return { weekStart, rows, overlap, placed: placed || null, noShift: agents.filter(a => !has.has(a.id)).map(a => a.name).sort() };
      }
      const ids = new Set(agents.map(a => a.id));
      const saved = T("coach_assignments").filter(x => ids.has(x.agent_id));
      if (!parent) return { changes: [], skipped: [], note: `There is no "${lob} Coaches" team in Assembled.` };
      const teamName = Object.fromEntries(teams.map(x => [x.id, x.name]));
      const only = Array.isArray(agentIds) && agentIds.length ? new Set(agentIds.map(Number)) : null;
      const changes = [], skipped = [], unchanged = [];
      for (const s of saved) {
        const a = agentById(s.agent_id), c = T("coaches").find(k => k.id === s.coach_id);
        if (!a || (only && !only.has(a.id))) continue;
        const target = c && c.assembled_team_id, p = A().people.find(x => String(x.id) === String(a.assembled_id));
        if (!target || !teamName[target] || !groupIds.has(target)) { skipped.push({ name: a.name, reason: `${(c && c.name) || "Their coach"} has no ${lob} coach group set` }); continue; }
        if (!p || p.deleted) { skipped.push({ name: a.name, reason: "not found in Assembled, or inactive there" }); continue; }
        const next = coaching.nextTeams(p.teams, groupIds, target);
        if (coaching.sameTeams(p.teams, next)) { unchanged.push(a.name); continue; }
        changes.push({ agent_id: a.id, name: a.name, person: p, teams: next, from: p.teams.filter(x => groupIds.has(x)).map(x => teamName[x] || x), to: teamName[target] });
      }
      changes.sort((x, y) => cmp(x.name, y.name));
      if (action === "teams") return { changes: changes.map(({ teams: _t, person: _p, ...c }) => c), unchanged: unchanged.length, skipped };
      for (const c of changes) {
        c.person.teams = c.teams;
        const row = T("coach_assignments").find(x => x.agent_id === c.agent_id); if (row) row.synced_at = nowIso();
      }
      return { updated: changes.map(c => ({ name: c.name, to: c.to })), failed: [], remaining: 0, unchanged: unchanged.length, skipped };
    },
    "keepalive": () => ({ ok: true }),
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const m = url.pathname.match(/\/api\/([a-z-]+)$/);
    if (!m) return realFetch(input, opts);
    await new Promise(r => setTimeout(r, m[1] === "config" ? 0 : 250));
    const method = (opts.method || "GET").toUpperCase();
    let body = {}; try { body = opts.body ? JSON.parse(opts.body) : {}; } catch { body = {}; }
    const handler = API[m[1]];
    let status = 200, out;
    const before = JSON.stringify(db);
    try {
      if (!handler) [status, out] = [404, { error: "Not found" }];
      else if (m[1] !== "config" && m[1] !== "setup-account" && !me()) [status, out] = [401, { error: "Not signed in" }];
      else { out = handler(body, method); if (Array.isArray(out)) [status, out] = out; }
      if (status >= 400) db = JSON.parse(before);
      save();
    } catch (err) {
      console.error(err); db = JSON.parse(before); [status, out] = [500, { error: String(err.message || err) }];
    }
    return new Response(JSON.stringify(out ?? {}), { status, headers: { "Content-Type": "application/json", date: new Date().toUTCString() } });
  };
})();
