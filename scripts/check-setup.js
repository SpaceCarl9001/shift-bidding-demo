// Tests api/setup-account.js against the live Supabase project using throwaway roster entries
// in LOB "__rls_test__" and throwaway logins, then deletes them. Run: npm run check:setup
const fs = require("fs"), path = require("path");
const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const handler = require("../api/setup-account.js");
const accountsHandler = require("../api/accounts.js");
const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: k, SUPABASE_ANON_KEY: anon } = process.env;
const h = { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", Prefer: "return=representation" };
const LOB = "__rls_test__", stamp = Date.now();
const newEmail = `setup-new-${stamp}@example.com`, stuckEmail = `setup-stuck-${stamp}@example.com`, goneEmail = `setup-gone-${stamp}@example.com`;
const pw = `Setup-${stamp}-ok`;

const call = body => new Promise(resolve => {
  const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
  handler({ method: "POST", body }, res);
});
const signIn = async (email, password) => (await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).status;
const tokenFor = async (email, password) => (await (await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).access_token;
const accounts = (method, token, body) => new Promise(resolve => {
  const res = { status(c) { this.c = c; return this; }, json(b) { resolve({ status: this.c, body: b }); } };
  accountsHandler({ method, headers: { authorization: `Bearer ${token}` }, body }, res);
});
const adminEmail = `setup-admin-${stamp}@example.com`;
let fails = 0;
const check = (label, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : "  " + JSON.stringify(detail)}`); };

(async () => {
  const created = [];
  try {
    const add = await fetch(`${url}/rest/v1/agents`, { method: "POST", headers: h, body: JSON.stringify([
      { email: newEmail, name: "Setup New", lob: LOB, assembled_id: `sn-${stamp}`, excluded: false },
      { email: stuckEmail, name: "Setup Stuck", lob: LOB, assembled_id: `ss-${stamp}`, excluded: false },
      { email: goneEmail, name: "Setup Gone", lob: LOB, assembled_id: `sg-${stamp}`, excluded: true },
    ]) });
    if (!add.ok) throw new Error("could not create test agents " + add.status);

    let r = await call({ email: newEmail.toUpperCase(), action: "check" });
    check("roster email with no login -> can_setup (email case ignored)", r.body.status === "can_setup", r);
    r = await call({ email: `nobody-${stamp}@example.com`, action: "check" });
    check("email not on roster -> not_found", r.body.status === "not_found", r);
    r = await call({ email: `nobody-${stamp}@example.com`, password: pw, action: "setup" });
    check("email not on roster cannot set up an account", r.body.status === "not_found" && !r.body.ok, r);
    r = await call({ email: goneEmail, action: "check" });
    check("removed person -> removed", r.body.status === "removed", r);
    r = await call({ email: "not-an-email", action: "check" });
    check("invalid email is rejected", r.status === 400, r);
    r = await call({ email: newEmail, password: "short", action: "setup" });
    check("password under 8 characters is rejected", r.status === 400, r);

    r = await call({ email: newEmail, password: pw, action: "setup" });
    check("setup creates the account", r.status === 200 && r.body.ok, r);
    check("new account can sign in right away (no email)", await signIn(newEmail, pw) === 200);
    r = await call({ email: newEmail, action: "check" });
    check("after setup -> has_account", r.body.status === "has_account", r);
    r = await call({ email: newEmail, password: "Another-password-1", action: "setup" });
    check("existing account cannot be taken over by setting up again", r.status === 409, r);
    check("original password still works", await signIn(newEmail, pw) === 200);

    // Forgotten password: an admin resets the login, then the person creates a new password.
    const mkAdmin = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: h,
      body: JSON.stringify({ email: adminEmail, password: pw, email_confirm: true }) });
    if (!mkAdmin.ok) throw new Error("could not create test admin " + mkAdmin.status);
    // The admins table decides who is an admin; this one can reset logins (Roster & ranks).
    await fetch(`${url}/rest/v1/admins`, { method: "POST", headers: h, body: JSON.stringify({ email: adminEmail, permissions: ["roster"] }) });
    const adminToken = await tokenFor(adminEmail, pw), agentToken = await tokenFor(newEmail, pw);
    r = await accounts("GET", agentToken);
    check("non-admin cannot see or reset logins", r.status === 403, r);
    r = await accounts("GET", adminToken);
    check("admin sees the login as active", r.status === 200 && r.body.accounts[newEmail] === "active", r.status);
    r = await accounts("POST", adminToken, { emails: [adminEmail] });
    check("admin cannot reset their own login", r.status === 400, r);
    r = await accounts("POST", adminToken, { emails: [newEmail, `nobody-${stamp}@example.com`] });
    check("admin resets a login (and reports emails with no login)",
      r.status === 200 && r.body.reset === 1 && r.body.noLogin.length === 1, r);
    check("after reset the old password stops working", await signIn(newEmail, pw) !== 200);
    r = await accounts("GET", adminToken);
    check("roster shows the login as reset pending", r.body.accounts[newEmail] === "reset", r.body.accounts[newEmail]);
    r = await call({ email: newEmail, action: "check" });
    check("after reset -> can_setup with reason reset", r.body.status === "can_setup" && r.body.reason === "reset", r);
    const pw2 = `Reset-${stamp}-new`;
    r = await call({ email: newEmail, password: pw2, action: "setup" });
    check("person creates a new password after reset", r.status === 200 && r.body.ok, r);
    check("new password signs in", await signIn(newEmail, pw2) === 200);
    r = await call({ email: newEmail, action: "check" });
    check("after new password -> has_account again (cannot be set up twice)", r.body.status === "has_account", r);
    r = await accounts("GET", adminToken);
    check("roster shows the login as active again", r.body.accounts[newEmail] === "active", r.body.accounts[newEmail]);

    // Someone who signed up the old way and never got the confirmation email.
    const stuck = await fetch(`${url}/auth/v1/admin/users`, { method: "POST", headers: h,
      body: JSON.stringify({ email: stuckEmail, password: "Old-unknown-pass-1", email_confirm: false }) });
    check("(setup) created an unconfirmed login", stuck.ok, stuck.status);
    r = await call({ email: stuckEmail, action: "check" });
    check("unconfirmed login -> can_setup", r.body.status === "can_setup", r);
    r = await call({ email: stuckEmail, password: pw, action: "setup" });
    check("unconfirmed login gets the new password and is confirmed", r.status === 200 && r.body.ok, r);
    check("previously stuck person can sign in", await signIn(stuckEmail, pw) === 200);
  } catch (err) {
    fails++; console.log(`FAIL  the check stopped early: ${err.message}`);
  } finally {
    const users = (await (await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`, { headers: h })).json()).users || [];
    for (const u of users.filter(u => [newEmail, stuckEmail, goneEmail, adminEmail].includes(u.email)))
      await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: h });
    await fetch(`${url}/rest/v1/agents?lob=eq.${LOB}`, { method: "DELETE", headers: h });
    await fetch(`${url}/rest/v1/admins?email=eq.${encodeURIComponent(adminEmail)}`, { method: "DELETE", headers: h });
    const left = await (await fetch(`${url}/rest/v1/agents?select=id&lob=eq.${LOB}`, { headers: h })).json();
    console.log(`Cleanup done (${left.length} test agents left).`);
  }
  console.log(fails ? `\n${fails} failed` : "\nAll account setup tests passed");
  process.exit(fails ? 1 : 0);
})();
