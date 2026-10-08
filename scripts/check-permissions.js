// Checks admin permissions against the live Supabase project: what an admin can change depends on
// their permissions (supabase/rls-policies.sql), the server functions check them too, and only
// admins with "admins" can manage the admin list. Uses a throwaway LOB and logins that are deleted
// afterwards. Never touches Assembled. Run: npm run check:permissions
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_KEY: k } = process.env;
const handlers = { swaps: require("../api/swaps.js"), push: require("../api/apply-schedules.js"), sync: require("../api/sync-assembled.js"), accounts: require("../api/accounts.js") };

const LOB = "__perm_test__", stamp = Date.now(), password = `Perm-${stamp}-pw`;
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
const callApi = (name, token, body, method = "POST") => new Promise(resolve => {
  const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
  handlers[name]({ method, headers: { authorization: `Bearer ${token}` }, body }, res);
});
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  -> " + JSON.stringify(detail).slice(0, 220)}`); };

(async () => {
  if ((await svc("GET", "admins?select=permissions&limit=1")).status !== 200) {
    console.error("Admin permissions are not in the database yet. Run the updated supabase/rls-policies.sql first."); process.exit(1);
  }
  const emails = { shells: `perm-shells-${stamp}@example.com`, boss: `perm-boss-${stamp}@example.com`, agent: `perm-agent-${stamp}@example.com` };
  const newAdmin = `Perm-New-${stamp}@Example.com`;
  const users = {};
  try {
    const [shell] = (await svc("POST", "shift_shells", { lob: LOB, seats: 1, days: "1", start_local: "08:00", end_local: "17:00", timezone: "UTC", schedule: "perm s1" })).data;
    const [agent] = (await svc("POST", "agents", { email: emails.agent, name: "Perm Agent", lob: LOB, assembled_id: `perm-${stamp}`, excluded: false })).data;
    for (const key of Object.keys(emails)) {
      const u = await (await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: svcH, body: JSON.stringify({ email: emails[key], password, email_confirm: true }) })).json();
      const t = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email: emails[key], password }) })).json();
      users[key] = { id: u.id, token: t.access_token, rest: as(t.access_token) };
    }
    await svc("POST", "admins", [{ email: emails.shells, permissions: ["shells"] }, { email: emails.boss, permissions: ["admins"] }]);
    const S = users.shells.rest, boss = users.boss.rest, ag = users.agent.rest;

    // ---- an admin with only "Shift shells"
    let r = await S("POST", "rpc/my_permissions", {}); check("an admin sees their own permissions", r.ok && JSON.stringify(r.data) === '["shells"]', r.data);
    r = await S("GET", `agents?select=id&lob=eq.${LOB}`); check("every admin can still read the roster", r.ok && r.data.length === 1, r);
    r = await S("PATCH", `agents?id=eq.${agent.id}`, { rank: 3 }); check("without Roster & ranks: cannot change ranks", r.ok && r.data.length === 0, r);
    r = await S("POST", "shift_shells", { lob: LOB, seats: 1, days: "2", start_local: "08:00", end_local: "17:00", timezone: "UTC", schedule: "perm s2" });
    check("with Shift shells: can add a shell", r.ok && r.data.length === 1, r);
    r = await S("POST", "rpc/replace_bid_window", { p_lob: LOB, p_opens: new Date().toISOString(), p_closes: new Date(Date.now() + 3600e3).toISOString() });
    check("without Bid windows: cannot set a bid window", !r.ok && /permission/.test(r.data.message), r.data);
    r = await S("POST", "rpc/replace_assignments", { p_agent_ids: [agent.id], p_rows: [{ agent_id: agent.id, shift_id: shell.id }] });
    check("without Auto assign: cannot save assignments", !r.ok && /permission/.test(r.data.message), r.data);
    r = await S("POST", "assignments", { agent_id: agent.id, shift_id: shell.id }); check("without Auto assign: cannot write assignments directly either", !r.ok, r);
    r = await S("POST", "published_results", { lob: LOB }); check("without Auto assign: cannot publish results", !r.ok, r);
    r = await S("POST", "rpc/decide_trade", { p_id: -1, p_approve: true }); check("without Approve trades: cannot decide a trade", !r.ok && /permission/.test(r.data.message), r.data);
    r = await S("POST", "rpc/can_assign_manually", {}); check("without Manual assignment: cannot assign manually", r.ok && r.data === false, r.data);
    r = await S("POST", "admins", { email: `perm-sneak-${stamp}@example.com`, permissions: ["admins"] }); check("without Manage admins: cannot add an admin", !r.ok, r);
    r = await S("PATCH", `admins?email=eq.${encodeURIComponent(emails.shells)}`, { permissions: ["shells", "admins", "push"] });
    check("without Manage admins: cannot give themselves more permissions", r.ok && r.data.length === 0, r);

    // ---- the server functions check permissions too
    r = await callApi("swaps", users.shells.token, { action: "approve", id: 1 }); check("server: approving a swap needs Approve trades & swaps", r.status === 403, r);
    r = await callApi("push", users.shells.token, { lob: LOB, startDate: "2026-10-12", endDate: "2026-10-18", typeId: "x", dryRun: false });
    check("server: pushing to Assembled needs Push to Assembled", r.status === 403 && /permission/.test(r.body.error), r.body);
    r = await callApi("push", users.shells.token, { lob: LOB, startDate: "2026-10-12", endDate: "2026-10-18", typeId: "x", dryRun: true });
    check("server: any admin can still preview a push", r.status !== 403, r);
    r = await callApi("sync", users.shells.token, {}); check("server: syncing the roster needs Roster & ranks", r.status === 403, r);
    r = await callApi("accounts", users.shells.token, { emails: [emails.agent] }); check("server: resetting a login needs Roster & ranks", r.status === 403, r);

    // ---- an admin with "Manage admins"
    r = await boss("POST", "admins", { email: newAdmin, permissions: ["swaps", "push"] });
    check("Manage admins: can add an admin (email stored lowercase)", r.ok && r.data[0]?.email === newAdmin.toLowerCase(), r);
    r = await boss("PATCH", `admins?email=eq.${encodeURIComponent(newAdmin.toLowerCase())}`, { permissions: ["swaps"] });
    check("Manage admins: can change an admin's permissions", r.ok && JSON.stringify(r.data[0]?.permissions) === '["swaps"]', r);
    r = await boss("PATCH", `admins?email=eq.${encodeURIComponent(newAdmin.toLowerCase())}`, { permissions: ["everything"] });
    check("only known permissions can be saved", !r.ok, r);
    r = await boss("DELETE", `admins?email=eq.${encodeURIComponent(newAdmin.toLowerCase())}`); check("Manage admins: can remove an admin", r.ok && r.data.length === 1, r);
    r = await boss("DELETE", `admins?email=eq.${encodeURIComponent(emails.boss)}`); check("nobody can remove themselves", !r.ok && /yourself/.test(r.data.message), r.data);
    r = await boss("PATCH", `admins?email=eq.${encodeURIComponent(emails.boss)}`, { permissions: ["push"] });
    check("nobody can take away their own Manage admins", !r.ok && /your own right/.test(r.data.message), r.data);
    r = await boss("PATCH", `agents?id=eq.${agent.id}`, { rank: 3 }); check("Manage admins alone does not allow roster changes", r.ok && r.data.length === 0, r);
    r = await ag("GET", "admins?select=email"); check("agents cannot see the admin list", r.ok && r.data.length === 0, r);
  } catch (err) {
    fails++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    const agents = (await svc("GET", `agents?select=id&lob=eq.${LOB}`)).data || [];
    if (agents.length) await svc("DELETE", `assignments?agent_id=in.(${agents.map(a => a.id).join(",")})`);
    await svc("DELETE", `bid_windows?lob=eq.${LOB}`);
    await svc("DELETE", `published_results?lob=eq.${LOB}`);
    await svc("DELETE", `shift_shells?lob=eq.${LOB}`);
    await svc("DELETE", `agents?lob=eq.${LOB}`);
    await svc("DELETE", `admins?email=in.(${[emails.shells, emails.boss, newAdmin.toLowerCase(), `perm-sneak-${stamp}@example.com`].map(encodeURIComponent).join(",")})`);
    for (const u of Object.values(users)) if (u.id) await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: svcH });
    const left = (await svc("GET", `admins?select=email&email=like.perm-*`)).data || [];
    console.log(`Cleanup done (${left.length} test admins left).`);
    console.log(fails ? `\n${fails} failed` : "\nAll permission checks passed.");
    process.exit(fails ? 1 : 0);
  }
})();
