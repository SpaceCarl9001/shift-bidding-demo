let sb;
let ADMIN_EMAILS = [];
const app = document.getElementById("app");
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const el = sel => document.querySelector(sel);

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const TZ_LIST = ["America/New_York","America/Chicago","America/Denver","America/Los_Angeles",
                 "America/Phoenix","Asia/Manila","UTC"];

// Admin sections. tone picks the colour the whole page takes on for that section.
const TABS = [
  { t:"agents",  label:"Agents",             tone:"teal",   blurb:"Sync the roster from Assembled, import scorecard ranks, and check who is linked." },
  { t:"shifts",  label:"Shift shells",       tone:"amber",  blurb:"The shifts agents can bid on, and how many seats each one has." },
  { t:"window",  label:"Bid window",         tone:"coral",  blurb:"When each LOB is allowed to submit bids." },
  { t:"assign",  label:"Auto assign",        tone:"violet", blurb:"Hand out shifts in rank order, one LOB at a time." },
  { t:"results", label:"Results",            tone:"moss",   blurb:"Saved assignments: review them, publish them to agents, and export." },
  { t:"swaps",   label:"Swaps",              tone:"rose",   blurb:"Shift trades and day swaps agents have agreed between themselves, waiting for your review." },
  { t:"coaches", label:"Coaches",            tone:"copper", blurb:"Share each LOB's agents out between its coaches, matched to each coach's schedule, and update their coach groups in Assembled." },
  { t:"push",    label:"Apply to Assembled", tone:"cobalt", blurb:"The last step: put the final assigned shifts on the Assembled staffing timeline." },
];
const pad2 = n => String(n).padStart(2,"0");
// Most shells an agent can pick. Keep in step with c_max_picks in supabase/save-functions.sql.
const MAX_PICKS = 20;
// With "use all picks" on, agents must pick this many: MAX_PICKS, or every shell in a smaller LOB.
const picksNeeded = shellCount => Math.min(MAX_PICKS, shellCount);

// Everyone works to US Eastern time, so every time in the app is shown and entered in ET,
// whatever timezone the viewer's computer is set to.
const APP_TZ = "America/New_York";
const fmtET = t => `${new Date(t).toLocaleString("en-US", { timeZone:APP_TZ, month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" })} ET`;
const etParts = t => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:APP_TZ, hourCycle:"h23",
  year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" })
  .formatToParts(new Date(t)).map(p=>[p.type, p.value]));
// A timestamp as ET wall-clock time for <input type="datetime-local">.
const toLocalInput = t => { const p = etParts(t); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
// A datetime-local value read as ET wall-clock time.
function fromETInput(value){
  const [y, mo, d, h, mi] = value.split(/[-T:]/).map(Number), wall = Date.UTC(y, mo - 1, d, h, mi);
  const offset = at => { const s = Math.floor(at / 1000) * 1000, p = etParts(s);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - s; };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));   // second pass lands right around daylight saving changes
}
const etToday = () => { const p = etParts(Date.now()); return `${p.year}-${p.month}-${p.day}`; };
const rankChip = r => r!=null ? `<span class="rank">${esc(r)}</span>` : `<span class="muted">none</span>`;
// Agents approved for a schedule accommodation are placed before everyone else in their LOB:
// Tier 1 first, then Tier 2, then Tier 3, then any approved before tiers existed (no tier yet).
const ACCOM_TIERS = [1, 2, 3];
const accomTier = a => a && a.accommodation ? (ACCOM_TIERS.includes(a.accommodation_tier) ? a.accommodation_tier : null) : undefined;
const accomBadge = a => {
  const t = accomTier(a);
  if(t === undefined) return "";
  return t ? `<span class="pill accom" title="Approved for accommodation, Tier ${t}: placed before everyone else">Accommodation &middot; Tier ${t}</span>`
    : `<span class="pill accom notier" title="Approved for accommodation without a tier: placed after Tier 3. Set a tier.">Accommodation &middot; no tier</span>`;
};
// Accommodation order: 1, 2, 3, then no tier (4); everyone else is not accommodated (5).
const accomOrder = a => { const t = accomTier(a); return t === undefined ? 5 : t || 4; };

let currentUser = null;
let myAgent = null;

async function initSupabase(){
  const r = await fetch("/api/config");
  const config = await r.json().catch(()=>({}));
  if(!r.ok || !config.url || !config.anonKey){
    throw new Error(config.error || "Supabase is not configured yet.");
  }
  ADMIN_EMAILS = config.adminEmails || [];
  sb = supabase.createClient(config.url, config.anonKey);
}

async function authedFetch(path, options){
  const { data:{ session } } = await sb.auth.getSession();
  const opts = options || {};
  opts.headers = Object.assign({}, opts.headers, {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  });
  const r = await fetch(path, opts);
  const body = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

// ---------------------------------------------------------------- AUTH
async function boot(){
  try {
    await initSupabase();
  } catch(error) {
    app.innerHTML = `<div class="center"><div class="card"><h2>Configuration error</h2><div class="msg err">${esc(error.message)}</div></div></div>`;
    return;
  }
  const { data } = await sb.auth.getUser();
  currentUser = data.user;
  if(!currentUser){ renderLogin(); return; }
  renderApp();
}
function isAdmin(){
  return currentUser && ADMIN_EMAILS.map(e=>e.toLowerCase())
    .includes((currentUser.email||"").toLowerCase());
}
function renderLogin(){
  const bars = [["coral",6,48],["amber",28,54],["teal",2,36],["violet",42,40],["moss",16,60]];
  app.innerHTML = `
    <div class="login">
      <section class="login-art" aria-hidden="true">
        <div class="brand"><span class="brand-mark"></span>Shift<br>Bidding</div>
        <h1>Pick your <em>shift</em>, in order of rank.</h1>
        <div class="timeline">
          ${bars.map(([c,x,w])=>`<span style="--c:var(--c-${c});--x:${x}%;--w:${w}%"></span>`).join("")}
        </div>
        <p class="login-foot">Rank 1 chooses first, then rank 2, and so on down the list.</p>
      </section>
      <section class="login-form">
        <div class="card layer">
          <h2 id="loginTitle">Sign in</h2>
          <div id="loginMsg"></div>
          <form id="loginForm" novalidate>
            <label for="email">Work email</label>
            <input id="email" type="email" autocomplete="username" placeholder="name@company.com" />
            <div id="pwStep" hidden>
              <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" />
              <div id="pw2Wrap" hidden><label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password" /></div>
            </div>
            <div class="actions">
              <button id="loginBtn" type="submit">Continue</button>
              <button id="backBtn" type="button" class="ghost" hidden>Use a different email</button>
            </div>
          </form>
          <p class="muted" id="loginHint" style="margin-top:16px">First time here? Enter the work email Assembled has for you, and you will be asked to create a password.</p>
        </div>
      </section>
    </div>`;
  el("#loginForm").onsubmit = e=>{ e.preventDefault(); loginNext(); };
  el("#backBtn").onclick = ()=> setLoginStage("email");
  el("#email").focus();
}
function loginMsg(t,k){ el("#loginMsg").innerHTML = t ? `<div class="msg ${k}">${esc(t)}</div>` : ""; }

// Sign-in is two steps: email first, then either the password (existing login) or creating one.
// New logins are created by /api/setup-account for roster emails only, already confirmed,
// so no confirmation email is needed.
const MIN_PASSWORD = 8;
let loginStage = "email";
function setLoginStage(stage){
  loginStage = stage;
  const setup = stage === "setup", askPw = stage !== "email";
  el("#pwStep").hidden = !askPw;
  el("#pw2Wrap").hidden = !setup;
  el("#backBtn").hidden = !askPw;
  el("#loginHint").hidden = askPw;
  el("#email").readOnly = askPw;
  el("#pw").autocomplete = setup ? "new-password" : "current-password";
  el("#pw").placeholder = setup ? `At least ${MIN_PASSWORD} characters` : "Your password";
  el("#loginTitle").textContent = setup ? "Create your password" : "Sign in";
  el("#loginBtn").textContent = stage === "email" ? "Continue" : setup ? "Create account and sign in" : "Sign in";
  el("#pw").value = ""; el("#pw2").value = "";
  if(askPw) el("#pw").focus(); else { loginMsg(""); el("#email").focus(); }
}
async function setupAccount(payload){
  const r = await fetch("/api/setup-account", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
  const b = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(b.error || `Request failed (${r.status})`);
  return b;
}
async function loginNext(){
  const email = el("#email").value.trim().toLowerCase(), btn = el("#loginBtn");
  if(!email){ loginMsg("Enter your work email.","err"); return; }
  btn.disabled = true;
  try{
    if(loginStage === "email"){
      const { status, reason } = await setupAccount({ email, action:"check" });
      if(status === "has_account"){ setLoginStage("signin"); loginMsg(""); }
      else if(status === "can_setup"){
        setLoginStage("setup");
        loginMsg(reason === "reset"
          ? "Your admin reset your login. Create a new password to sign in."
          : "Welcome! This is your first time signing in. Create a password to finish setting up your account.","good");
      }
      else if(status === "removed") loginMsg("You are not included in the current shift bid. If you think this is a mistake, ask your admin.","warn");
      else loginMsg(`We couldn't find ${email} in the shift bid roster. Use the work email Assembled has for you, or ask your admin.`,"err");
      return;
    }
    const password = el("#pw").value;
    if(loginStage === "setup"){
      if(password.length < MIN_PASSWORD){ loginMsg(`Your password must be at least ${MIN_PASSWORD} characters.`,"err"); return; }
      if(password !== el("#pw2").value){ loginMsg("The two passwords do not match.","err"); return; }
      await setupAccount({ email, password, action:"setup" });
    } else if(!password){ loginMsg("Enter your password.","err"); return; }

    const { error } = await sb.auth.signInWithPassword({ email, password });
    if(error){
      loginMsg(/invalid login/i.test(error.message)
        ? "That password is not right. If you forgot it, ask your admin to reset your login, then come back here and create a new password."
        : error.message, "err");
      return;
    }
    location.reload();
  }catch(err){ loginMsg(err.message,"err"); }
  finally{ btn.disabled = false; }
}
async function signOut(){ await sb.auth.signOut(); location.reload(); }

// ---------------------------------------------------------------- SHELL
async function renderApp(){
  const role = isAdmin() ? "Admin" : "Agent";
  app.innerHTML = `
    <div class="shell" id="shell">
      <aside class="rail">
        <div class="brand"><span class="brand-mark"></span>Shift<br>Bidding</div>
        <div id="railLob"></div>
        <nav class="tabs" id="railNav"></nav>
        <div class="rail-foot">
          <span class="role-tag">${role}</span>
          <span class="who">${esc(currentUser.email)}</span>
          <div class="rail-actions">
            <button class="ghost small" id="pwBtn">Change password</button>
            <button class="ghost small" id="outBtn">Sign out</button>
          </div>
        </div>
      </aside>
      <main id="view"></main>
      <div id="pwModal" class="modal-bg hidden"></div>
    </div>`;
  el("#outBtn").onclick = signOut;
  el("#pwBtn").onclick = openPasswordBox;
  if(isAdmin()) renderAdmin(); else renderAgent();
}
function openPasswordBox(){
  const box = el("#pwModal");
  box.innerHTML = `<div class="modal">
    <h2>Change your password</h2>
    <label for="pw1">New password</label><input id="pw1" type="password" autocomplete="new-password" placeholder="At least ${MIN_PASSWORD} characters" />
    <label for="pw2">Confirm new password</label><input id="pw2" type="password" autocomplete="new-password" placeholder="Type it again" />
    <div id="pwMsg"></div>
    <div class="actions" style="justify-content:flex-end">
      <button class="ghost" id="pwCancel">Cancel</button>
      <button id="pwSave">Save password</button>
    </div>
  </div>`;
  box.classList.remove("hidden");
  el("#pwCancel").onclick = closePasswordBox;
  el("#pwSave").onclick = changePassword;
  el("#pw1").focus();
}
function closePasswordBox(){ const box = el("#pwModal"); box.classList.add("hidden"); box.innerHTML = ""; }
async function changePassword(){
  const p1 = el("#pw1").value, p2 = el("#pw2").value, msg = el("#pwMsg");
  if(p1.length<MIN_PASSWORD){ msg.innerHTML = `<div class="msg err">Password must be at least ${MIN_PASSWORD} characters.</div>`; return; }
  if(p1!==p2){ msg.innerHTML = `<div class="msg err">The two passwords do not match.</div>`; return; }
  const btn = el("#pwSave");
  btn.disabled = true;
  const { error } = await sb.auth.updateUser({ password:p1 });
  if(error){ btn.disabled = false; msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  msg.innerHTML = `<div class="msg good">Password updated.</div>`;
  setTimeout(closePasswordBox, 1200);
}

// ---------------------------------------------------------------- ADMIN
// Each LOB runs its own bid: every admin tab works on currentLob only.
let adminTab = "agents";
let currentLob = "", adminLobs = [];
const LOB_KEY = "shiftBidding.lob";
const NON_BID_LOBS = ["Unassigned", "Multiple LOBs"];
// ---- admin permissions (the admins table; see supabase/rls-policies.sql) ----
// Every admin can view every tab; changing things needs the matching permission. The database
// and the server check these too; here they only decide which controls are usable.
const PERMISSIONS = [
  { key:"roster",  label:"Roster & ranks",         hint:"Agents tab: sync, ranks, remove and restore, accommodation, reset logins" },
  { key:"shells",  label:"Shift shells",           hint:"Add, edit, label and remove shells" },
  { key:"windows", label:"Bid & trade windows",    hint:"Open, close and cancel bid windows and trade windows" },
  { key:"assign",  label:"Auto assign",            hint:"Run auto assign" },
  { key:"swaps",   label:"Approve trades & swaps", hint:"Approve or reject shift trades and day swaps" },
  { key:"push",    label:"Push to Assembled",      hint:"Apply schedules to Assembled (anyone can preview)" },
  { key:"manual",  label:"Manual assignment",      hint:"Assign a shift to an agent directly" },
  { key:"admins",  label:"Manage admins",          hint:"Add and remove admins and change these permissions" },
];
// What admins could do before permissions existed, and the default for a new admin.
const STANDARD_PERMS = ["roster", "shells", "windows", "assign", "swaps", "push"];
let myPerms = null;
const can = p => !!myPerms && myPerms.includes(p);
// Whether this admin may set manual assignments. Asked once, with the permissions.
let canAssignManually = null;
async function loadMyPermissions(){
  const { data, error } = await sb.rpc("my_permissions");
  if(!error && Array.isArray(data)){ myPerms = data; canAssignManually = data.includes("manual"); return; }
  // Before permissions were set up in the database: everything admins could do then.
  myPerms = [...STANDARD_PERMS];
  const m = await sb.rpc("can_assign_manually");
  canAssignManually = !m.error && m.data === true;
  if(canAssignManually) myPerms.push("manual");
}
// Per tab: controls that need a permission. Without it they are disabled (the tab stays viewable).
const PERMISSION_LOCKS = {
  agents: [{ perm:"roster", sel:"#caFind, #caList button, input.rank-input, #syncBtn, #rankFile, #rankClear, #rankApply, #bulkBtn, #accomOn, #accomOff, #accomTier, #agentList .pick-one, #pickAll, #agentList button[data-reset], #agentList button[data-id]" }],
  shifts: [{ perm:"shells", sel:"button, input, select, textarea", allow:"#shSort, #shShow, button[data-who], #shellCsvTemplate" }],
  window: [{ perm:"windows", sel:"button, input, select" }],
  assign: [{ perm:"assign", sel:"#runBtn" }],
  results:[{ perm:"assign", sel:"#pubBtn, #unpubBtn" }],
  swaps:  [{ perm:"swaps", sel:"button[data-act=approve], button[data-act=reject], button[data-trade-act], .swNote, .trNote" },
           { perm:"windows", sel:"#twSave, #twCloseNow, #twRemove, #twOpen, #twClose, #twFromBid" }],
  push:   [{ perm:"push", sel:"#pushBtn" }],
  coaches:[{ perm:"roster", sel:"#coachForm input, #coachForm select, #coachForm button, button[data-coach-edit], button[data-coach-del], #ctPlan, #ctShuffle, #ctSave, select.ct-move, #csCount, #csApply, #csOut select, #csOut input, #cgPub, #cgUnpub, #cbUse, #cbFind, #cbList button, #coachBid input.rank-input, button[data-cb-remove]" },
           { perm:"push", sel:"#ctApply" }, { perm:"shells", sel:"#cbCreate" },
           { perm:"windows", sel:"#cbwSave, #cbwClose, #cbwOpen, #cbwCloseAt" }, { perm:"assign", sel:"#cbAssign, #cbReset" }],
};
let lockObserver = null;
function applyPermissionLocks(tabKey){
  if(lockObserver){ lockObserver.disconnect(); lockObserver = null; }
  const rules = (PERMISSION_LOCKS[tabKey] || []).filter(r=>!can(r.perm));
  const panel = el("#panel");
  if(!rules.length || !panel) return;
  const names = rules.map(r=>PERMISSIONS.find(p=>p.key === r.perm).label);
  panel.insertAdjacentHTML("beforebegin",
    `<div class="msg warn perm-note">You can view this tab, but changing ${esc(names.join(" or "))} needs a permission you do not have. Ask an admin who can manage admins.</div>`);
  const lock = ()=> rules.forEach(r=> panel.querySelectorAll(r.sel).forEach(x=>{
    if(r.allow && x.matches(r.allow)) return;
    if(!x.disabled){ x.disabled = true; x.title = "You do not have permission to change this"; }
  }));
  lock();
  lockObserver = new MutationObserver(lock);
  lockObserver.observe(panel, { childList:true, subtree:true, attributes:true, attributeFilter:["disabled"] });
}
// The Admins screen is not one of the numbered steps, so it is reached from the sidebar footer.
const ADMINS_TAB = { t:"admins", label:"Admins", tone:"slate", blurb:"Who can use the admin screens, and what each admin can change." };
async function renderAdmin(){
  if(myPerms === null) await loadMyPermissions();
  if(adminTab === "admins" && !can("admins")) adminTab = "agents";
  const i = adminTab === "admins" ? TABS.length : TABS.findIndex(x=>x.t===adminTab), tab = adminTab === "admins" ? ADMINS_TAB : TABS[i];
  const foot = document.querySelector(".rail-actions");
  if(foot && can("admins") && !el("#adminsBtn")){
    foot.insertAdjacentHTML("afterbegin", `<button class="ghost small" id="adminsBtn" type="button">Admins</button>`);
    el("#adminsBtn").onclick = ()=>{ if(!leaveUnsavedOk()) return; adminTab = "admins"; renderAdmin(); };
  }
  if(el("#adminsBtn")) el("#adminsBtn").classList.toggle("active", adminTab === "admins");
  el("#shell").style.setProperty("--tone", `var(--c-${tab.tone})`);
  adminLobs = (await getLobs(true)).filter(l=>!isCoachLob(l));
  if(!adminLobs.includes(currentLob)){
    let saved = ""; try{ saved = localStorage.getItem(LOB_KEY) || ""; }catch{}
    currentLob = adminLobs.includes(saved) ? saved : (adminLobs.find(l=>!NON_BID_LOBS.includes(l)) || adminLobs[0] || "");
  }
  el("#railLob").innerHTML = `
    <label class="rail-switch"><span>Working on</span>
      <select id="lobSwitch">${adminLobs.length
        ? adminLobs.map(l=>`<option ${l===currentLob?"selected":""}>${esc(l)}</option>`).join("")
        : `<option value="">No LOBs yet</option>`}</select>
    </label>`;
  el("#lobSwitch").onchange = e=>{
    if(!leaveUnsavedOk()){ e.target.value = currentLob; return; }
    currentLob = e.target.value;
    try{ localStorage.setItem(LOB_KEY, currentLob); }catch{}
    renderAdmin();
  };
  el("#railNav").innerHTML = TABS.map((x,n)=>`
    <button data-t="${x.t}" class="${x.t===adminTab?"active":""}" style="--tab:var(--c-${x.tone})">
      <span class="tab-num">${pad2(n+1)}</span>${x.label}
    </button>`).join("");
  el("#railNav").querySelectorAll("button").forEach(b=>{
    b.onclick = ()=>{ if(!leaveUnsavedOk()) return; adminTab=b.dataset.t; renderAdmin(); };
  });
  el("#railNav .active")?.scrollIntoView({ block:"nearest", inline:"nearest" });   // none on the Admins screen
  markPendingSwaps();
  el("#view").innerHTML = `
    <div class="panel-head">
      <span class="panel-num">${pad2(i+1)}</span>
      <h1><span>${tab.label}</span></h1>
      <p>${currentLob && adminTab !== "admins" ? `<b class="lob-chip">${esc(currentLob)}</b>` : ""}${tab.blurb}</p>
    </div>
    <div id="panel"></div>`;
  if(adminTab === "admins"){ adminAdmins(); return; }
  if(adminTab !== "agents" && !currentLob){
    el("#panel").innerHTML = `<div class="card layer span-8"><h2>No LOBs yet</h2>
      <p class="muted">Sync agents from Assembled on the Agents tab first. Each LOB then gets its own ranks, shift shells, bid window and results.</p></div>`;
    return;
  }
  ({agents:adminAgents, shifts:adminShifts, window:adminWindow,
    assign:adminAssign, results:adminResults, push:adminPush, swaps:adminSwaps, coaches:adminCoaches})[adminTab]();
  applyPermissionLocks(adminTab);
}

// ---- Admins screen (only for admins with "Manage admins")
async function adminAdmins(){
  const me = (currentUser.email || "").toLowerCase();
  const boxes = (prefix, perms, lockSelf) => PERMISSIONS.map(p=>`
    <label class="perm-box" title="${esc(p.hint)}"><input type="checkbox" class="${prefix}" value="${p.key}" ${perms.includes(p.key) ? "checked" : ""}
      ${lockSelf && p.key === "admins" ? "disabled" : ""} /> ${esc(p.label)}${lockSelf && p.key === "admins" ? ` <span class="perm-lock" title="So you cannot lock yourself out. Another admin with Manage admins can change it for you.">(always on for you)</span>` : ""}</label>`).join("");
  el("#panel").innerHTML = `
    <div class="card layer span-8">
      <h2>Add an admin</h2>
      <label for="newAdmin">Email</label>
      <input id="newAdmin" type="email" placeholder="name@example.com" autocomplete="off" />
      <label>What they can change</label>
      <div class="perm-grid">${boxes("new-perm", STANDARD_PERMS, false)}</div>
      <div class="actions"><button id="addAdmin" type="button">Add admin</button></div>
      <div id="addAdminMsg"></div>
    </div>
    <aside class="note span-4 drop">
      <h3>How permissions work</h3>
      <p>Every admin can view every tab. These boxes decide what each one can change; without a box, those buttons are greyed out for them, and the database refuses the change too.</p>
      <p>A new admin signs in by entering their email on the sign-in page and creating a password.</p>
      <p>Changes apply the next time that admin opens or refreshes the app. You cannot remove yourself or your own Manage admins.</p>
    </aside>
    <div class="card"><h2>Admins</h2><div id="adminList" class="muted">Loading</div></div>`;

  const list = el("#adminList");
  const { data, error } = await sb.from("admins").select("email,permissions").order("email");
  if(error){
    list.innerHTML = `<div class="msg err">${/permissions/.test(error.message) ? "Admin permissions are not in the database yet. Run the Admin permissions SQL in Supabase first." : esc(error.message)}</div>`;
    el("#addAdmin").disabled = true; return;
  }
  list.classList.remove("muted");
  list.innerHTML = `<table class="admin-table"><thead><tr><th>Admin</th><th>Can change</th><th></th></tr></thead><tbody>
    ${data.map(a=>`<tr data-admin="${esc(a.email)}">
      <td><b>${esc(a.email)}</b>${a.email === me ? ` <span class="pill ok">you</span>` : ""}</td>
      <td><div class="perm-grid compact">${boxes("row-perm", a.permissions || [], a.email === me)}</div></td>
      <td style="text-align:right;white-space:nowrap"><button class="small" data-save-admin type="button">Save</button>
        ${a.email === me ? "" : `<button class="small danger" data-remove-admin type="button">Remove</button>`}</td>
    </tr>`).join("")}</tbody></table><div id="adminListMsg"></div>`;

  const msg = el("#adminListMsg"), picked = (root, cls) => [...root.querySelectorAll(`input.${cls}:checked`)].map(x=>x.value);
  list.querySelectorAll("tr[data-admin]").forEach(tr=>{
    const email = tr.dataset.admin;
    tr.querySelector("[data-save-admin]").onclick = async ()=>{
      const permissions = picked(tr, "row-perm");
      if(email === me && !permissions.includes("admins")) permissions.push("admins");
      const { data: done, error } = await sb.from("admins").update({ permissions }).eq("email", email).select("email");
      msg.innerHTML = error || !done?.length ? `<div class="msg err">${esc(error ? error.message : "That admin could not be changed.")}</div>`
        : `<div class="msg good">Saved ${esc(email)}: ${permissions.length ? esc(permissions.map(k=>PERMISSIONS.find(p=>p.key === k).label).join(", ")) : "view only"}.</div>`;
    };
    const rm = tr.querySelector("[data-remove-admin]");
    if(rm) rm.onclick = async ()=>{
      if(!confirm(`Remove ${email} as an admin?\n\nThey will no longer see the admin screens. If they are on the roster, they will see the agent page instead.`)) return;
      const { data: gone, error } = await sb.from("admins").delete().eq("email", email).select("email");
      if(error || !gone?.length){ msg.innerHTML = `<div class="msg err">${esc(error ? error.message : "That admin could not be removed.")}</div>`; return; }
      await adminAdmins();
      el("#adminListMsg").innerHTML = `<div class="msg good">Removed ${esc(email)} as an admin.</div>`;
    };
  });
  el("#addAdmin").onclick = async ()=>{
    const out = el("#addAdminMsg"), email = el("#newAdmin").value.trim().toLowerCase(), permissions = picked(el("#panel"), "new-perm");
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ out.innerHTML = `<div class="msg err">Enter a full email address.</div>`; return; }
    if(!email.endsWith("@example.com") && !confirm(`${email} is not a @example.com address. Check it for typos: anyone who can sign in with this email will be an admin.\n\nAdd it anyway?`)) return;
    if(data.some(a=>a.email === email)){ out.innerHTML = `<div class="msg warn">${esc(email)} is already an admin. Change their boxes in the list below.</div>`; return; }
    const { error } = await sb.from("admins").insert({ email, permissions });
    if(error){ out.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    await adminAdmins();
    el("#addAdminMsg").innerHTML = `<div class="msg good">Added ${esc(email)} as an admin. They sign in by entering this email on the sign-in page and creating a password.</div>`;
  };
}

// CSV uploads only save when the admin clicks the button under the preview. Before leaving the
// tab or LOB with an unsaved preview, ask, so it is never lost without a warning.
function leaveUnsavedOk(){
  const shells = pendingShells.length, ranks = !!pendingRanks;
  if(coachDraft?.manual && coachDraft.changed && !shells && !ranks){
    if(!confirm("You have coach group changes that have not been saved yet.\n\nLeave without saving?")) return false;
    coachDraft = null; return true;
  }
  coachDraft = null;
  if(!shells && !ranks) return true;
  const what = shells ? `${shells} shift shell${shells===1?"":"s"}` : "rank changes";
  if(!confirm(`You have ${what} in a preview that ${shells ? (shells===1?"has":"have") : "have"} not been saved yet.\n\nLeave without saving?`)) return false;
  pendingShells = []; pendingRanks = null;
  return true;
}
window.addEventListener("beforeunload", e=>{
  if(pendingShells.length || pendingRanks){ e.preventDefault(); e.returnValue = ""; }
});

// Supabase returns at most 1000 rows per request. Bids can be far more than that (one row per
// agent per shell), so read them page by page. build() makes a fresh query each time.
async function selectAll(build, key = "id"){
  const rows = [];
  for(let from = 0; ; from += 1000){
    const { data, error } = await build().order(key).range(from, from + 999);
    if(error) return { data:null, error };
    rows.push(...data);
    if(data.length < 1000) return { data:rows, error:null };
  }
}

// LOBs from agents and shift shells. Removed people only count when includeRemoved is set.
async function getLobs(includeRemoved){
  let agentQuery = sb.from("agents").select("lob");
  if(!includeRemoved) agentQuery = agentQuery.eq("excluded", false);
  const { data:a } = await agentQuery;
  const { data:s } = await sb.from("shift_shells").select("lob");
  const all = [...(a||[]).map(r=>r.lob), ...(s||[]).map(r=>r.lob)].filter(Boolean);
  return [...new Set(all)].sort();
}
function describeShell(s, withSet = true){
  const set = withSet && s.set_name ? ` · ${setLabel(s.set_name)}` : "";
  if(s.days && s.start_local && s.end_local){
    const names = String(s.days).split(",").map(n=>DAY_NAMES[+n]).filter(Boolean).join(", ");
    return `${names} ${s.start_local} to ${s.end_local} ${s.timezone||""}`.trim() + set;
  }
  return (s.schedule || "(incomplete shift)") + set;
}

// Shift shell sets (e.g. Set A and Set B): an optional label on each shell, shown as a badge.
// Single letters get fixed colours so Set A and Set B always look the same.
const SET_TONES = ["teal","violet","amber","cobalt","coral","moss"];
const setLabel = name => { const t = String(name || "").trim(); return !t ? "" : /^set\b/i.test(t) ? t : `Set ${t}`; };
function setTone(name){
  const t = String(name || "").trim().toUpperCase();
  if(/^(SET\s*)?[A-Z]$/.test(t)) return SET_TONES[(t.slice(-1).charCodeAt(0) - 65) % SET_TONES.length];
  let h = 0; for(const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SET_TONES[h % SET_TONES.length];
}
const setBadge = name => name ? `<span class="set-badge" style="--set:var(--c-${setTone(name)})">${esc(setLabel(name))}</span>` : "";
const cleanSetName = v => String(v || "").trim().replace(/^set\s+/i, "").slice(0, 20) || null;
function downloadCsv(filename, lines){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], {type:"text/csv"}));
  a.download = filename; a.click();
}

// ---- CSV parsing for shift shell uploads
// Handles quoted fields, "" escapes and CRLF. Drops blank lines.
function parseCsv(text){
  const rows = []; let row = [], field = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for(let i=0; i<text.length; i++){
    const c = text[i];
    if(quoted){
      if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if(c === '"') quoted = true;
    else if(c === ","){ row.push(field); field = ""; }
    else if(c === "\n" || c === "\r"){
      if(c === "\r" && text[i+1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if(field !== "" || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.some(v=>v.trim() !== ""));
}
const SHELL_COLUMNS = {
  lob:["lob","team","line of business"], days:["days","day","days of week","weekdays"],
  start:["start","start time","start_local","starts"], end:["end","end time","end_local","ends"],
  timezone:["timezone","time zone","tz"], seats:["seats","seat","slots","capacity"],
  set:["set","set name","shell set","schedule set","group"],
};
const DAY_WORDS = { sun:0,sunday:0, mon:1,monday:1, tue:2,tues:2,tuesday:2, wed:3,weds:3,wednesday:3,
                    thu:4,thur:4,thurs:4,thursday:4, fri:5,friday:5, sat:6,saturday:6 };
// "Mon-Fri", "Mon Wed Fri", "Sat/Sun", "weekdays", "1,2,3" -> [1,2,3,4,5]; null if unreadable.
function parseDays(text){
  const t = String(text||"").toLowerCase().trim();
  if(/^(daily|every ?day|all)$/.test(t)) return [0,1,2,3,4,5,6];
  if(/^weekdays?$/.test(t)) return [1,2,3,4,5];
  if(/^weekends?$/.test(t)) return [0,6];
  const one = w => w in DAY_WORDS ? DAY_WORDS[w] : (/^[0-6]$/.test(w) ? +w : null);
  const out = new Set();
  const ranged = t.replace(/\s*(?:–|—|-|\bto\b|\bthrough\b|\bthru\b)\s*/g, "-");
  for(const part of ranged.split(/[\s,;|/+&]+|\band\b/).filter(Boolean)){
    const [a, b, extra] = part.split("-");
    if(!a || extra !== undefined) return null;
    const from = one(a), to = b === undefined ? from : one(b);
    if(from === null || to === null) return null;
    for(let d = from; ; d = (d + 1) % 7){ out.add(d); if(d === to) break; }
  }
  return out.size ? [...out].sort((x,y)=>x-y) : null;
}
// "08:00", "8am", "5:30 PM", "1700", "8:00:00 AM" -> "HH:MM"; null if unreadable.
function parseTime(text){
  const m = String(text||"").trim().toLowerCase().replace(/\./g,"")
    .match(/^(\d{1,2}):?(\d{2})?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if(!m) return null;
  let h = +m[1]; const min = +(m[2] || 0), ap = m[3];
  if(ap){ if(h < 1 || h > 12) return null; if(ap[0] === "p" && h !== 12) h += 12; if(ap[0] === "a" && h === 12) h = 0; }
  if(h > 23 || min > 59) return null;
  return `${pad2(h)}:${pad2(min)}`;
}
// Short US/Manila names map to real zones (plain "EST" would ignore daylight saving).
const TZ_ALIASES = {
  et:"America/New_York", est:"America/New_York", edt:"America/New_York", eastern:"America/New_York",
  ct:"America/Chicago", cst:"America/Chicago", cdt:"America/Chicago", central:"America/Chicago",
  mt:"America/Denver", mdt:"America/Denver", mountain:"America/Denver",
  pt:"America/Los_Angeles", pst:"America/Los_Angeles", pdt:"America/Los_Angeles", pacific:"America/Los_Angeles",
  pht:"Asia/Manila", manila:"Asia/Manila", utc:"UTC", gmt:"UTC",
};
function parseTimezone(text){
  const t = String(text||"").trim();
  if(!t) return "America/New_York";
  if(TZ_ALIASES[t.toLowerCase()]) return TZ_ALIASES[t.toLowerCase()];
  if(!t.includes("/")) return null;
  try{ return new Intl.DateTimeFormat("en-US", { timeZone:t }).resolvedOptions().timeZone; }catch{ return null; }
}

// ---- Agents tab
async function adminAgents(){
  el("#panel").innerHTML = (isCoachLob(currentLob) ? `
    <div class="card layer" id="coachAdd">
      <h2>Add coaches to ${esc(currentLob)}</h2>
      <p class="muted">Coaches bid here on the coach shells by their rank, like agents in a LOB. Find each coach (everyone synced from Assembled is listed, including people removed from bidding) and add them. Then upload their ranks below and open the bid window.</p>
      <label for="caFind">Find by name or email</label>
      <input id="caFind" type="search" name="coach-search" autocomplete="off" data-lpignore="true" data-1p-ignore placeholder="For example Nora" />
      <div id="caMsg"></div>
      <div id="caList"></div>
    </div>` : "") + `
    <div class="card layer span-5">
      <h2>Sync from Assembled</h2>
      <p class="muted">Pulls every active person and files them under their top-level team (Sales, Support, Retention and so on). Existing ranks are kept. Run this at the start of each bid cycle.</p>
      <div class="actions"><button id="syncBtn">Sync from Assembled</button></div>
      <div id="syncMsg"></div>
    </div>
    <div class="card span-7 drop">
      ${currentLob ? `
      <h2>Import ${esc(currentLob)} ranks</h2>
      <p class="muted">Upload this LOB's scorecard as a CSV with <b>email</b> and <b>rank</b> columns. Rank 1 bids first. Ranks only compare within ${esc(currentLob)}, so every LOB can start at 1. Agents can share a rank: whoever submitted their bid first goes first. People from other LOBs in the file are skipped.</p>
      <input type="file" id="rankFile" accept=".csv,text/csv" />
      <div class="actions" style="margin-top:10px"><button class="ghost" id="rankTemplate" type="button">Download ${esc(currentLob)} template</button></div>
      <p class="muted" style="margin-top:6px">The template lists everyone in ${esc(currentLob)} with their email and name. Fill in the rank column, save it as CSV, and upload it here. The name column is only there to help you and is ignored.</p>
      <label class="check"><input type="checkbox" id="rankClear" checked /> Clear the rank of anyone in ${esc(currentLob)} who is not in this file</label>
      <div id="rankMsg"></div>
      <div id="rankPreview"></div>
      <div class="actions" id="rankSave" hidden><button id="rankApply">Apply ranks</button></div>` : `
      <h2>Import ranks</h2>
      <p class="muted">Sync from Assembled first. Then pick an LOB under "Working on" and upload that LOB's scorecard.</p>`}
    </div>
    <div class="card">
      <h2>${currentLob ? `${esc(currentLob)} roster` : "Agents"}</h2>
      <label class="check"><input type="checkbox" id="showRemoved" /> Show removed people</label>
      <div class="bulkbar">
        <span id="selCount">0 selected</span>
        <button class="small danger" id="bulkBtn" disabled>Remove selected</button>
        <select id="accomTier" class="bid-filter" aria-label="Accommodation tier">
          <option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option>
        </select>
        <button class="small" id="accomOn" disabled>Approve accommodation</button>
        <button class="small ghost" id="accomOff" disabled>Clear accommodation</button>
        <span class="muted">Tick the box in the header to select everyone shown.</span>
      </div>
      <div id="bulkMsg"></div>
      <div id="agentList" class="muted">Loading</div>
    </div>`;
  el("#syncBtn").onclick = runSync;
  setupCoachAdd();
  if(currentLob){
    el("#rankFile").onchange = previewRanks;
    el("#rankTemplate").onclick = downloadRankTemplate;
    el("#rankClear").onchange = previewRanks;
    el("#rankApply").onclick = applyRanks;
  }
  el("#showRemoved").onchange = loadAgents;
  el("#bulkBtn").onclick = ()=> setExcluded(selectedAgentIds(), !el("#showRemoved").checked);
  el("#accomOn").onclick = ()=> setAccommodation(selectedAgentIds(), true, Number(el("#accomTier").value));
  el("#accomOff").onclick = ()=> setAccommodation(selectedAgentIds(), false);
  loadAgents();
}
async function runSync(){
  const msg = el("#syncMsg"), btn = el("#syncBtn");
  btn.disabled = true; msg.innerHTML = `<div class="msg warn">Syncing from Assembled</div>`;
  try{
    const b = await authedFetch("/api/sync-assembled", { method:"POST" });
    let note = `Synced ${b.synced} people across ${(b.lobs||[]).length} LOBs: ${esc((b.lobs||[]).join(", "))}.`;
    if(b.removed) note += ` ${b.removed} removed people stay out of bidding.`;
    if(b.missingAgentId) note += ` ${b.missingAgentId} have no Assembled agent id and cannot be pushed.`;
    msg.innerHTML = `<div class="msg good">${note}</div>`;
    if(!currentLob) renderAdmin(); else loadAgents();
  }catch(err){ msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  btn.disabled = false;
}

// A rank CSV for the current LOB, pre-filled with everyone on the roster (current rank if any),
// sorted by rank then name. The import reads the email and rank columns and ignores the name.
async function downloadRankTemplate(){
  const msg = el("#rankMsg");
  const { data, error } = await sb.from("agents").select("name,email,rank").eq("lob", currentLob).eq("excluded", false);
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  if(!data.length){ msg.innerHTML = `<div class="msg warn">Nobody in ${esc(currentLob)} yet. Sync from Assembled first.</div>`; return; }
  const c = v => `"${String(v ?? "").replace(/"/g,'""')}"`;
  const rows = [...data].sort((a,b)=>(a.rank ?? Infinity) - (b.rank ?? Infinity) || String(a.name).localeCompare(String(b.name)));
  downloadCsv(`${currentLob.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}-ranks.csv`,
    ["email,name,rank", ...rows.map(r=>[c(r.email), c(r.name), r.rank ?? ""].join(","))]);
  msg.innerHTML = `<div class="msg good">Downloaded a template with ${rows.length} ${esc(currentLob)} agents. Fill in the rank column (1 bids first), save as CSV, and upload it above.</div>`;
}

// Ranks read from the uploaded scorecard for currentLob, waiting for "Apply".
let pendingRanks = null;
async function previewRanks(){
  const msg = el("#rankMsg"), out = el("#rankPreview"), btn = el("#rankApply"), f = el("#rankFile").files[0];
  pendingRanks = null; btn.disabled = true; btn.textContent = "Apply ranks"; out.innerHTML = ""; msg.innerHTML = "";
  el("#rankSave").hidden = true;
  if(!f) return;
  const lob = currentLob, rows = parseCsv(await f.text());
  if(!rows.length){ msg.innerHTML = `<div class="msg err">The file is empty.</div>`; return; }

  // A header row is optional; without one, column 1 is email and column 2 is rank.
  let body = rows, emailCol = 0, rankCol = 1, firstLine = 1;
  const head = rows[0].map(h=>h.trim().toLowerCase());
  if(!head.some(h=>h.includes("@"))){
    emailCol = head.findIndex(h=>["email","e-mail","email address","work email"].includes(h));
    rankCol = head.findIndex(h=>["rank","ranking","position","scorecard rank"].includes(h));
    if(emailCol < 0 || rankCol < 0){
      msg.innerHTML = `<div class="msg err">The first row needs an "email" column and a "rank" column.</div>`; return;
    }
    body = rows.slice(1); firstLine = 2;
  }

  const { data: people, error } = await sb.from("agents").select("id,email,name,lob,rank,excluded");
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  const byEmail = Object.fromEntries(people.map(p=>[String(p.email).toLowerCase(), p]));
  const seen = new Set(), linesByRank = {};
  const checked = body.map((r, i)=>{
    const line = i + firstLine, email = String(r[emailCol] ?? "").trim().toLowerCase();
    const rankText = String(r[rankCol] ?? "").trim(), rank = Number(rankText), p = byEmail[email];
    let status = "ready", note = "";
    if(!email.includes("@")){ status = "error"; note = `"${email}" is not an email`; }
    else if(rankText === ""){ status = "skip"; note = "No rank filled in"; }
    else if(!Number.isInteger(rank) || rank < 1){ status = "error"; note = `Rank "${rankText}" must be a whole number of 1 or more`; }
    else if(!p){ status = "skip"; note = "Not in the roster"; }
    else if(p.lob !== lob){ status = "skip"; note = `In ${p.lob}, not ${lob}`; }
    else if(p.excluded){ status = "skip"; note = "Removed from bidding"; }
    else if(seen.has(email)){ status = "error"; note = "Listed twice in the file"; }
    if(status === "ready"){ seen.add(email); (linesByRank[rank] ||= []).push(line); }
    return { line, email, rank, rankText, p, status, note };
  });
  // Agents may share a rank: auto assign places them by who submitted their bid first.
  for(const c of checked){
    if(c.status === "ready" && linesByRank[c.rank].length > 1) c.shared = linesByRank[c.rank].filter(l=>l!==c.line);
  }
  const sharedRanks = Object.entries(linesByRank).filter(([, lines])=>lines.length > 1);
  const ready = checked.filter(c=>c.status === "ready"), errors = checked.filter(c=>c.status === "error");
  const skipped = checked.filter(c=>c.status === "skip");
  const inFile = new Set(ready.map(c=>c.email));
  const toClear = el("#rankClear").checked
    ? people.filter(p=>p.lob === lob && !p.excluded && p.rank != null && !inFile.has(String(p.email).toLowerCase()))
    : [];

  const statusCell = c => c.status === "ready" ? `<span class="pill ok">${c.p.rank === c.rank ? "Unchanged" : "Ready"}</span>${c.shared
      ? ` <span class="pill warn" title="Shared ranks go to whoever submitted their bid first">Shared with line ${c.shared.join(", ")}</span>` : ""}`
    : c.status === "skip" ? `<span class="pill warn">${esc(c.note)}</span>` : `<span class="pill err">${esc(c.note)}</span>`;
  out.innerHTML = `<table><thead><tr><th>Line</th><th>Name</th><th>Email</th><th>Rank</th><th>Status</th></tr></thead><tbody>
    ${checked.map(c=>`<tr><td>${c.line}</td><td>${esc(c.p ? c.p.name : "")}</td><td>${esc(c.email)}</td>
      <td>${c.p && c.status === "ready" && c.p.rank != null && c.p.rank !== c.rank ? `<span class="muted">${esc(c.p.rank)} &rarr;</span> ` : ""}${esc(c.rankText)}</td>
      <td>${statusCell(c)}</td></tr>`).join("")}
    ${toClear.map(p=>`<tr><td></td><td>${esc(p.name)}</td><td>${esc(p.email)}</td>
      <td><span class="muted">${esc(p.rank)} &rarr;</span> none</td><td><span class="pill warn">Not in file, rank cleared</span></td></tr>`).join("")}
    </tbody></table>`;

  if(errors.length){
    msg.innerHTML = `<div class="msg err">Fix the ${errors.length} problem${errors.length===1?"":"s"} marked below, then choose the file again. Nothing has been changed.</div>`;
    return;
  }
  if(!ready.length && !toClear.length){
    msg.innerHTML = `<div class="msg warn">No ${esc(lob)} ranks found in this file.</div>`; return;
  }
  pendingRanks = { lob, rows: [
    ...ready.map(c=>({ email:c.p.email, rank:c.rank })),
    ...toClear.map(p=>({ email:p.email, rank:null })),
  ] };
  const parts = [`${ready.length} ${esc(lob)} rank${ready.length===1?"":"s"} ready`];
  if(skipped.length) parts.push(`${skipped.length} line${skipped.length===1?"":"s"} skipped (no rank filled in, other LOBs, removed, or not in the roster)`);
  if(toClear.length) parts.push(`${toClear.length} ${toClear.length===1?"person":"people"} in ${esc(lob)} not in the file will have their rank cleared`);
  if(sharedRanks.length) parts.push(`${sharedRanks.length} rank${sharedRanks.length===1?" is":"s are"} shared (${sharedRanks.map(([r, lines])=>`rank ${r}: ${lines.length} agents`).join(", ")}). Agents who share a rank are placed by who submitted their bid first`);
  const applyLabel = `Apply ${ready.length} rank${ready.length===1?"":"s"}`;
  msg.innerHTML = `<div class="msg warn"><b>Preview only, nothing is saved yet.</b> ${parts.join(". ")}. Check the list, then click "${applyLabel}" below it to save.</div>`;
  el("#rankSave").hidden = false;
  btn.disabled = false;
  btn.textContent = applyLabel;
}
// Saves every rank change for the LOB in one request, so it either all applies or none does.
async function applyRanks(){
  const msg = el("#rankMsg"), btn = el("#rankApply");
  if(!pendingRanks || pendingRanks.lob !== currentLob) return;
  btn.disabled = true;
  const { error } = await sb.from("agents").upsert(pendingRanks.rows, { onConflict:"email" });
  if(error){ msg.innerHTML = `<div class="msg err">Nothing was changed: ${esc(error.message)}</div>`; btn.disabled = false; return; }
  msg.innerHTML = `<div class="msg good">Saved ${pendingRanks.rows.length} rank change${pendingRanks.rows.length===1?"":"s"} for ${esc(currentLob)}.</div>`;
  pendingRanks = null; btn.textContent = "Apply ranks";
  el("#rankFile").value = ""; el("#rankPreview").innerHTML = ""; el("#rankSave").hidden = true;
  loadAgents();
}

async function loadAgents(){
  const box = el("#agentList"), lob = currentLob, removed = el("#showRemoved")?.checked || false;
  el("#bulkBtn").textContent = removed ? "Restore selected" : "Remove selected";
  el("#bulkBtn").className = removed ? "small" : "small danger";
  let q = sb.from("agents").select("*").eq("excluded", removed)
    .order("lob").order("rank",{ascending:true,nullsFirst:false}).order("name");
  if(lob) q = q.eq("lob", lob);
  const [{ data, error }, logins, shellsRes] = await Promise.all([
    q, authedFetch("/api/accounts").catch(()=>null),
    lob ? sb.from("shift_shells").select("*").eq("lob", lob).order("id") : Promise.resolve({ data:[] }),
  ]);
  if(error){ box.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; updateSelection(); return; }
  if(!data.length){
    box.innerHTML = removed ? `No removed people${lob?" in this LOB":""}.` : `No agents${lob?" in this LOB":" yet. Run the Assembled sync above"}.`;
    updateSelection(); return;
  }
  // Who has submitted a bid, and how many of their picks they used.
  const lobShells = shellsRes.data || [], shellById = Object.fromEntries(lobShells.map(s=>[s.id, s]));
  const [{ data: bidRows }, manual, { data: lobAsg }] = await Promise.all([
    selectAll(()=>sb.from("bids2").select("id,agent_id,shift_id,priority").in("agent_id", data.map(r=>r.id))),
    loadManual(),
    lob && !removed ? selectAll(()=>sb.from("assignments").select("id,agent_id,shift_id,pushed_at").in("agent_id", data.map(r=>r.id))) : Promise.resolve({ data: [] }),
  ]);
  // Once auto assign has saved results: who has a shift, and how many seats each shell has left.
  const hasResults = (lobAsg || []).length > 0;
  const shiftOf = Object.fromEntries((lobAsg || []).map(a=>[a.agent_id, a.shift_id]));
  const seatsTaken = {}; for(const a of lobAsg || []) seatsTaken[a.shift_id] = (seatsTaken[a.shift_id] || 0) + 1;
  const noShift = r => hasResults && !(r.id in shiftOf);
  const pushedIds = new Set((lobAsg || []).filter(a=>a.pushed_at).map(a=>a.agent_id));
  const manualUse = {};   // shell id -> how many agents are manually assigned to it
  for(const m of Object.values(manual)) manualUse[m.shift_id] = (manualUse[m.shift_id] || 0) + 1;
  const manualCell = r => { const m = manual[r.id]; if(!m) return "";
    const s = shellById[m.shift_id];
    return `<div class="manual-tag" title="Set by ${esc(m.assigned_by)} on ${esc(fmtET(m.assigned_at))}. Auto assign places this first; agents do not see it.">
      <span class="pill manual">Manual</span> ${s ? `${esc(describeShell(s, false))} ${setBadge(s.set_name)}` : `<span class="muted">a shell from another LOB</span>`}</div>`; };
  const bidsOf = {};
  for(const b of bidRows || []) (bidsOf[b.agent_id] ||= []).push(b);
  for(const list of Object.values(bidsOf)) list.sort((a,b)=>a.priority - b.priority);
  const bidCell = r=>{
    const n = (bidsOf[r.id] || []).length;
    if(!n) return `<span class="muted">Not yet</span>`;
    const need = picksNeeded(lobShells.length), full = need && n >= need;
    return `<span class="pill ${full ? "ok" : "warn"}">${full ? "Submitted" : "Partly ranked"}</span>
      ${r.bid_submitted_at ? `<div class="muted bid-count" title="First submitted: ties on rank go to whoever submitted first">${esc(fmtET(r.bid_submitted_at))}</div>` : ""}
      <div class="muted bid-count">${n} of ${need || n} picks <button class="linkish" data-view-bid="${r.id}" type="button">View</button></div>`;
  };
  const bidders = data.filter(r=>(bidsOf[r.id] || []).length).length;
  const loginOf = r => logins ? (logins.accounts[String(r.email).toLowerCase()] || "none") : "unknown";
  const loginPill = s => s === "active" ? `<span class="pill ok">Active</span>`
    : s === "reset" ? `<span class="pill warn">Reset pending</span>`
    : s === "none" ? `<span class="muted">Not set up</span>` : `<span class="muted">?</span>`;
  const active = data.filter(r=>loginOf(r) === "active").length;
  const accommodated = data.filter(r=>r.accommodation).length;
  const tierCounts = [1, 2, 3, null].map(t=>({ t, n: data.filter(r=>r.accommodation && accomTier(r) === t).length })).filter(x=>x.n);
  const withoutShift = data.filter(noShift).length;
  const me = (currentUser.email||"").toLowerCase();
  box.innerHTML = `
    <div class="roster-summary">
      <span><b>${bidders}</b> of ${data.length} ${data.length===1?"has":"have"} submitted a bid</span>
      ${logins ? `<span><b>${active}</b> of ${data.length} ${data.length===1?"has":"have"} set up a login</span>` : ""}
      ${accommodated ? `<span><b>${accommodated}</b> approved for accommodation (${tierCounts.map(x=>`${x.t ? `Tier ${x.t}` : `<b class="err-text">no tier</b>`}: ${x.n}`).join(", ")})</span>` : ""}
      ${withoutShift ? `<span><b class="err-text">${withoutShift}</b> without a shift${canAssignManually ? `: use <b>Give open seat</b>` : ""}</span>` : ""}
      <label class="inline-label" for="bidFilter">Show</label>
      <select id="bidFilter" class="bid-filter">
        <option value="all">Everyone</option>
        <option value="yes">Bid submitted</option>
        <option value="no">No bid yet</option>
        <option value="accom">Accommodation</option>
        ${hasResults ? `<option value="noshift">No shift yet</option>` : ""}
      </select>
    </div>
    <table><thead><tr>
      <th class="pick"><input type="checkbox" id="pickAll" aria-label="Select everyone shown" /></th>
      ${lob ? "" : "<th>LOB</th>"}<th>Rank</th><th>Name</th><th>Email</th><th>Assembled</th><th>Login</th><th>Bid</th><th></th>
    </tr></thead><tbody>
    ${data.map(r=>`<tr data-agent-row="${r.id}" data-bid="${(bidsOf[r.id] || []).length ? "yes" : "no"}" data-accom="${r.accommodation ? "yes" : "no"}" data-noshift="${noShift(r) ? "yes" : "no"}">
      <td class="pick"><input type="checkbox" class="pick-one" value="${r.id}" aria-label="Select ${esc(r.name)}" /></td>
      ${lob ? "" : `<td>${esc(r.lob)}</td>`}<td>${isCoachLob(lob) && !removed
        ? `<input class="rank-input" type="number" min="1" step="1" inputmode="numeric" data-rank-id="${r.id}" value="${r.rank ?? ""}" placeholder="-" aria-label="Rank for ${esc(r.name)}" />`
        : rankChip(r.rank)}</td>
      <td>${esc(r.name)} ${accomBadge(r)}</td><td>${esc(r.email)}</td>
      <td>${r.assembled_agent_id?`<span class="pill ok">linked</span>`:`<span class="pill warn">no agent id</span>`}</td>
      <td>${loginPill(loginOf(r))}</td>
      <td>${bidCell(r)}${manualCell(r)}${noShift(r) ? `<div class="no-shift"><span class="pill err">No shift yet</span></div>` : ""}</td>
      <td style="text-align:right;white-space:nowrap">
        ${canAssignManually && lob && !removed ? `<button class="small ${noShift(r) ? "" : "ghost"}" data-manual="${r.id}">${noShift(r) ? "Give open seat" : hasResults ? "Move shift" : manual[r.id] ? "Change shift" : "Assign shift"}</button>` : ""}
        ${loginOf(r) === "active" && String(r.email).toLowerCase() !== me
          ? `<button class="small ghost" data-reset="${esc(r.email)}" data-name="${esc(r.name)}">Reset login</button>` : ""}
        <button class="small ${removed?"ghost":"danger"}" data-id="${r.id}">${removed?"Restore":"Remove"}</button>
      </td>
    </tr>`).join("")}</tbody></table>`;
  // Coach groups are small, so their ranks can be typed in here; each change saves straight away.
  box.querySelectorAll("input[data-rank-id]").forEach(inp=>{
    inp.onchange = async ()=>{
      const raw = inp.value.trim(), rank = raw === "" ? null : Number(raw);
      if(rank !== null && !(Number.isInteger(rank) && rank >= 1)){ inp.classList.add("bad"); inp.title = "Use a whole number from 1, or leave it empty for no rank"; return; }
      inp.classList.remove("bad", "saved"); inp.disabled = true;
      const { data: done, error } = await sb.from("agents").update({ rank }).eq("id", Number(inp.dataset.rankId)).select("id");
      inp.disabled = false;
      if(error || !done?.length){ inp.classList.add("bad"); inp.title = error ? error.message : "Could not save this rank"; return; }
      inp.classList.add("saved"); inp.title = rank === null ? "No rank" : `Saved: rank ${rank}`;
    };
  });
  box.querySelectorAll("button[data-reset]").forEach(b=>{
    b.onclick = ()=> resetLogin(b.dataset.reset, b.dataset.name);
  });
  el("#bidFilter").onchange = e=>{
    const want = e.target.value;
    box.querySelectorAll("tr[data-agent-row]").forEach(tr=>{
      tr.hidden = want === "accom" ? tr.dataset.accom !== "yes" : want === "noshift" ? tr.dataset.noshift !== "yes" : want !== "all" && tr.dataset.bid !== want;
      const view = tr.nextElementSibling;
      if(view && view.classList.contains("bid-view-row")) view.hidden = tr.hidden;
    });
    box.querySelectorAll(".pick-one").forEach(c=>{ if(c.closest("tr").hidden) c.checked = false; });
    updateSelection();
  };
  // Manual assignment (only for manual assigners): pick a shell for this agent under their row.
  box.querySelectorAll("button[data-manual]").forEach(b=>{
    b.onclick = ()=>{
      const tr = b.closest("tr"), id = Number(b.dataset.manual), current = manual[id];
      const open = box.querySelector(`tr.manual-row[data-for="${id}"]`);
      if(open){ open.remove(); return; }
      const agent = data.find(r=>r.id === id), name = agent?.name || "this agent";
      // After auto assign: an agent with no shift gets an open seat, and an agent with a shift can
      // move to one. Either way it is saved to the results now, without re-running Auto assign.
      if(agent && hasResults){
        const moving = !noShift(agent), from = moving ? shellById[shiftOf[id]] : null, pushed = moving && pushedIds.has(id);
        const openShells = [...lobShells].filter(s=>s.id !== shiftOf[id] && s.seats - (seatsTaken[s.id] || 0) > 0)
          .sort((a,c)=>String(a.set_name || "").localeCompare(String(c.set_name || "")) || a.id - c.id);
        const what = moving ? "Move" : "Give";
        tr.insertAdjacentHTML("afterend", `<tr class="manual-row" data-for="${id}"><td colspan="${tr.children.length}"><div class="manual-edit">
          ${moving ? `<p class="seat-now">Now on: <b>${from ? esc(describeShell(from, false)) : "a shell from another LOB"}</b> ${from ? setBadge(from.set_name) : ""}</p>` : ""}
          ${pushed ? `<p class="msg warn">${esc(name)}'s schedule is already in Assembled, and moving them here does not change Assembled. Delete their new-schedule shifts in Assembled first, then move them and push them again.</p>
          <label class="check"><input type="checkbox" class="mPushedOk" /> I have deleted ${esc(name)}'s shifts in Assembled</label>` : ""}
          ${openShells.length ? `
          <label for="seatPick${id}">${moving ? `Move ${esc(name)} to a shell with an open seat` : `Give ${esc(name)} an open seat`}</label>
          <select id="seatPick${id}"><option value="">Pick a shell with an open seat</option>${openShells.map(s=>{ const left = s.seats - (seatsTaken[s.id] || 0);
            return `<option value="${s.id}">${esc(describeShell(s, false))}${s.set_name ? ` (${esc(setLabel(s.set_name))})` : ""}, ${left} of ${s.seats} open</option>`; }).join("")}</select>
          <p class="muted">Saved to the ${esc(lob)} results straight away, without re-running Auto assign, so nobody else's shift changes${moving ? " and their current seat opens up for someone else" : ""}. It shows as Manual in Results, and if Auto assign is ever run again they keep this shell.</p>
          <div class="actions"><button class="small mSave" type="button">${moving ? "Move to this shell" : "Give this seat"}</button><button class="small ghost mCancel" type="button">Cancel</button></div>`
          : `<p class="msg warn">${moving ? "No other" : "Every"} ${esc(lob)} shell has an open seat. Add a seat or a shell on the Shift shells tab first.</p>
          <div class="actions"><button class="small ghost mCancel" type="button">Close</button></div>`}
          <div class="mMsg"></div></div></td></tr>`);
        const row = tr.nextElementSibling, msg = row.querySelector(".mMsg");
        row.querySelector(".mCancel").onclick = ()=> row.remove();
        if(row.querySelector(".mSave")) row.querySelector(".mSave").onclick = async ()=>{
          const shift_id = Number(row.querySelector("select").value);
          if(!shift_id){ msg.innerHTML = `<div class="msg err">Pick a shell first.</div>`; return; }
          if(pushed && !row.querySelector(".mPushedOk").checked){ msg.innerHTML = `<div class="msg err">Delete their shifts in Assembled first, then tick the box.</div>`; return; }
          if(moving && !confirm(`${what} ${name} to ${describeShell(shellById[shift_id], false)}?

Their current shell gets an open seat. Nobody else changes.`)) return;
          row.querySelector(".mSave").disabled = true;
          const fn = moving ? "move_to_open_seat" : "assign_open_seat";
          if(moving) await sb.rpc("expire_closed_trades");   // an unanswered trade from a closed window no longer blocks the move
          const { error } = await sb.rpc(fn, moving ? { p_agent_id:id, p_shift_id:shift_id, p_pushed_ok:pushed } : { p_agent_id:id, p_shift_id:shift_id });
          if(error){
            row.querySelector(".mSave").disabled = false;
            msg.innerHTML = `<div class="msg err">${esc(new RegExp(fn).test(error.message) ? "Run the updated manual-assignments.sql in Supabase first." : error.message)}</div>`; return;
          }
          const pub = await lobPublished(lob);
          await loadAgents();
          el("#bulkMsg").innerHTML = `<div class="msg good">${esc(name)} ${moving ? "moved to" : "now has"} ${esc(describeShell(shellById[shift_id], false))}.
            ${pub ? "Results are published, so they can see it now." : pub === null ? "They will see it once you publish the results." : ""}
            ${pushed ? "<b>Push them again</b>: " : "To put it in Assembled, use "}Apply to Assembled with <b>Only the agents I pick</b>.</div>`;
        };
        return;
      }
      const options = [...lobShells].sort((a,c)=>String(a.set_name || "").localeCompare(String(c.set_name || "")) || a.id - c.id).map(s=>{
        const used = (manualUse[s.id] || 0) - (current && current.shift_id === s.id ? 1 : 0), full = used >= s.seats;
        return `<option value="${s.id}" ${current && current.shift_id === s.id ? "selected" : ""} ${full ? "disabled" : ""}>${esc(describeShell(s, false))}${s.set_name ? ` (${esc(setLabel(s.set_name))})` : ""}, ${s.seats} seat${s.seats===1?"":"s"}${used ? `, ${used} manually assigned` : ""}${full ? " (full)" : ""}</option>`;
      }).join("");
      tr.insertAdjacentHTML("afterend", `<tr class="manual-row" data-for="${id}"><td colspan="${tr.children.length}"><div class="manual-edit">
        <label for="manualPick${id}">Assign ${esc(name)} directly to</label>
        <select id="manualPick${id}"><option value="">Pick a shift shell</option>${options}</select>
        <p class="muted">Auto assign places this agent first, ahead of every accommodation tier, and ignores their own picks. The agent's bidding page does not change, and other agents still see this shell as before.</p>
        <div class="actions">
          <button class="small mSave" type="button">${current ? "Save change" : "Assign"}</button>
          ${current ? `<button class="small danger mRemove" type="button">Remove manual assignment</button>` : ""}
          <button class="small ghost mCancel" type="button">Cancel</button>
        </div><div class="mMsg"></div></div></td></tr>`);
      const row = tr.nextElementSibling, msg = row.querySelector(".mMsg");
      row.querySelector(".mCancel").onclick = ()=> row.remove();
      row.querySelector(".mSave").onclick = async ()=>{
        const shift_id = Number(row.querySelector("select").value);
        if(!shift_id){ msg.innerHTML = `<div class="msg err">Pick a shift shell first.</div>`; return; }
        const { error } = await sb.from("manual_assignments").upsert({ agent_id:id, shift_id }, { onConflict:"agent_id" });
        if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
        await loadAgents();
        el("#bulkMsg").innerHTML = `<div class="msg good">${esc(name)} is manually assigned to ${esc(describeShell(shellById[shift_id], false))}. Auto assign will place them first.</div>`;
      };
      if(row.querySelector(".mRemove")) row.querySelector(".mRemove").onclick = async ()=>{
        const { error } = await sb.from("manual_assignments").delete().eq("agent_id", id);
        if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
        await loadAgents();
        el("#bulkMsg").innerHTML = `<div class="msg good">Removed ${esc(name)}'s manual assignment. Auto assign will use their picks again.</div>`;
      };
    };
  });
  // Shows one agent's ranking, in order, under their row.
  box.querySelectorAll("button[data-view-bid]").forEach(b=>{
    b.onclick = ()=>{
      const tr = b.closest("tr"), open = tr.nextElementSibling;
      if(open && open.classList.contains("bid-view-row")){ open.remove(); b.textContent = "View"; return; }
      const cols = tr.children.length, list = bidsOf[Number(b.dataset.viewBid)] || [];
      tr.insertAdjacentHTML("afterend", `<tr class="bid-view-row"><td colspan="${cols}"><ol class="bid-view">
        ${list.map(x=>{ const s = shellById[x.shift_id];
          return `<li>${s ? `${esc(describeShell(s, false))} ${setBadge(s.set_name)}` : `<span class="muted">shell from another LOB (#${x.shift_id})</span>`}</li>`; }).join("")}
      </ol></td></tr>`);
      b.textContent = "Hide";
    };
  });
  el("#pickAll").onchange = e=>{
    box.querySelectorAll(".pick-one").forEach(c=>{ c.checked = e.target.checked; });
    updateSelection();
  };
  box.querySelectorAll(".pick-one").forEach(c=>{ c.onchange = updateSelection; });
  box.querySelectorAll("button[data-id]").forEach(b=>{
    b.onclick = ()=> setExcluded([Number(b.dataset.id)], !removed);
  });
  updateSelection();
}
function selectedAgentIds(){
  return [...document.querySelectorAll("#agentList .pick-one:checked")].map(c=>Number(c.value));
}
function updateSelection(){
  const n = selectedAgentIds().length, boxes = document.querySelectorAll("#agentList .pick-one"), all = el("#pickAll");
  el("#selCount").textContent = `${n} selected`;
  el("#bulkBtn").disabled = !n;
  const removed = el("#showRemoved")?.checked;
  for(const id of ["#accomOn", "#accomOff"]){ const b = el(id); if(b){ b.disabled = !n; b.hidden = !!removed; } }
  if(el("#accomTier")) el("#accomTier").hidden = !!removed;
  if(all){ all.checked = n>0 && n===boxes.length; all.indeterminate = n>0 && n<boxes.length; }
}
// For forgotten passwords: the old password stops working and the person creates a new one
// the next time they enter their email on the sign-in page.
async function resetLogin(email, name){
  const msg = el("#bulkMsg");
  if(!confirm(`Reset ${name}'s login?\n\nTheir current password stops working right away. Next time they enter ${email} on the sign-in page, they will be asked to create a new password.\n\nTell them to do it soon: until they do, anyone who enters their email can set the password.`)) return;
  try{
    await authedFetch("/api/accounts", { method:"POST", body:JSON.stringify({ emails:[email] }) });
    msg.innerHTML = `<div class="msg good">Reset ${esc(name)}'s login. Tell them to go to ${esc(location.origin)}, enter ${esc(email)}, and create a new password.</div>`;
  }catch(err){ msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  loadAgents();
}
// Manual assignments, agent id -> { agent_id, shift_id, assigned_by, assigned_at }. Empty if the
// table is not set up yet. All admins can read them; only manual assigners can change them.
async function loadManual(){
  const { data, error } = await selectAll(()=>sb.from("manual_assignments").select("agent_id,shift_id,assigned_by,assigned_at"), "agent_id");
  return error ? {} : Object.fromEntries((data || []).map(m=>[m.agent_id, m]));
}
// Approved accommodations go before everyone else in auto assign (see assignShifts).
async function setAccommodation(ids, on, tier){
  const msg = el("#bulkMsg");
  if(!ids.length) return;
  if(on && !ACCOM_TIERS.includes(tier)){ msg.innerHTML = `<div class="msg err">Pick Tier 1, 2 or 3 first.</div>`; return; }
  const who = `${ids.length} ${ids.length===1?"person":"people"}`;
  const { data, error } = await sb.from("agents").update({ accommodation: on, accommodation_tier: on ? tier : null }).in("id", ids).select("id");
  if(error){
    msg.innerHTML = `<div class="msg err">${/accommodation/.test(error.message)
      ? "The accommodation tiers are not in the database yet. Run the Accommodation tiers SQL in Supabase first."
      : esc(error.message)}</div>`;
    return;
  }
  msg.innerHTML = `<div class="msg good">${on ? `Approved ${who} for accommodation, Tier ${tier}. In ${esc(currentLob || "their LOB")}, Tier 1 is placed first, then Tier 2, then Tier 3, each in rank order, before everyone else.` : `Cleared the accommodation for ${who}.`}${data && data.length < ids.length ? ` (${ids.length - data.length} could not be changed.)` : ""}</div>`;
  loadAgents();
}
// Removed people stay in the table with excluded = true, so a later sync does not bring them back.
async function setExcluded(ids, excluded){
  const msg = el("#bulkMsg");
  if(!ids.length) return;
  const who = `${ids.length} ${ids.length===1?"person":"people"}`;
  if(excluded && !confirm(`Remove ${who} from shift bidding?\n\nThey stay removed after future syncs from Assembled. You can bring them back with "Show removed people".`)) return;
  el("#bulkBtn").disabled = true;
  const { error } = await sb.from("agents").update({ excluded }).in("id", ids);
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; updateSelection(); return; }
  msg.innerHTML = `<div class="msg good">${excluded?"Removed":"Restored"} ${who}.</div>`;
  loadAgents();
}

// ---- Shift shells tab
async function adminShifts(){
  const lob = esc(currentLob);
  el("#panel").innerHTML = `
    <div class="card layer span-8">
      <h2>Add a ${lob} shift shell</h2>
      <div class="row">
        <div style="max-width:160px"><label for="sSeats">Seats</label><input id="sSeats" type="number" min="1" value="1" /></div>
        <div style="max-width:220px"><label for="sSet">Set (optional)</label>
          <input id="sSet" list="setNames" maxlength="20" placeholder="For example A or B" /><datalist id="setNames"></datalist></div>
      </div>
      <label>Days of the week</label>
      <div class="daypick" id="dayPick">
        ${DAY_NAMES.map((d,i)=>`<label><input type="checkbox" value="${i}" ${i>=1&&i<=5?"checked":""}/> ${d}</label>`).join("")}
      </div>
      <div class="row">
        <div><label>Start time</label><input id="sStart" type="time" value="08:00" /></div>
        <div><label>End time</label><input id="sEnd" type="time" value="17:00" /></div>
        <div><label>Timezone</label><select id="sTz">${TZ_LIST.map(t=>`<option ${t==="America/New_York"?"selected":""}>${t}</option>`).join("")}</select></div>
      </div>
      <div class="actions"><button id="addShift">Add shift shell</button></div>
      <div id="shiftMsg"></div>
    </div>
    <aside class="note span-4 drop">
      <h3>Good to know</h3>
      <p>If the end time is earlier than the start time, the shift is overnight and ends the next day.</p>
      <p>Seats is how many agents can win this shell.</p>
      <p>Times are local to the timezone you pick.</p>
      <p>Only ${lob} agents can see and bid on ${lob} shells.</p>
    </aside>
    <div class="card start-3">
      <h2>Upload ${lob} shift shells from CSV</h2>
      <p class="muted">Columns: <b>days, start, end, timezone, seats</b>, and optionally <b>set</b> (for example A or B), in any order. Days like <b>Mon-Fri</b> or <b>Sat Sun</b>; times like <b>08:00</b> or <b>5:30 PM</b>; timezone like <b>America/New_York</b> or <b>ET</b> (blank means America/New_York); seats blank means 1. A <b>lob</b> column is optional: rows for another LOB are skipped. You will see a preview before anything is saved.</p>
      <input type="file" id="shellCsvFile" accept=".csv,text/csv" />
      <div class="actions"><button class="ghost" id="shellCsvTemplate">Download template</button></div>
      <div id="shellCsvMsg"></div>
      <div id="shellCsvPreview"></div>
      <div class="actions" id="shellCsvSave" hidden><button id="shellCsvAdd">Add shift shells</button></div>
    </div>
    <div class="card"><h2>${lob} shift shells</h2><div id="shiftList" class="muted">Loading</div></div>`;
  el("#addShift").onclick = addShift;
  el("#shellCsvFile").onchange = previewShellCsv;
  el("#shellCsvAdd").onclick = addShellCsv;
  el("#shellCsvTemplate").onclick = ()=> downloadCsv(`${currentLob.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}-shift-shells.csv`, [
    "set,days,start,end,timezone,seats",
    "A,Mon-Fri,08:00,17:00,America/New_York,4",
    "A,Sat Sun,10:00,19:00,America/New_York,2",
    "B,Mon-Thu,22:00,07:00,America/Chicago,3",
  ]);
  loadShellList();
}

// Shift shells read from the uploaded CSV that passed every check, waiting for "Add".
let pendingShells = [];
async function previewShellCsv(){
  const msg = el("#shellCsvMsg"), out = el("#shellCsvPreview"), addBtn = el("#shellCsvAdd"), f = el("#shellCsvFile").files[0];
  pendingShells = []; addBtn.disabled = true; addBtn.textContent = "Add shift shells"; out.innerHTML = ""; msg.innerHTML = "";
  el("#shellCsvSave").hidden = true;
  if(!f) return;
  const rows = parseCsv(await f.text());
  if(rows.length < 2){ msg.innerHTML = `<div class="msg err">The file needs a header row and at least one shift.</div>`; return; }

  const header = rows[0].map(h=>h.trim().toLowerCase());
  const col = {};
  for(const [key, names] of Object.entries(SHELL_COLUMNS)) col[key] = header.findIndex(h=>names.includes(h));
  const missing = ["days","start","end"].filter(k=>col[k] < 0);
  if(missing.length){
    msg.innerHTML = `<div class="msg err">Missing column${missing.length>1?"s":""}: ${missing.join(", ")}. The first row must be headers, e.g. days,start,end,timezone,seats</div>`;
    return;
  }

  const [lobs, existingRes] = await Promise.all([ getLobs(true), sb.from("shift_shells").select("lob,days,start_local,end_local,timezone,set_name") ]);
  const lobByLower = Object.fromEntries(lobs.map(l=>[l.toLowerCase(), l]));
  const keyOf = s => [s.lob, s.days, s.start_local, s.end_local, s.timezone, s.set_name || ""].join("|");
  const seen = new Set((existingRes.data||[]).map(keyOf)), inFile = new Set();
  const cell = (r, k) => col[k] < 0 ? "" : String(r[col[k]] ?? "").trim();

  const checked = rows.slice(1).map((r, i)=>{
    const line = i + 2, problems = [];
    const lobText = cell(r,"lob"), namedLob = lobText ? lobByLower[lobText.toLowerCase()] : currentLob;
    if(!namedLob) problems.push(`Unknown LOB "${lobText}"`);
    else if(namedLob !== currentLob){
      return { line, shell:null, status:"other", problems:[`Belongs to ${namedLob}`], raw:{ lob:lobText, set:cell(r,"set"), days:cell(r,"days"),
        start:cell(r,"start"), end:cell(r,"end"), timezone:cell(r,"timezone"), seats:cell(r,"seats") } };
    }
    const lob = currentLob;
    const days = parseDays(cell(r,"days"));
    if(!days) problems.push(`Can't read days "${cell(r,"days")}"`);
    const start_local = parseTime(cell(r,"start")), end_local = parseTime(cell(r,"end"));
    if(!start_local) problems.push(`Can't read start "${cell(r,"start")}"`);
    if(!end_local) problems.push(`Can't read end "${cell(r,"end")}"`);
    if(start_local && start_local === end_local) problems.push("Start and end are the same");
    const timezone = parseTimezone(cell(r,"timezone"));
    if(!timezone) problems.push(`Unknown timezone "${cell(r,"timezone")}"`);
    const seatsText = cell(r,"seats"), seats = seatsText === "" ? 1 : Number(seatsText);
    if(!Number.isInteger(seats) || seats < 1) problems.push(`Seats must be a whole number of 1 or more`);

    const shell = problems.length ? null : {
      lob, seats, days: days.join(","), start_local, end_local, timezone, set_name: cleanSetName(cell(r,"set")),
      schedule: `${days.map(d=>DAY_NAMES[d]).join(",")} ${start_local} to ${end_local} ${timezone}`,
    };
    let status = problems.length ? "error" : "ready";
    if(shell){
      const k = keyOf(shell);
      if(seen.has(k)) status = "exists";
      else if(inFile.has(k)) status = "duplicate";
      else inFile.add(k);
    }
    return { line, shell, status, problems, raw: { lob: cell(r,"lob"), set: cell(r,"set"), days: cell(r,"days"), start: cell(r,"start"), end: cell(r,"end"), timezone: cell(r,"timezone"), seats: seatsText } };
  });

  pendingShells = checked.filter(c=>c.status === "ready").map(c=>c.shell);
  const count = s => checked.filter(c=>c.status === s).length;
  const nExists = count("exists"), nRepeat = count("duplicate"), nErr = count("error"), nOther = count("other");
  const showLob = col.lob >= 0, showSet = col.set >= 0;
  const statusCell = c => c.status === "ready" ? `<span class="pill ok">Ready</span>`
    : c.status === "exists" ? `<span class="pill warn">Already exists</span>`
    : c.status === "duplicate" ? `<span class="pill warn">Repeated in file</span>`
    : c.status === "other" ? `<span class="pill warn">${esc(c.problems[0])}, skipped</span>`
    : `<span class="pill err">${esc(c.problems.join("; "))}</span>`;
  out.innerHTML = `<table><thead><tr><th>Line</th>${showLob ? "<th>LOB</th>" : ""}${showSet ? "<th>Set</th>" : ""}<th>Days</th><th>Time</th><th>Timezone</th><th>Seats</th><th>Status</th></tr></thead><tbody>
    ${checked.map(c=>{
      const s = c.shell;
      return `<tr><td>${c.line}</td>
        ${showLob ? `<td>${esc(s ? s.lob : c.raw.lob)}</td>` : ""}
        ${showSet ? `<td>${s ? (setBadge(s.set_name) || '<span class="muted">none</span>') : esc(c.raw.set)}</td>` : ""}
        <td>${esc(s ? s.days.split(",").map(d=>DAY_NAMES[+d]).join(", ") : c.raw.days)}</td>
        <td>${esc(s ? `${s.start_local} to ${s.end_local}` : `${c.raw.start} to ${c.raw.end}`)}</td>
        <td>${esc(s ? s.timezone : c.raw.timezone)}</td>
        <td>${esc(s ? s.seats : c.raw.seats)}</td>
        <td>${statusCell(c)}</td></tr>`;
    }).join("")}</tbody></table>`;

  const parts = [`${pendingShells.length} ${esc(currentLob)} shell${pendingShells.length===1?"":"s"} ready to add`];
  if(nOther) parts.push(`${nOther} belong${nOther===1?"s":""} to another LOB and will be skipped`);
  if(nExists) parts.push(`${nExists} already ${nExists===1?"exists":"exist"} and will be skipped`);
  if(nRepeat) parts.push(`${nRepeat} ${nRepeat===1?"is a repeat":"are repeats"} of an earlier line and will be skipped`);
  if(nErr) parts.push(`${nErr} ${nErr===1?"has a problem":"have problems"} and will be skipped`);
  const addLabel = `Add ${pendingShells.length} shift shell${pendingShells.length===1?"":"s"}`;
  msg.innerHTML = `<div class="msg warn"><b>Preview only, nothing is saved yet.</b> ${parts.join(". ")}.${pendingShells.length ? ` Check the list, then click "${addLabel}" below it to save.` : ""}</div>`;
  if(pendingShells.length){
    el("#shellCsvSave").hidden = false;
    addBtn.disabled = false;
    addBtn.textContent = addLabel;
  }
}
async function addShellCsv(){
  const msg = el("#shellCsvMsg"), addBtn = el("#shellCsvAdd");
  if(!pendingShells.length) return;
  addBtn.disabled = true;
  const { error } = await sb.from("shift_shells").insert(pendingShells);
  if(error){ msg.innerHTML = `<div class="msg err">Nothing was added: ${esc(error.message)}</div>`; addBtn.disabled = false; return; }
  msg.innerHTML = `<div class="msg good">Saved ${pendingShells.length} ${esc(currentLob)} shift shell${pendingShells.length===1?"":"s"}. They are in the list below.</div>`;
  pendingShells = []; addBtn.textContent = "Add shift shells";
  el("#shellCsvFile").value = ""; el("#shellCsvPreview").innerHTML = ""; el("#shellCsvSave").hidden = true;
  loadShellList();
}
async function addShift(){
  const msg = el("#shiftMsg");
  const lob = currentLob;
  const seats = parseInt(el("#sSeats").value,10);
  const days = [...document.querySelectorAll("#dayPick input:checked")].map(i=>i.value);
  const start_local = el("#sStart").value, end_local = el("#sEnd").value, timezone = el("#sTz").value;
  if(isNaN(seats) || seats < 1 || !days.length || !start_local || !end_local){
    msg.innerHTML = `<div class="msg err">Pick at least one day, start and end times, and seats.</div>`; return;
  }
  const names = days.map(n=>DAY_NAMES[+n]).join(",");
  const schedule = `${names} ${start_local} to ${end_local} ${timezone}`;
  const set_name = cleanSetName(el("#sSet").value);
  const { error } = await sb.from("shift_shells")
    .insert([{ lob, seats, days: days.join(","), start_local, end_local, timezone, schedule, set_name }]);
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  msg.innerHTML = `<div class="msg good">Shift shell added${set_name ? ` to ${esc(setLabel(set_name))}` : ""}.</div>`;
  loadShellList();
}
// How the shell list is ordered: as set up, by how many agents picked it, or by #1 picks.
let shellSort = "list", shellShow = "all";
async function loadShellList(){
  const box = el("#shiftList");
  const [{ data, error }, { data: lobAgents }] = await Promise.all([
    sb.from("shift_shells").select("*").eq("lob", currentLob).order("set_name", { ascending:true, nullsFirst:false }).order("id"),
    sb.from("agents").select("id,name,rank").eq("lob", currentLob).eq("excluded", false),
  ]);
  if(error){ box.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  // Demand: which agents put each shell in their picks, and at what position.
  // Filled: how many of the LOB's agents the saved auto assign results put on each shell.
  const agentById = Object.fromEntries((lobAgents || []).map(a=>[a.id, a]));
  const [{ data: lobBids }, { data: lobAsg }] = lobAgents?.length
    ? await Promise.all([
        selectAll(()=>sb.from("bids2").select("id,agent_id,shift_id,priority").in("agent_id", lobAgents.map(a=>a.id))),
        selectAll(()=>sb.from("assignments").select("id,agent_id,shift_id").in("agent_id", lobAgents.map(a=>a.id))),
      ])
    : [{ data: [] }, { data: [] }];
  const filledBy = {};   // shell id -> agents assigned to it
  for(const a of lobAsg || []) filledBy[a.shift_id] = (filledBy[a.shift_id] || 0) + 1;
  const assigned = (lobAsg || []).length, filled = id => filledBy[id] || 0, open = r => Math.max(0, r.seats - filled(r.id));
  const pickers = {};   // shell id -> [{ agent, priority }]
  for(const b of lobBids || []) if(agentById[b.agent_id]) (pickers[b.shift_id] ||= []).push({ agent: agentById[b.agent_id], priority: b.priority });
  for(const list of Object.values(pickers)) list.sort((x, y)=>x.priority - y.priority || (x.agent.rank ?? Infinity) - (y.agent.rank ?? Infinity));
  const bidders = new Set((lobBids || []).filter(b=>agentById[b.agent_id]).map(b=>b.agent_id)).size;
  const pickedBy = id => (pickers[id] || []).length, firstPicks = id => (pickers[id] || []).filter(p=>p.priority === 1).length;
  if(shellSort === "picked") data.sort((a, b)=>pickedBy(b.id) - pickedBy(a.id) || firstPicks(b.id) - firstPicks(a.id));
  if(shellSort === "first") data.sort((a, b)=>firstPicks(b.id) - firstPicks(a.id) || pickedBy(b.id) - pickedBy(a.id));
  if(shellSort === "open") data.sort((a, b)=>open(b) - open(a) || filled(a.id) - filled(b.id));
  const filledCell = r => { const n = filled(r.id);
    if(!assigned) return `<span class="muted">-</span>`;
    const cls = n > r.seats ? "over" : n === 0 ? "fill-empty" : n < r.seats ? "fill-part" : "fill-full";
    return `<span class="fill ${cls}" title="${n > r.seats ? "More agents than seats" : n < r.seats ? `${r.seats - n} seat${r.seats - n===1?"":"s"} open` : "Every seat is taken"}">${n} of ${r.seats}</span>`; };
  // What the list shows; the summary above it always counts every shell.
  const shown = !assigned || shellShow === "all" ? data : data.filter(r=>shellShow === "empty" ? filled(r.id) === 0 : open(r) > 0);
  const pct = n => bidders ? Math.round(100 * n / bidders) : 0;
  const demandCell = r => { const n = pickedBy(r.id);
    return n ? `<div class="demand"><span class="meter"><span style="width:${pct(n)}%"></span></span><b>${pct(n)}%</b> <span class="muted">${n} agent${n===1?"":"s"}</span></div>` : `<span class="muted">nobody yet</span>`; };
  const firstCell = r => { const n = firstPicks(r.id);
    return n ? `<span class="${n > r.seats ? "over" : ""}" title="${n} agent${n===1?"":"s"} put this first, for ${r.seats} seat${r.seats===1?"":"s"}">${n}</span>` : `<span class="muted">0</span>`; };
  const setNames = [...new Set(data.map(r=>r.set_name).filter(Boolean))].sort();
  if(el("#setNames")) el("#setNames").innerHTML = setNames.map(n=>`<option value="${esc(n)}"></option>`).join("");
  if(!data.length){ box.innerHTML = `No ${esc(currentLob)} shift shells yet.`; return; }
  const seatsOf = rows => rows.reduce((n, r)=>n + (r.seats||0), 0);
  const perSet = setNames.map(n=>{ const rows = data.filter(r=>r.set_name === n);
    return `${setBadge(n)} ${rows.length} shell${rows.length===1?"":"s"}, ${seatsOf(rows)} seats`; });
  const noSet = data.filter(r=>!r.set_name);
  if(setNames.length && noSet.length) perSet.push(`No set: ${noSet.length} shell${noSet.length===1?"":"s"}, ${seatsOf(noSet)} seats`);
  const openSeats = data.reduce((n, r)=>n + open(r), 0), emptyShells = data.filter(r=>filled(r.id) === 0).length;
  box.innerHTML = `<p class="muted">${data.length} shell${data.length===1?"":"s"}, ${seatsOf(data)} seat${seatsOf(data)===1?"":"s"} in total.${assigned
      ? ` Auto assign results: <b>${assigned}</b> filled, <b>${openSeats}</b> open${emptyShells ? ` (${emptyShells} shell${emptyShells===1?"":"s"} nobody got)` : ""}.` : ""}</p>
    ${perSet.length ? `<p class="set-summary">${perSet.join('<span class="sep"></span>')}</p>` : ""}
    <div class="bulkbar">
      <span id="shSel">0 selected</span>
      <label class="inline-label" for="shBulkSet">Set to</label>
      <input id="shBulkSet" class="pick-filter" list="setNames" maxlength="20" placeholder="A or B" style="max-width:110px" />
      <button class="small" id="shBulkApply" type="button" disabled>Apply to selected</button>
      <button class="small ghost" id="shBulkClear" type="button" disabled>Remove set</button>
      <span class="bulk-gap"></span>
      <button class="small ghost" id="shSelAll" type="button">Select all ${shown.length}${shown.length < data.length ? " shown" : ""}</button>
      <button class="small danger" id="shBulkDel" type="button" disabled>Remove selected</button>
    </div>
    <div class="confirm-panel" id="shDelPanel" hidden>
      <p id="shDelText"></p>
      <div id="shDelUsed" hidden>
        <label class="check"><input type="checkbox" id="shDelAlso" /> Also delete the rankings and assignments that use them</label>
        <p class="muted" id="shDelNote"></p>
      </div>
      <div class="actions"><button class="danger" id="shDelGo" type="button">Remove</button><button class="ghost" id="shDelCancel" type="button">Keep them</button></div>
      <div id="shDelMsg"></div>
    </div>
    <div id="shListMsg"></div>
    <div class="demand-head">
      <span>${bidders ? `<b>Picked by</b> is the share of the ${bidders} ${esc(currentLob)} agent${bidders===1?"":"s"} who have bid that put the shell in their picks. <b>As #1</b> is how many put it first; red means more than its seats.`
        : `Nobody in ${esc(currentLob)} has bid yet, so there is no demand to show.`}</span>
      <label class="inline-label" for="shSort">Order</label>
      <select id="shSort" class="bid-filter">
        <option value="list" ${shellSort === "list" ? "selected" : ""}>As set up</option>
        <option value="picked" ${shellSort === "picked" ? "selected" : ""}>Most picked</option>
        <option value="first" ${shellSort === "first" ? "selected" : ""}>Most #1 picks</option>
        ${assigned ? `<option value="open" ${shellSort === "open" ? "selected" : ""}>Most open seats</option>` : ""}
      </select>
      ${assigned ? `<label class="inline-label" for="shShow">Show</label>
      <select id="shShow" class="bid-filter">
        <option value="all" ${shellShow === "all" ? "selected" : ""}>All shells</option>
        <option value="open" ${shellShow === "open" ? "selected" : ""}>With open seats</option>
        <option value="empty" ${shellShow === "empty" ? "selected" : ""}>Nobody got</option>
      </select>` : ""}
    </div>
    ${shown.length ? "" : `<p class="muted">No shells match. Every ${esc(currentLob)} seat is taken.</p>`}
    <table><thead><tr><th class="pick"><input type="checkbox" id="shPickAll" aria-label="Select every shell" /></th>
      <th>Set</th><th>Schedule</th><th>Seats</th><th title="Agents the saved auto assign results put on this shell">Filled</th><th>Picked by</th><th>As #1</th><th></th></tr></thead><tbody>
    ${shown.map(r=>`<tr data-row="${r.id}"><td class="pick"><input type="checkbox" class="sh-pick" value="${r.id}" aria-label="Select shell" /></td>
      <td>${setBadge(r.set_name) || `<span class="muted">none</span>`}</td><td>${esc(describeShell(r, false))}</td><td>${r.seats}</td>
      <td>${filledCell(r)}</td><td>${demandCell(r)}</td><td>${firstCell(r)}</td>
      <td style="text-align:right;white-space:nowrap">${pickedBy(r.id) ? `<button class="small ghost" data-who="${r.id}">Who</button>` : ""}
        <button class="small ghost" data-edit="${r.id}">Edit</button>
        <button class="small danger" data-id="${r.id}">Remove</button></td></tr>`).join("")}
    </tbody></table>`;

  const msg = el("#shListMsg"), picks = ()=> [...box.querySelectorAll(".sh-pick:checked")].map(c=>Number(c.value));
  const updatePicks = ()=>{
    const n = picks().length; el("#shSel").textContent = `${n} selected`;
    el("#shBulkApply").disabled = el("#shBulkClear").disabled = el("#shBulkDel").disabled = !n;
    el("#shBulkDel").textContent = n ? `Remove ${n === data.length ? "all " : ""}${n} selected` : "Remove selected";
    el("#shDelPanel").hidden = true;
    const all = el("#shPickAll"), boxes = box.querySelectorAll(".sh-pick");
    all.checked = n > 0 && n === boxes.length; all.indeterminate = n > 0 && n < boxes.length;
  };
  box.querySelectorAll(".sh-pick").forEach(c=>{ c.onchange = updatePicks; });
  el("#shPickAll").onchange = e=>{ box.querySelectorAll(".sh-pick").forEach(c=>{ c.checked = e.target.checked; }); updatePicks(); };
  const bulkSet = async name=>{
    const ids = picks();
    if(!ids.length) return;
    const { error } = await sb.from("shift_shells").update({ set_name: name }).in("id", ids);
    if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    await loadShellList();
    el("#shListMsg").innerHTML = `<div class="msg good">${name ? `Put ${ids.length} shell${ids.length===1?"":"s"} in ${esc(setLabel(name))}.` : `Removed the set from ${ids.length} shell${ids.length===1?"":"s"}.`}</div>`;
  };
  el("#shBulkApply").onclick = ()=>{
    const name = cleanSetName(el("#shBulkSet").value);
    if(!name){ msg.innerHTML = `<div class="msg err">Type a set name first, for example A.</div>`; return; }
    bulkSet(name);
  };
  el("#shBulkClear").onclick = ()=> bulkSet(null);
  el("#shSelAll").onclick = ()=>{ box.querySelectorAll(".sh-pick").forEach(c=>{ c.checked = true; }); updatePicks(); };

  // Removing several shells: shells that agents ranked or were assigned to can only go
  // together with those rankings and assignments, so the admin chooses whether to include them.
  el("#shBulkDel").onclick = async ()=>{
    const ids = picks(), panel = el("#shDelPanel"), go = el("#shDelGo");
    if(!ids.length) return;
    panel.hidden = false; el("#shDelMsg").innerHTML = ""; el("#shDelUsed").hidden = true;
    el("#shDelText").textContent = "Checking which of these shells are in use"; go.disabled = true;
    const [bidRes, asgRes] = await Promise.all([
      selectAll(()=> sb.from("bids2").select("id,agent_id,shift_id").in("shift_id", ids)),
      selectAll(()=> sb.from("assignments").select("id,agent_id,shift_id").in("shift_id", ids)),
    ]);
    if(bidRes.error || asgRes.error){ el("#shDelText").textContent = (bidRes.error || asgRes.error).message; return; }
    // Shells someone is manually assigned to are always kept; remove the manual assignment first.
    const lockedShells = new Set(Object.values(await loadManual()).map(m=>m.shift_id));
    const locked = ids.filter(id=>lockedShells.has(id));
    const used = new Set([...bidRes.data, ...asgRes.data].map(r=>r.shift_id).filter(id=>!lockedShells.has(id)));
    const unused = ids.filter(id=>!used.has(id) && !lockedShells.has(id));
    const bidders = new Set(bidRes.data.map(r=>r.agent_id)).size, assigned = new Set(asgRes.data.map(r=>r.agent_id)).size;
    const plural = (n, one, many) => `${n} ${n===1 ? one : many}`;
    el("#shDelText").innerHTML = `Remove <b>${plural(ids.length, "shift shell", "shift shells")}</b> from ${esc(currentLob)}? This cannot be undone.`;
    const also = el("#shDelAlso");
    also.checked = false;
    const refresh = ()=>{
      const n = also.checked ? ids.length - locked.length : unused.length;
      go.disabled = !n;
      go.textContent = !used.size ? `Remove ${plural(n, "shell", "shells")}`
        : also.checked ? `Remove ${plural(n, "shell", "shells")} and their rankings`
        : n ? `Remove only the ${plural(n, "unused shell", "unused shells")}` : "Nothing unused to remove";
    };
    if(used.size){
      const who = [bidders ? `${plural(bidders, "agent has", "agents have")} ranked them` : "",
                   assigned ? `${plural(assigned, "agent is", "agents are")} assigned to them` : ""].filter(Boolean).join(" and ");
      el("#shDelUsed").hidden = false;
      el("#shDelNote").innerHTML = `${plural(used.size, "of these shells is", "of these shells are")} in use: ${who}.
        Leave this unticked to remove only the ${plural(unused.length, "shell", "shells")} nobody has used.
        If you tick it, agents keep the rest of their ranking${assigned ? ", and you should re-run Auto assign for the agents who lose their assigned shift" : ""}. Shifts already in Assembled are not changed.`;
    }
    if(locked.length){
      el("#shDelText").insertAdjacentHTML("beforeend", ` <span class="muted">${plural(locked.length, "of them has", "of them have")} a manual assignment and will be kept. Remove the manual assignment on the Agents tab first.</span>`);
    }
    also.onchange = refresh; refresh();
  };
  el("#shDelCancel").onclick = ()=>{ el("#shDelPanel").hidden = true; };
  el("#shDelGo").onclick = async ()=>{
    const go = el("#shDelGo"), out = el("#shDelMsg"), ids = picks(), withUsed = el("#shDelAlso").checked;
    go.disabled = true; out.innerHTML = "";
    const fail = e => { out.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; go.disabled = false; };
    const lockedShells = new Set(Object.values(await loadManual()).map(m=>m.shift_id));
    let targets = ids.filter(id=>!lockedShells.has(id));
    if(withUsed && targets.length){
      for(const table of ["bids2", "assignments"]){
        const { error } = await sb.from(table).delete().in("shift_id", targets);
        if(error) return fail(error);
      }
    }else{
      const [b, a] = await Promise.all([
        selectAll(()=> sb.from("bids2").select("id,shift_id").in("shift_id", ids)),
        selectAll(()=> sb.from("assignments").select("id,shift_id").in("shift_id", ids)),
      ]);
      if(b.error || a.error) return fail(b.error || a.error);
      const used = new Set([...b.data, ...a.data].map(r=>r.shift_id));
      targets = targets.filter(id=>!used.has(id));
    }
    if(!targets.length) return fail(new Error("Every selected shell is in use. Tick the box to remove them with their rankings."));
    const { error } = await sb.from("shift_shells").delete().in("id", targets);
    if(error) return fail(error);
    const kept = ids.length - targets.length;
    await loadShellList();
    el("#shListMsg").innerHTML = `<div class="msg good">Removed ${targets.length} shell${targets.length===1?"":"s"}${withUsed ? " and the rankings and assignments that used them" : ""}.${kept ? ` Kept ${kept} that agents have ranked or been assigned to.` : ""}</div>`;
  };

  box.querySelectorAll("button[data-id]").forEach(b=>{
    b.onclick = async ()=>{
      if(!confirm("Remove this shift shell?")) return;
      const { error } = await sb.from("shift_shells").delete().eq("id", b.dataset.id);
      if(error){
        msg.innerHTML = /foreign key|violates/i.test(error.message)
          ? `<div class="msg err">This shell cannot be removed because agents have ranked it or been assigned to it. Use Edit to change it instead, or tick it and use Remove selected, which can delete it together with its rankings.</div>`
          : `<div class="msg err">${esc(error.message)}</div>`;
        return;
      }
      loadShellList();
    };
  });
  box.querySelectorAll("button[data-edit]").forEach(b=>{
    b.onclick = ()=> editShellRow(data.find(r=>r.id === Number(b.dataset.edit)));
  });
  el("#shSort").onchange = e=>{ shellSort = e.target.value; loadShellList(); };
  if(el("#shShow")) el("#shShow").onchange = e=>{ shellShow = e.target.value; loadShellList(); };
  // Who picked a shell, in order of the position they gave it (then rank), under its row.
  box.querySelectorAll("button[data-who]").forEach(b=>{
    b.onclick = ()=>{
      const tr = b.closest("tr"), open = tr.nextElementSibling;
      if(open && open.classList.contains("who-row")){ open.remove(); b.textContent = "Who"; return; }
      const list = pickers[Number(b.dataset.who)] || [];
      tr.insertAdjacentHTML("afterend", `<tr class="who-row"><td colspan="${tr.children.length}">
        <div class="who-head">${list.length} agent${list.length===1?"":"s"} picked this shell</div>
        <ol class="who-list">${list.map(p=>`<li><span class="pos-chip">#${p.priority}</span> ${esc(p.agent.name)} <span class="muted">${p.agent.rank != null ? `rank ${esc(p.agent.rank)}` : "no rank"}</span></li>`).join("")}</ol>
      </td></tr>`);
      b.textContent = "Hide";
    };
  });
}
// Opens a shell for editing in place of its row in the list.
async function editShellRow(shell){
  const row = document.querySelector(`tr[data-row="${shell.id}"]`);
  if(!row || row.nextElementSibling?.classList.contains("edit-row")) return;
  const days = String(shell.days || "").split(",").map(Number);
  const zones = TZ_LIST.includes(shell.timezone) || !shell.timezone ? TZ_LIST : [shell.timezone, ...TZ_LIST];
  row.hidden = true;
  row.insertAdjacentHTML("afterend", `<tr class="edit-row"><td colspan="${row.children.length}">
    <div class="shell-edit">
      <div class="row">
        <div style="max-width:160px"><label for="eSet${shell.id}">Set</label><input id="eSet${shell.id}" list="setNames" maxlength="20" value="${esc(shell.set_name || "")}" placeholder="none" /></div>
        <div style="max-width:120px"><label for="eSeats${shell.id}">Seats</label><input id="eSeats${shell.id}" type="number" min="1" value="${shell.seats}" /></div>
      </div>
      <label>Days of the week</label>
      <div class="daypick" id="eDays${shell.id}">
        ${DAY_NAMES.map((d,i)=>`<label><input type="checkbox" value="${i}" ${days.includes(i)?"checked":""}/> ${d}</label>`).join("")}
      </div>
      <div class="row">
        <div><label for="eStart${shell.id}">Start time</label><input id="eStart${shell.id}" type="time" value="${esc(shell.start_local || "")}" /></div>
        <div><label for="eEnd${shell.id}">End time</label><input id="eEnd${shell.id}" type="time" value="${esc(shell.end_local || "")}" /></div>
        <div><label for="eTz${shell.id}">Timezone</label><select id="eTz${shell.id}">${zones.map(t=>`<option ${t===shell.timezone?"selected":""}>${esc(t)}</option>`).join("")}</select></div>
      </div>
      <div class="eUsage muted">Checking who has ranked this shell</div>
      <div class="actions">
        <button class="eSave" type="button">Save changes</button>
        <button class="ghost eCancel" type="button">Cancel</button>
      </div>
      <div class="eMsg"></div>
    </div></td></tr>`);
  const edit = row.nextElementSibling, q = sel => edit.querySelector(sel);
  q(".eCancel").onclick = ()=>{ edit.remove(); row.hidden = false; };

  const [{ count: ranked }, { count: assigned }, manualAll] = await Promise.all([
    sb.from("bids2").select("id", { count:"exact", head:true }).eq("shift_id", shell.id),
    sb.from("assignments").select("id", { count:"exact", head:true }).eq("shift_id", shell.id),
    loadManual(),
  ]);
  const manualHere = Object.values(manualAll).filter(m=>m.shift_id === shell.id).length;
  q(".eUsage").innerHTML = ranked || assigned
    ? `<div class="msg warn">${ranked ? `${ranked} agent${ranked===1?" has":"s have"} ranked this shell` : ""}${ranked && assigned ? " and " : ""}${assigned ? `${assigned} ${assigned===1?"is":"are"} assigned to it` : ""}. Their rankings and assignments will follow the new days and times. Shifts already pushed to Assembled are not changed.</div>`
    : "Nobody has ranked or been assigned to this shell yet.";

  q(".eSave").onclick = async ()=>{
    const msg = q(".eMsg");
    const seats = parseInt(el(`#eSeats${shell.id}`).value, 10);
    const dayList = [...edit.querySelectorAll(`#eDays${shell.id} input:checked`)].map(i=>i.value);
    const start_local = el(`#eStart${shell.id}`).value, end_local = el(`#eEnd${shell.id}`).value, timezone = el(`#eTz${shell.id}`).value;
    if(isNaN(seats) || seats < 1 || !dayList.length || !start_local || !end_local){
      msg.innerHTML = `<div class="msg err">Pick at least one day, start and end times, and seats.</div>`; return;
    }
    if(start_local === end_local){ msg.innerHTML = `<div class="msg err">Start and end cannot be the same time.</div>`; return; }
    if(assigned && seats < assigned){
      msg.innerHTML = `<div class="msg err">${assigned} agents are already assigned to this shell, so it needs at least ${assigned} seats. Re-run Auto assign after lowering seats.</div>`; return;
    }
    if(manualHere && seats < manualHere){
      msg.innerHTML = `<div class="msg err">${manualHere} agent${manualHere===1?" is":"s are"} manually assigned to this shell, so it needs at least ${manualHere} seat${manualHere===1?"":"s"}.</div>`; return;
    }
    const changes = {
      set_name: cleanSetName(el(`#eSet${shell.id}`).value), seats, days: dayList.join(","), start_local, end_local, timezone,
      schedule: `${dayList.map(n=>DAY_NAMES[+n]).join(",")} ${start_local} to ${end_local} ${timezone}`,
    };
    q(".eSave").disabled = true;
    const { error } = await sb.from("shift_shells").update(changes).eq("id", shell.id);
    q(".eSave").disabled = false;
    if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    await loadShellList();
    el("#shListMsg").innerHTML = `<div class="msg good">Saved: ${esc(describeShell(changes))}.</div>`;
  };
}

// ---- Bid window tab
async function adminWindow(){
  const lob = esc(currentLob);
  el("#panel").innerHTML = `
    <div class="card layer span-7">
      <h2>${lob} bidding window</h2>
      <div class="row">
        <div><label>Opens (ET)</label><input id="wOpen" type="datetime-local" /></div>
        <div><label>Closes (ET)</label><input id="wClose" type="datetime-local" /></div>
      </div>
      <label class="check"><input type="checkbox" id="wFull" checked /> Agents must use all ${MAX_PICKS} picks before they can save (or rank every ${lob} shift, if there are ${MAX_PICKS} or fewer)</label>
      <div class="actions">
        <button id="wSave">Save window</button>
        <button class="ghost" id="wCloseNow" hidden>Close ${lob} bidding now</button>
        <button class="danger" id="wCancel" hidden>Cancel ${lob} window</button>
      </div>
      <div class="confirm-panel" id="wCancelPanel" hidden>
        <p><b>Cancel the ${lob} bidding window?</b> ${lob} agents will no longer be able to submit or change bids.</p>
        <label class="check"><input type="checkbox" id="wClearBids" /> Also delete the saved rankings of <span id="wBidCount">0 agents</span></label>
        <p class="muted">Leave this unticked to keep everyone's rankings for when you set a new window. Auto assign results and shifts already in Assembled are not affected.</p>
        <div class="actions">
          <button class="danger solid" id="wCancelYes">Yes, cancel the window</button>
          <button class="ghost" id="wCancelNo">Keep the window</button>
        </div>
      </div>
      <div id="wMsg"></div>
    </div>
    <aside class="note span-5 drop">
      <h3>How windows work</h3>
      <p>${lob} agents can only submit or change bids between these times.</p>
      <p>Each LOB has its own window, so LOBs can bid on different days. Saving replaces ${lob}'s old window.</p>
      <p>Agents pick and rank up to ${MAX_PICKS} ${lob} shifts. With "use all picks" on, they cannot save until they have picked ${MAX_PICKS} (or every shell, if ${lob} has ${MAX_PICKS} or fewer), so you always have their 2nd, 3rd and later choices.</p>
      <p>Close bidding now ends an open window early. Everyone's saved rankings are kept and you can run Auto assign straight away.</p>
      <p>Cancelling a window stops ${lob} bidding straight away. You choose whether to keep agents' saved rankings.</p>
    </aside>
    <div class="card start-3"><h2>All LOB windows</h2><div id="wList" class="muted">Loading</div></div>`;
  el("#wSave").onclick = async ()=>{
    const lob = currentLob, o = el("#wOpen").value, c = el("#wClose").value, msg = el("#wMsg");
    if(!o||!c){ msg.innerHTML=`<div class="msg err">Fill in both times.</div>`; return; }
    if(fromETInput(o) >= fromETInput(c)){ msg.innerHTML=`<div class="msg err">The close time must be after the open time.</div>`; return; }
    const { error } = await sb.rpc("replace_bid_window", { p_lob:lob, p_opens:fromETInput(o).toISOString(),
      p_closes:fromETInput(c).toISOString(), p_require_full_ranking:el("#wFull").checked });
    if(error){ msg.innerHTML=`<div class="msg err">${esc(error.message)}</div>`; return; }
    msg.innerHTML=`<div class="msg good">Window saved.</div>`; loadWindows();
  };
  el("#wCancel").onclick = showCancelWindow;
  el("#wCloseNow").onclick = ()=> closeWindowNow(currentLob);
  el("#wCancelNo").onclick = ()=>{ el("#wCancelPanel").hidden = true; el("#wCancel").hidden = false; };
  el("#wCancelYes").onclick = cancelWindow;
  loadWindows();
}
// Agent ids in the current LOB and how many of them have a saved ranking.
async function lobBidders(){
  const { data: agents } = await sb.from("agents").select("id").eq("lob", currentLob);
  const ids = (agents||[]).map(a=>a.id);
  if(!ids.length) return { ids, count:0 };
  const { data: bids } = await selectAll(()=>sb.from("bids2").select("id,agent_id").in("agent_id", ids));
  return { ids, count: new Set((bids||[]).map(b=>b.agent_id)).size };
}
async function showCancelWindow(){
  const { count } = await lobBidders();
  el("#wBidCount").textContent = `${count} agent${count===1?"":"s"}`;
  el("#wClearBids").checked = false;
  el("#wClearBids").disabled = !count;
  el("#wCancel").hidden = true;
  el("#wCancelPanel").hidden = false;
}
// Ends an open window early by moving its close time to now. The window and all saved
// rankings stay, so the LOB shows as Closed and Auto assign can run without a warning.
// The earlier of this computer's clock and the server's, so a slow clock cannot leave a window open.
async function serverNow(){
  let now = Date.now();
  try{
    const r = await fetch("/api/config", { cache:"no-store" });
    const server = Date.parse(r.headers.get("date"));
    if(!isNaN(server)) now = Math.min(now, server);
  }catch{}
  return now;
}

async function closeWindowNow(lob){
  const msg = el("#wMsg");
  if(!confirm(`Close ${lob} bidding now?\n\n${lob} agents will no longer be able to submit or change bids. Their saved rankings are kept.`)) return;
  const now = await serverNow();
  const { data: rows, error } = await sb.from("bid_windows").select("id,opens_at,closes_at").eq("lob", lob);
  const w = (rows || [])[0];
  if(error || !w){ msg.innerHTML = `<div class="msg err">${esc(error ? error.message : `${lob} has no window to close.`)}</div>`; return; }
  if(now < Date.parse(w.opens_at)){ msg.innerHTML = `<div class="msg err">${esc(lob)} bidding has not opened yet. Use Cancel to remove the window instead.</div>`; return; }
  if(now > Date.parse(w.closes_at)){ msg.innerHTML = `<div class="msg warn">${esc(lob)} bidding is already closed.</div>`; loadWindows(); return; }
  const closes = new Date(now - 1000).toISOString();
  const { data: done, error: upErr } = await sb.from("bid_windows").update({ closes_at: closes }).eq("id", w.id).select("id");
  if(upErr || !done || !done.length){ msg.innerHTML = `<div class="msg err">${esc(upErr ? upErr.message : "The window could not be closed.")}</div>`; return; }
  if(lob === currentLob && el("#wClose")) el("#wClose").value = "";
  msg.innerHTML = `<div class="msg good">Closed ${esc(lob)} bidding at ${esc(fmtET(closes))}. Saved rankings are kept. You can run Auto assign for ${esc(lob)} now.</div>`;
  loadWindows();
}
async function cancelWindow(){
  const lob = currentLob, msg = el("#wMsg"), clear = el("#wClearBids").checked, btn = el("#wCancelYes");
  btn.disabled = true;
  const { data: gone, error } = await sb.from("bid_windows").delete().eq("lob", lob).select("id");
  if(error || !gone || !gone.length){
    btn.disabled = false;
    msg.innerHTML = `<div class="msg err">${esc(error ? error.message : `${lob} has no window to cancel.`)}</div>`; return;
  }
  let note = `Cancelled the ${esc(lob)} bidding window. ${esc(lob)} agents can no longer bid.`;
  if(clear){
    const { ids, count } = await lobBidders();
    const { error: bidErr } = ids.length ? await sb.from("bids2").delete().in("agent_id", ids) : { error:null };
    // Their rankings are gone, so their place in line for shared ranks starts over too.
    if(!bidErr && ids.length) await sb.from("agents").update({ bid_submitted_at: null }).in("id", ids);
    note += bidErr
      ? ` The window is cancelled, but their rankings could not be deleted: ${esc(bidErr.message)}`
      : ` Deleted the saved rankings of ${count} agent${count===1?"":"s"}.`;
  } else {
    note += " Their saved rankings are kept for when you set a new window.";
  }
  btn.disabled = false;
  el("#wCancelPanel").hidden = true;
  el("#wOpen").value = ""; el("#wClose").value = ""; el("#wFull").checked = true;
  msg.innerHTML = `<div class="msg good">${note}</div>`;
  loadWindows();
}
async function loadWindows(){
  const box = el("#wList");
  const [{ data, error }, { data: people }, { data: bidRows }] = await Promise.all([
    sb.from("bid_windows").select("*").order("lob"),
    sb.from("agents").select("id,lob").eq("excluded", false),
    selectAll(()=>sb.from("bids2").select("id,agent_id")),
  ]);
  const lobOfAgent = Object.fromEntries((people || []).map(a=>[a.id, a.lob]));
  const biddersIn = lob => new Set((bidRows || []).map(b=>b.agent_id).filter(id=>lobOfAgent[id] === lob)).size;
  const agentsIn = lob => (people || []).filter(a=>a.lob === lob).length;
  if(error){ box.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  const mine = data.find(w=>w.lob===currentLob);
  el("#wCancel").hidden = !mine || !el("#wCancelPanel").hidden;
  const fmt = fmtET, now = Date.now();
  el("#wCloseNow").hidden = !mine || now < Date.parse(mine.opens_at) || now > Date.parse(mine.closes_at);
  if(!data.length){ box.innerHTML = `No windows set.`; return; }
  if(mine && el("#wFull")){
    const toInput = toLocalInput;
    el("#wFull").checked = mine.require_full_ranking !== false;
    if(!el("#wOpen").value) el("#wOpen").value = toInput(mine.opens_at);
    if(!el("#wClose").value) el("#wClose").value = toInput(mine.closes_at);
  }
  box.innerHTML = `<table><thead><tr><th>LOB</th><th>Opens</th><th>Closes</th><th>Must use all picks</th><th>Bids in</th><th>Status</th><th></th></tr></thead><tbody>
    ${data.map(w=>{
      const open = now >= Date.parse(w.opens_at) && now <= Date.parse(w.closes_at);
      const upcoming = now < Date.parse(w.opens_at);
      return `<tr><td>${w.lob===currentLob ? `<b>${esc(w.lob)}</b>` : esc(w.lob)}</td><td>${fmt(w.opens_at)}</td><td>${fmt(w.closes_at)}</td>
        <td>${w.require_full_ranking === false ? "No" : "Yes"}</td>
        <td><b>${biddersIn(w.lob)}</b> of ${agentsIn(w.lob)}</td>
        <td>${open?`<span class="pill ok">Open</span>`:`<span class="pill warn">${upcoming?"Upcoming":"Closed"}</span>`}</td>
        <td style="text-align:right;white-space:nowrap">${open ? `<button class="small ghost" data-close-lob="${esc(w.lob)}">Close now</button> ` : ""}<button class="small danger" data-cancel-lob="${esc(w.lob)}">Cancel</button></td></tr>`;
    }).join("")}</tbody></table>`;
  box.querySelectorAll("button[data-close-lob]").forEach(b=>{ b.onclick = ()=> closeWindowNow(b.dataset.closeLob); });
  // Cancelling works on the LOB you are working on, so switch to the row's LOB first.
  box.querySelectorAll("button[data-cancel-lob]").forEach(b=>{
    b.onclick = async ()=>{
      const lob = b.dataset.cancelLob;
      if(lob !== currentLob){
        if(!leaveUnsavedOk()) return;
        currentLob = lob;
        try{ localStorage.setItem(LOB_KEY, currentLob); }catch{}
        await renderAdmin();
      }
      showCancelWindow();
      el("#wCancelPanel").scrollIntoView({ block:"center", behavior:"smooth" });
    };
  });
}

// ---- Auto assign tab
async function adminAssign(){
  const lob = esc(currentLob);
  el("#panel").innerHTML = `
    <div class="card layer span-8">
      <h2>Run auto assign for ${lob}</h2>
      <p class="muted">Uses ${lob} ranks, ${lob} shift shells and ${lob} bids only.</p>
      <div class="actions"><button id="runBtn">Run auto assign for ${lob}</button></div>
      <div id="result" style="margin-top:16px"></div>
    </div>
    <aside class="note span-4 drop">
      <h3>How it works</h3>
      <ol>
        <li>Agents with a manual assignment get that shift first, before anyone else, whatever they picked.</li>
        <li>Agents approved for accommodation go before everyone else: Tier 1 first, then Tier 2, then Tier 3 (any approved without a tier come after Tier 3). Within a tier they go in rank order, and any without a rank follow in random order. Their picks are used even if they have no rank.</li>
        <li>Then ranked agents who bid: ${lob} rank 1 gets their top pick that still has a seat, then rank 2, and so on. Each agent picks up to ${MAX_PICKS} shells.</li>
        <li>Agents who share a rank are placed by who submitted their bid first. Changing a bid later keeps their place.</li>
        <li>If every shell an agent picked was already taken by someone ranked higher, they get a random open seat from the ${lob} shells left once all picks have been placed. They go first among the random seats, in rank order, followed by ranked agents who did not bid.</li>
        <li>Agents with no rank go last and always get a random open seat, even if they bid.</li>
        <li>If seats run out, the last people get none.</li>
        <li>Running it again replaces ${lob}'s previous results with a fresh draw. Other LOBs are not touched.</li>
      </ol>
    </aside>`;
  el("#runBtn").onclick = runAssign;
}

const ASSIGN_HOW = { manual:"Manual", full:"Random: all picks taken", nobid:"Random: did not bid", norank:"Random: no rank", none:"No seats left" };
const cryptoRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2**32;

// Hands out one LOB's seats. Returns [{ agent, shift, how }] in the order they were decided.
//  0. Manual assignments (manual: agent id -> shell id) take their seat first.
//  1. Agents approved for accommodation go first, by tier (1, 2, 3, then no tier). Within a tier,
//     ranked ones by rank, then unranked ones in random order. Each gets their highest pick (of up
//     to MAX_PICKS) that still has a seat.
//  2. Then ranked agents who bid, best rank first, the same way.
//  3. Everyone else gets a random open seat (each remaining seat equally likely), in the order
//     above: first bidders whose picks were all taken, then those who did not bid, then unranked
//     agents (not accommodated) in random order. Unranked agents' bids are not used.
function assignShifts(agents, shells, bids, random = cryptoRandom, manual = {}){
  const left = {}, shellById = {}, choices = {};
  for(const s of shells){ left[s.id] = s.seats; shellById[s.id] = s; }
  const out = [], placed = new Set();
  for(const a of agents){
    const s = shellById[manual[a.id]];
    if(s && left[s.id] > 0){ left[s.id]--; placed.add(a.id); out.push({ agent:a, shift:s, how:ASSIGN_HOW.manual }); }
  }
  agents = agents.filter(a=>!placed.has(a.id));
  for(const b of [...bids].sort((x,y)=>x.priority - y.priority)) (choices[b.agent_id] ||= []).push(b);
  for(const id in choices) choices[id] = choices[id].slice(0, MAX_PICKS);   // older saves may hold more

  const shuffle = list => {
    for(let i = list.length - 1; i > 0; i--){
      const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  // Same rank: whoever submitted their bid first goes first. Exact ties (for example neither
  // bid) stay in the random order from the shuffle, because sort keeps equal items in place.
  const submitted = a => a.bid_submitted_at ? Date.parse(a.bid_submitted_at) : Infinity;
  const byRankList = list => shuffle([...list]).sort((a,b)=>a.rank - b.rank || (submitted(a) === submitted(b) ? 0 : submitted(a) - submitted(b)));
  const accommodated = [1, 2, 3, 4].flatMap(order => {
    const tier = agents.filter(a=>a.accommodation && accomOrder(a) === order);
    return [...byRankList(tier.filter(a=>a.rank != null)), ...shuffle(tier.filter(a=>a.rank == null))];
  });
  const ranked = byRankList(agents.filter(a=>!a.accommodation && a.rank != null));
  const unranked = shuffle(agents.filter(a=>!a.accommodation && a.rank == null));

  const allFull = [], noBid = [];
  for(const a of [...accommodated, ...ranked]){
    const mine = choices[a.id] || [];
    if(!mine.length){ noBid.push(a); continue; }
    const pick = mine.find(b=>left[b.shift_id] > 0);
    if(!pick){ allFull.push(a); continue; }
    left[pick.shift_id]--;
    out.push({ agent:a, shift:shellById[pick.shift_id], how:`Bid choice #${mine.indexOf(pick) + 1}` });
  }

  const randomSeat = () => {
    const open = shells.filter(s=>left[s.id] > 0), total = open.reduce((n,s)=>n + left[s.id], 0);
    if(!total) return null;
    let n = Math.floor(random() * total);
    for(const s of open){ if(n < left[s.id]){ left[s.id]--; return s; } n -= left[s.id]; }
    return null;
  };
  for(const [group, how] of [[allFull, ASSIGN_HOW.full], [noBid, ASSIGN_HOW.nobid], [unranked, ASSIGN_HOW.norank]]){
    for(const a of group){
      const s = randomSeat();
      out.push({ agent:a, shift:s, how: s ? how : ASSIGN_HOW.none });
    }
  }
  return out;
}
// How a saved assignment came about, worked out from the rules above.
function assignedHow(agent, agentBids, shiftId, manualShift){
  if(manualShift != null && manualShift === shiftId) return ASSIGN_HOW.manual;
  if(agent.rank == null && !agent.accommodation) return ASSIGN_HOW.norank;
  if(!agentBids.length) return ASSIGN_HOW.nobid;
  const mine = [...agentBids].sort((x,y)=>x.priority - y.priority).slice(0, MAX_PICKS);
  const i = mine.findIndex(b=>b.shift_id === shiftId);
  return i >= 0 ? `Bid choice #${i + 1}` : ASSIGN_HOW.full;
}
const howPill = how => `<span class="pill ${how === ASSIGN_HOW.manual ? "manual" : how.startsWith("Bid") || how.startsWith("Traded") ? "ok" : how === ASSIGN_HOW.none ? "err" : "warn"}">${esc(how)}</span>`;

async function runAssign(){
  const out = el("#result"), lob = currentLob;

  const { data: win } = await sb.from("bid_windows").select("*").eq("lob", lob).maybeSingle();
  const now = Date.now();
  if(!win && !confirm(`No bid window is set for ${lob}, so nobody could bid.\n\nEveryone will get a random shift. Run anyway?`)) return;
  if(win && now < Date.parse(win.closes_at) &&
     !confirm(`Bidding for ${lob} is still open until ${fmtET(win.closes_at)}.\n\nAgents who have not bid yet will get a random shift. Run anyway?`)) return;
  out.innerHTML = `<span class="muted">Working</span>`;

  const [agRes, shRes] = await Promise.all([
    sb.from("agents").select("*").eq("lob", lob).eq("excluded", false),
    sb.from("shift_shells").select("*").eq("lob", lob),
  ]);
  if(agRes.error||shRes.error){ out.innerHTML=`<div class="msg err">${esc((agRes.error||shRes.error).message)}</div>`; return; }
  const agents = agRes.data, shells = shRes.data;
  if(!agents.length||!shells.length){ out.innerHTML=`<div class="msg warn">${esc(lob)} needs at least one agent and one shift shell.</div>`; return; }

  const ids = agents.map(a=>a.id);
  const [{ data: bids, error: bErr }, manualRows] = await Promise.all([
    selectAll(()=>sb.from("bids2").select("*").in("agent_id", ids)),
    loadManual(),
  ]);
  if(bErr){ out.innerHTML=`<div class="msg err">${esc(bErr.message)}</div>`; return; }
  const manual = Object.fromEntries(Object.values(manualRows).map(m=>[m.agent_id, m.shift_id]));

  // Approved shift trades live only in the saved results, so a fresh run would undo them.
  const { data: tradesDone } = await sb.from("shift_trades").select("id").eq("lob", lob).eq("status", "approved");
  if(tradesDone?.length && !confirm(`${tradesDone.length} approved shift trade${tradesDone.length===1?"":"s"} in ${lob} will be undone: everyone gets a fresh result from their bids.\n\nRun auto assign anyway?`)){
    out.innerHTML = ""; return;
  }

  const published = await lobPublished(lob);
  if(published && !confirm(`${lob} results are published, so ${lob} agents will see the new results as soon as this run saves.\n\nTo check them first, Unpublish on the Results tab, then run.\n\nRun auto assign now?`)){
    out.innerHTML = ""; return;
  }

  const results = assignShifts(agents, shells, bids || [], cryptoRandom, manual);
  const rows = results.filter(r=>r.shift).map(r=>({ agent_id:r.agent.id, shift_id:r.shift.id }));
  const { error: saveErr } = await sb.rpc("replace_assignments", { p_agent_ids:ids, p_rows:rows });
  if(saveErr){ out.innerHTML=`<div class="msg err">Save failed: ${esc(saveErr.message)}</div>`; return; }

  const count = test => results.filter(test).length;
  const rankUses = {}; for(const a of agents) if(a.rank != null) rankUses[a.rank] = (rankUses[a.rank] || 0) + 1;
  const sharedRank = new Set(Object.keys(rankUses).filter(r=>rankUses[r] > 1).map(Number));
  const byBid = count(r=>r.how.startsWith("Bid")), byHand = count(r=>r.how === ASSIGN_HOW.manual);
  const random = count(r=>r.shift && !r.how.startsWith("Bid") && r.how !== ASSIGN_HOW.manual);
  const none = count(r=>!r.shift), seats = shells.reduce((n,s)=>n + s.seats, 0);
  out.innerHTML = `
    <div class="msg good">Done. ${esc(lob)} results saved: ${byHand ? `${byHand} manual, ` : ""}${byBid} from bids, ${random} random. Review them in Results, then push with Apply to Assembled.</div>
    ${published ? `<div class="msg warn">${esc(lob)} results are published: agents see these new results now.</div>`
      : published === null ? `<div class="msg warn">${esc(lob)} agents cannot see these results yet. Publish them on the Results tab when you are ready to announce them.</div>` : ""}
    ${none ? `<div class="msg warn">${none} agent${none===1?"":"s"} got no shift: ${esc(lob)} has ${seats} seats for ${agents.length} agents. Add shift shells or seats and run again.</div>` : ""}
    <table><thead><tr><th>Order</th><th>Rank</th><th>Agent</th><th>Assigned shift</th><th>How</th></tr></thead><tbody>
    ${results.map((r,i)=>`<tr><td>${i+1}</td><td>${rankChip(r.agent.rank)}${r.agent.rank != null && sharedRank.has(r.agent.rank)
        ? `<div class="muted bid-count">shared${r.agent.bid_submitted_at ? `, bid ${esc(fmtET(r.agent.bid_submitted_at))}` : ", no bid"}</div>` : ""}</td><td>${esc(r.agent.name)} ${accomBadge(r.agent)}</td>
      <td>${r.shift ? `${esc(describeShell(r.shift, false))} ${setBadge(r.shift.set_name)}` : `<span class="muted">none</span>`}</td><td>${howPill(r.how)}</td></tr>`).join("")}
    </tbody></table>`;
}

// ---- Results tab
let lastResults = [];
async function adminResults(){
  el("#panel").innerHTML = `
    <div class="card layer">
      <h2>${esc(currentLob)} results</h2>
      <div id="pubBox" class="pub-box"></div>
      <div class="actions" style="margin-top:0;margin-bottom:10px"><span id="pubAction" class="pub-action"></span><button class="ghost" id="csvOut">Download ${esc(currentLob)} CSV</button></div>
      <div id="rList" class="muted">Loading</div>
    </div>`;
  el("#csvOut").onclick = exportResults;
  loadResults();
  loadPublished();
}
// The LOB's row in published_results: null when not published, undefined when the database
// has no published_results yet (agents then see results straight away, as before).
async function lobPublished(lob){
  const { data, error } = await sb.from("published_results").select("lob,published_at,published_by").eq("lob", lob).maybeSingle();
  return error ? undefined : data;
}
// Publish or unpublish: whether this LOB's agents can see their assigned shift and colleagues' shifts.
async function loadPublished(){
  const box = el("#pubBox"), lob = currentLob;
  if(!box) return;
  const pub = await lobPublished(lob);
  if(lob !== currentLob || !el("#pubBox")) return;
  if(pub === undefined){
    box.innerHTML = `<div class="msg warn">${esc(lob)} agents can see these results as soon as they are saved. To choose when they see them, run the updated swaps.sql and shift-trades.sql in Supabase.</div>`;
    return;
  }
  box.innerHTML = pub
    ? `<div class="msg good"><b>Published</b> ${esc(fmtET(pub.published_at))}${pub.published_by ? ` by ${esc(pub.published_by)}` : ""}. ${esc(lob)} agents can see their assigned shift and their colleagues' shifts, and ask for trades and day swaps.</div>`
    : `<div class="msg warn"><b>Not published.</b> ${esc(lob)} agents cannot see these results yet: not their own shift, not anyone else's. Publish when you are ready to announce them.</div>`;
  el("#pubAction").innerHTML = pub ? `<button class="ghost" id="unpubBtn" type="button">Unpublish ${esc(lob)} results</button>`
    : `<button id="pubBtn" type="button">Publish ${esc(lob)} results to agents</button>`;
  const msg = text => box.insertAdjacentHTML("beforeend", `<div class="msg err">${esc(text)}</div>`);
  if(el("#pubBtn")) el("#pubBtn").onclick = async ()=>{
    if(!lastResults.length && !confirm(`${lob} has no saved results yet. Publish anyway?\n\nAgents will see their shift as soon as Auto assign saves results.`)) return;
    if(lastResults.length && !confirm(`Publish ${lob} results?\n\n${lob} agents will see their assigned shift and their colleagues' shifts the next time they open or refresh the app.`)) return;
    const { error } = await sb.from("published_results").insert({ lob });
    if(error) return msg(error.message);
    loadPublished();
  };
  if(el("#unpubBtn")) el("#unpubBtn").onclick = async ()=>{
    if(!confirm(`Unpublish ${lob} results?\n\n${lob} agents will no longer see their shift or anyone else's, and cannot ask for or accept trades and day swaps until you publish again. Requests already made are kept.`)) return;
    const { data: gone, error } = await sb.from("published_results").delete().eq("lob", lob).select("lob");
    if(error || !gone?.length) return msg(error ? error.message : "The results could not be unpublished.");
    loadPublished();
  };
}
async function loadResults(){
  const box = el("#rList"), lob = currentLob;
  const { data, error } = await sb.from("assignments")
    .select("id, shift_id, pushed_at, agents(*), shift_shells(schedule,days,start_local,end_local,timezone,set_name)");
  if(error){ box.innerHTML=`<div class="msg err">${esc(error.message)}</div>`; return; }
  const rows = (data||[]).filter(r=>r.agents && r.shift_shells && !r.agents.excluded && r.agents.lob===lob)
    .sort((a,b)=>accomOrder(a.agents) - accomOrder(b.agents) || (a.agents.rank ?? Infinity) - (b.agents.rank ?? Infinity)
      || String(a.agents.bid_submitted_at || "~").localeCompare(String(b.agents.bid_submitted_at || "~")));
  if(!rows.length){ lastResults = []; box.innerHTML = `No saved ${esc(lob)} results yet. Run auto assign for ${esc(lob)} first.`; return; }
  const [{ data: bids }, manual] = await Promise.all([
    selectAll(()=>sb.from("bids2").select("id,agent_id,shift_id,priority").in("agent_id", rows.map(r=>r.agents.id))),
    loadManual(),
  ]);
  const bidsBy = {}; for(const b of bids||[]) (bidsBy[b.agent_id] ||= []).push(b);
  for(const r of rows) r.how = assignedHow(r.agents, bidsBy[r.agents.id] || [], r.shift_id, manual[r.agents.id]?.shift_id);
  // Shifts that came from an approved trade: the agent now holds the shell they traded for.
  const { data: tradeRows } = await sb.from("shift_trades").select("requester_id,partner_id,requester_shift_id,partner_shift_id,created_at,requester:agents!shift_trades_requester_id_fkey(name),partner:agents!shift_trades_partner_id_fkey(name)")
    .eq("lob", lob).eq("status", "approved").order("created_at");
  for(const t of tradeRows || []){
    for(const [me, got, other] of [[t.requester_id, t.partner_shift_id, t.partner?.name], [t.partner_id, t.requester_shift_id, t.requester?.name]]){
      const row = rows.find(r=>r.agents.id === me && r.shift_id === got);
      if(row) row.how = `Traded with ${other || "a colleague"}`;
    }
  }
  rows.sort((a,b)=>(b.how === ASSIGN_HOW.manual) - (a.how === ASSIGN_HOW.manual));
  lastResults = rows;
  box.innerHTML = `<table><thead><tr><th>Rank</th><th>Agent</th><th>Assigned shift</th><th>How</th><th>In Assembled</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td>${rankChip(r.agents.rank)}</td>
      <td>${esc(r.agents.name)} ${accomBadge(r.agents)}</td><td>${esc(describeShell(r.shift_shells, false))} ${setBadge(r.shift_shells.set_name)}</td><td>${howPill(r.how)}</td>
      <td>${r.pushed_at?`<span class="pill ok">pushed</span>`:`<span class="pill warn">not yet</span>`}</td></tr>`).join("")}
    </tbody></table>`;
}
function exportResults(){
  if(!lastResults.length){ alert("Nothing to export yet."); return; }
  const c = v => `"${String(v??"").replace(/"/g,'""')}"`;
  const lines = ["lob,rank,accommodation,name,email,schedule,set,how"];
  for(const r of lastResults){
    lines.push([c(r.agents.lob),c(r.agents.rank),c(accomTier(r.agents) === undefined ? "" : accomTier(r.agents) ? `tier ${accomTier(r.agents)}` : "yes, no tier"),c(r.agents.name),c(r.agents.email),c(describeShell(r.shift_shells, false)),c(setLabel(r.shift_shells.set_name)),c(r.how)].join(","));
  }
  downloadCsv(`${currentLob.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}-shift-bid-results.csv`, lines);
}

// ---- Coaches tab: coach groups (supabase/coaching.sql, api/coaching.js)
// The groups being looked at or edited: { lob, rows: [{ agent_id, coach_id }], overlap: { agentId: { coachId: minutes } }, changed }.
let coachDraft = null;
// Coach bids: a LOB's coaches bid in their own bid group, "<LOB> Coaches", which works like any LOB.
const COACH_SUFFIX = " Coaches";
const isCoachLob = lob => String(lob || "").endsWith(COACH_SUFFIX);
const coachLobOf = lob => `${lob}${COACH_SUFFIX}`, baseLobOf = lob => String(lob).slice(0, -COACH_SUFFIX.length);
// Set when coach schedules change, so the next view shows a fresh split instead of the saved one.
let coachForceFresh = false;
const coachGroupCache = {};   // LOB -> its coach group teams in Assembled
const hrs = mins => String(Math.round(mins / 6) / 10);
const coachApi = (action, extra) => authedFetch("/api/coaching", { method:"POST", body: JSON.stringify({ action, lob: currentLob, ...extra }) });
async function adminCoaches(){
  const lob = esc(currentLob);
  coachDraft = null;
  if(isCoachLob(currentLob)){
    el("#panel").innerHTML = `<div class="card layer span-8"><h2>${lob} is a coach bid group</h2>
      <p>The ${esc(baseLobOf(currentLob))} coaches bid here on coach shells, like agents do in a LOB. Use the other tabs as usual: <b>Agents</b> to add coaches and upload their ranks, <b>Shift shells</b>, <b>Bid window</b>, <b>Auto assign</b> and <b>Results</b>.</p>
      <p class="muted" style="margin-top:8px">When the results are in, switch to ${esc(baseLobOf(currentLob))} and open Coaches: the <b>Coach bid results</b> card turns each coach's won shift into their coach schedule.</p></div>`;
    return;
  }
  el("#panel").innerHTML = `

    <div class="card layer" id="coachSuggest">
      <h2>${lob} coach schedules</h2>
      <p class="muted">The app works out the best coach schedules from the ${lob} shift shells and the agents' assigned shifts: the set where agents share the most hours with their own coach once they are shared out evenly.</p>
      <div class="row" style="align-items:end">
        <div style="max-width:220px"><label for="csCount">Number of ${lob} coaches</label><input id="csCount" type="number" min="1" max="50" /></div>
        <div class="actions" style="margin-top:0"><button class="ghost" id="csRun" type="button">Smart Scheduling</button></div>
      </div>
      <div id="csOut" class="muted">Loading</div>
    </div>
    <div class="card layer" id="coachBid"><h2>${lob} coach bid</h2><div class="muted">Loading</div></div>
    <div class="card layer span-8" id="coachForm">
      <h2 id="cfTitle">Add a ${lob} coach</h2>
      <div class="row">
        <div style="max-width:200px"><label for="cfLob">LOB</label><select id="cfLob">${[...new Set([currentLob, ...adminLobs.filter(l=>!NON_BID_LOBS.includes(l))])].map(l=>`<option ${l===currentLob?"selected":""}>${esc(l)}</option>`).join("")}</select></div>
        <div><label for="cfGroup">Coach group in Assembled</label><select id="cfGroup"><option value="">Loading</option></select></div>
        <div><label for="cfName">Name</label><input id="cfName" maxlength="60" placeholder="For example Sam Rivera" /></div>
      </div>
      <label>Days they work</label>
      <div class="daypick" id="cfDays">${DAY_NAMES.map((d,i)=>`<label><input type="checkbox" value="${i}" ${i>=1&&i<=5?"checked":""}/> ${d}</label>`).join("")}</div>
      <div class="row">
        <div><label for="cfStart">Start time</label><input id="cfStart" type="time" value="08:00" /></div>
        <div><label for="cfEnd">End time</label><input id="cfEnd" type="time" value="17:00" /></div>
        <div><label for="cfTz">Timezone</label><select id="cfTz">${TZ_LIST.map(t=>`<option ${t==="America/New_York"?"selected":""}>${t}</option>`).join("")}</select></div>
      </div>
      <div class="actions"><button id="cfSave" type="button">Add coach</button><button class="ghost" id="cfCancel" type="button" hidden>Cancel</button></div>
      <div id="cfMsg"></div>
    </div>
    <aside class="note span-4 drop">
      <h3>How it works</h3>
      <p>Add each ${lob} coach with their usual schedule and their coach group in Assembled.</p>
      <p>As soon as coaches are added or changed, the app shares the agents out: every coach gets about the same number (within one), and inside that, agents whose shifts overlap their coach's schedule the most. Only agents with an assigned shift are included.</p>
      <p>Check the groups, move anyone by hand, and save. Then <b>Update Assembled</b> moves each agent into their coach's group there. Their other teams stay as they are.</p>
    </aside>
    <div class="card"><h2>${lob} coaches</h2><div id="coachList" class="muted">Loading</div></div>
    <div class="card"><h2>${lob} coach groups</h2><div id="coachGroups" class="muted">Loading</div></div>
    <div class="card"><h2>Update coach groups in Assembled</h2><div id="coachTeams"></div></div>`;
  let editing = null, autoName = true;
  // The coach group list for a LOB, from Assembled (cached). keepId stays selectable even when it
  // is not under that LOB's coach groups, so a coach moved to another LOB keeps their group link.
  const groupsFor = lob => coachGroupCache[lob] ? Promise.resolve({ groups: coachGroupCache[lob] })
    : coachApi("groups", { lob }).then(r=>{ coachGroupCache[lob] = r.groups || []; return r; });
  const fillGroups = async (lob, keepId) => {
    const g = el("#cfGroup"); if(!g) return;
    let r; try{ r = await groupsFor(lob); }catch(e){ r = { groups: [], note: `Could not load groups: ${e.message}` }; }
    const list = r.groups || [], keep = keepId === undefined ? g.value : keepId || "";
    g.innerHTML = `<option value="">${list.length ? "Pick their coach group" : esc(r.note || "No coach groups found")}</option>` +
      list.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} (${x.members} in Assembled)</option>`).join("") +
      (keep && !list.some(x=>x.id === keep) ? `<option value="${esc(keep)}">Their current group (not under ${esc(lob)} Coaches in Assembled)</option>` : "");
    g.value = keep;
  };
  fillGroups(currentLob).then(()=>loadCoaches());
  el("#cfLob").onchange = ()=> fillGroups(el("#cfLob").value);
  el("#cfName").oninput = ()=>{ autoName = !el("#cfName").value.trim(); };
  el("#cfGroup").onchange = ()=>{
    const g = (coachGroupCache[el("#cfLob").value] || []).find(x=>x.id === el("#cfGroup").value);
    if(g && (autoName || !el("#cfName").value.trim())){ el("#cfName").value = g.name.replace(/^(Coach|Lead|Team)\s+/i, ""); autoName = true; }
  };
  const resetForm = ()=>{
    editing = null; autoName = true;
    el("#cfTitle").textContent = `Add a ${currentLob} coach`; el("#cfSave").textContent = "Add coach"; el("#cfCancel").hidden = true;
    el("#cfLob").value = currentLob; fillGroups(currentLob, "");
    el("#cfName").value = ""; el("#cfStart").value = "08:00"; el("#cfEnd").value = "17:00"; el("#cfTz").value = "America/New_York";
    el("#cfDays").querySelectorAll("input").forEach(c=>{ c.checked = +c.value >= 1 && +c.value <= 5; });
  };
  el("#cfCancel").onclick = ()=>{ resetForm(); el("#cfMsg").innerHTML = ""; };
  el("#cfSave").onclick = async ()=>{
    const msg = el("#cfMsg"), name = el("#cfName").value.trim();
    const days = [...el("#cfDays").querySelectorAll("input:checked")].map(c=>c.value);
    const start_local = el("#cfStart").value, end_local = el("#cfEnd").value, timezone = el("#cfTz").value, assembled_team_id = el("#cfGroup").value || null;
    if(!name || !days.length || !start_local || !end_local){ msg.innerHTML = `<div class="msg err">Give the coach a name, at least one day, and start and end times.</div>`; return; }
    if(start_local === end_local){ msg.innerHTML = `<div class="msg err">Start and end cannot be the same time.</div>`; return; }
    const lob = el("#cfLob").value || currentLob, moving = editing && lob !== currentLob;
    const row = { lob, name, assembled_team_id, days: days.join(","), start_local, end_local, timezone };
    const { data: taken } = assembled_team_id ? await sb.from("coaches").select("id,name").eq("lob", lob).eq("assembled_team_id", assembled_team_id) : { data: [] };
    if((taken || []).some(c=>c.id !== editing)){ msg.innerHTML = `<div class="msg err">${esc(taken.find(c=>c.id !== editing).name)} already has that coach group.</div>`; return; }
    if(moving){
      if(!confirm(`Move ${name} from ${currentLob} to ${lob}?\n\nTheir ${currentLob} agents will be shared out between the other ${currentLob} coaches. Nothing changes in Assembled.`)) return;
      const { error: clearErr } = await sb.from("coach_assignments").delete().eq("coach_id", editing);
      if(clearErr){ msg.innerHTML = `<div class="msg err">${esc(clearErr.message)}</div>`; return; }
    }
    const { error } = editing ? await sb.from("coaches").update(row).eq("id", editing) : await sb.from("coaches").insert(row);
    if(error){ msg.innerHTML = `<div class="msg err">${esc(/coaches/.test(error.message) && /exist|schema/.test(error.message) ? "Run supabase/coaching.sql in Supabase first." : error.message)}</div>`; return; }
    coachForceFresh = true;
    msg.innerHTML = `<div class="msg good">${moving ? `Moved ${esc(name)} to ${esc(lob)}.` : `${editing ? "Saved" : "Added"} ${esc(name)}${lob !== currentLob ? ` to ${esc(lob)}` : ""}: ${esc(describeShell(row, false))}.`}</div>`;
    resetForm(); loadCoaches();
  };

  async function loadCoaches(){
    const box = el("#coachList"); if(!box) return;
    const { data: coaches, error } = await sb.from("coaches").select("*").eq("lob", currentLob).order("name");
    if(error){ box.innerHTML = `<div class="msg err">${esc(/coaches/.test(error.message) ? "Coach groups are not in the database yet. Run supabase/coaching.sql in Supabase first." : error.message)}</div>`; el("#coachGroups").innerHTML = ""; return; }
    const { data: saved } = coaches.length ? await sb.from("coach_assignments").select("agent_id,coach_id,overlap_minutes,synced_at").in("coach_id", coaches.map(c=>c.id)) : { data: [] };
    const groupName = id => (coachGroupCache[currentLob] || []).find(g=>g.id === id)?.name;
    const count = id => (saved || []).filter(s=>s.coach_id === id).length;
    box.classList.remove("muted");
    box.innerHTML = !coaches.length ? `No ${esc(currentLob)} coaches yet. Add them above.` : `<table><thead><tr><th>Coach</th><th>Schedule</th><th>Coach group in Assembled</th><th>Agents</th><th></th></tr></thead><tbody>
      ${coaches.map(c=>`<tr><td><b>${esc(c.name)}</b></td><td>${esc(describeShell(c, false))}</td>
        <td>${!c.assembled_team_id ? `<span class="pill warn">not set</span>` : !coachGroupCache[currentLob] ? `<span class="muted">checking</span>`
          : groupName(c.assembled_team_id) ? esc(groupName(c.assembled_team_id)) : `<span class="pill warn">not under ${esc(currentLob)} Coaches</span>`}</td>
        <td>${count(c.id)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="small ghost" data-coach-edit="${c.id}" type="button">Edit</button>
          <button class="small danger" data-coach-del="${c.id}" type="button">Remove</button></td></tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("[data-coach-edit]").forEach(b=>{ b.onclick = ()=>{
      const c = coaches.find(x=>x.id === Number(b.dataset.coachEdit)); if(!c) return;
      editing = c.id; autoName = false;
      el("#cfTitle").textContent = `Edit ${c.name}`; el("#cfSave").textContent = "Save coach"; el("#cfCancel").hidden = false;
      el("#cfLob").value = c.lob; fillGroups(c.lob, c.assembled_team_id || "");
      el("#cfName").value = c.name; el("#cfStart").value = c.start_local; el("#cfEnd").value = c.end_local; el("#cfTz").value = c.timezone;
      const days = String(c.days).split(",");
      el("#cfDays").querySelectorAll("input").forEach(x=>{ x.checked = days.includes(x.value); });
      el("#coachForm").scrollIntoView({ block:"start", behavior:"smooth" });
    }; });
    box.querySelectorAll("[data-coach-del]").forEach(b=>{ b.onclick = async ()=>{
      const c = coaches.find(x=>x.id === Number(b.dataset.coachDel)); if(!c) return;
      if(!confirm(`Remove ${c.name}?\n\n${count(c.id) ? `Their ${count(c.id)} agents will have no coach in the app until you share agents out again. ` : ""}Nothing changes in Assembled.`)) return;
      const { error } = await sb.from("coaches").delete().eq("id", c.id);
      if(error){ el("#cfMsg").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
      if(editing === c.id) resetForm();
      loadCoaches();
    }; });
    loadCoachGroups(coaches, saved || []);
  }
  loadCoaches();
  renderCoachTeams();
  setupCoachSuggest(groupsFor);
  renderCoachBid();
}

// The suggested coach schedules for the LOB, and picking a coach for each.
async function setupCoachSuggest(groupsFor){
  const lob = currentLob, out = el("#csOut"), countBox = el("#csCount");
  if(!out) return;
  const [{ data: coaches }, setting, groupsRes, bidShells] = await Promise.all([
    sb.from("coaches").select("*").eq("lob", lob).order("name"),
    sb.from("coach_lob_settings").select("coach_count").eq("lob", lob).maybeSingle(),
    groupsFor(lob).catch(()=>({ groups: [] })),
    sb.from("shift_shells").select("id", { count:"exact", head:true }).eq("lob", coachLobOf(lob)),
  ]);
  // With a coach bid set up, the coaches bid on these schedules, so nobody is picked for them here.
  const coachBidOn = (bidShells.count || 0) > 0;
  if(lob !== currentLob || !el("#csOut")) return;
  const groups = groupsRes.groups || [];
  const savedCount = setting.error ? null : setting.data?.coach_count;
  countBox.value = savedCount || (coaches || []).length || groups.filter(g=>g.members > 0).length || 1;
  let result = null;
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
  function render(){
    if(!result){ out.innerHTML = ""; return; }
    if(result.note){ out.innerHTML = `<div class="msg warn">${esc(result.note)}</div>`; return; }
    const coachOpts = sel => `<option value="">Pick a coach</option>${(coaches || []).map(c=>`<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.name)}</option>`).join("")}<option value="new">+ New coach</option>`;
    const groupOpts = `<option value="">Coach group in Assembled (optional)</option>${groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join("")}`;
    const cur = result.currentFit;
    out.classList.remove("muted");
    out.innerHTML = `
      <p>With these ${result.schedules.length} schedules, agents share <b>${pct(result.together, result.hours)}%</b> of their hours with their own coach, and <b>${pct(result.covered, result.hours)}%</b> of their hours have at least one coach on.
        ${cur ? `<span class="muted">The coach schedules set now: ${pct(cur.together, cur.hours)}% and ${pct(cur.covered, cur.hours)}%.</span>` : ""}</p>
      <table><thead><tr><th>Coach schedule</th><th>Agents</th><th>Hours together</th>${coachBidOn ? "" : "<th>Coach</th>"}</tr></thead><tbody>
        ${result.schedules.map((x, i)=>`<tr data-cs="${i}"><td><b>${esc(describeShell(x.shell, false))}</b></td><td>${x.agents}</td><td>${pct(x.together, x.hours)}%</td>
          ${coachBidOn ? "" : `<td><select class="cs-coach" aria-label="Coach for this schedule">${coachOpts(null)}</select>
            <div class="cs-new" hidden><input class="cs-name" maxlength="60" placeholder="Coach name" /><select class="cs-group">${groupOpts}</select></div></td>`}</tr>`).join("")}
      </tbody></table>
      ${coachBidOn ? `<p class="muted">The ${esc(lob)} coaches bid on the coach shifts in the coach bid below, so nobody is picked here. If you change the number of coaches, replace the coach shifts in its step 1.</p>`
        : `<div id="csUnused"></div>
      <p class="muted">To skip a coach bid, pick a coach for each schedule and click Use these schedules. To let the coaches bid instead, use the coach bid below.</p>
      <div class="actions"><button id="csApply" type="button">Use these schedules</button></div>`}
      <div id="csMsg"></div>`;
    const unused = ()=>{
      const chosen = new Set([...out.querySelectorAll(".cs-coach")].map(x=>Number(x.value)).filter(Boolean));
      const left = (coaches || []).filter(c=>!chosen.has(c.id));
      el("#csUnused").innerHTML = left.length ? `<p class="muted">Not given one of these schedules: ${esc(left.map(c=>c.name).join(", "))}. They keep their current schedule and still get agents. Remove them below if they are not coaching ${esc(lob)}.</p>` : "";
    };
    if(!coachBidOn){
      out.querySelectorAll(".cs-coach").forEach(sel=>{ sel.onchange = ()=>{ sel.closest("td").querySelector(".cs-new").hidden = sel.value !== "new"; unused(); }; });
      unused();
      el("#csApply").onclick = applyPicks;
    }
    coachSuggestion = result.schedules?.length ? { lob, schedules: result.schedules } : null;
    if(el("#cbS1")) renderCoachBid();
  }
  async function applyPicks(){
    const msg = el("#csMsg"), rows = [...out.querySelectorAll("tr[data-cs]")].map(tr=>{
      const x = result.schedules[Number(tr.dataset.cs)], v = tr.querySelector(".cs-coach").value;
      return { shell: x.shell, coach: v === "new" ? null : Number(v) || undefined, name: tr.querySelector(".cs-name").value.trim(), group: tr.querySelector(".cs-group").value || null, isNew: v === "new" };
    });
    if(rows.some(r=>r.coach === undefined && !r.isNew)){ msg.innerHTML = `<div class="msg err">Pick a coach (or + New coach) for every schedule.</div>`; return; }
    if(rows.some(r=>r.isNew && !r.name)){ msg.innerHTML = `<div class="msg err">Give each new coach a name.</div>`; return; }
    const ids = rows.filter(r=>r.coach).map(r=>r.coach);
    if(new Set(ids).size !== ids.length){ msg.innerHTML = `<div class="msg err">Each coach can only take one schedule.</div>`; return; }
    const groupsUsed = rows.filter(r=>r.isNew && r.group).map(r=>r.group);
    if(new Set(groupsUsed).size !== groupsUsed.length || groupsUsed.some(g=>(coaches || []).some(c=>c.assembled_team_id === g))){ msg.innerHTML = `<div class="msg err">Two coaches cannot share a coach group.</div>`; return; }
    if(!confirm(`Set ${rows.length} ${lob} coach schedules?\n\nEach coach gets the schedule picked for them, and the ${lob} agents are shared out again between the coaches. Nothing changes in Assembled.`)) return;
    el("#csApply").disabled = true;
    const sched = sh => ({ days: sh.days, start_local: sh.start_local, end_local: sh.end_local, timezone: sh.timezone });
    for(const r of rows){
      const { error } = r.isNew
        ? await sb.from("coaches").insert({ lob, name: r.name, assembled_team_id: r.group, ...sched(r.shell) })
        : await sb.from("coaches").update(sched(r.shell)).eq("id", r.coach);
      if(error){ el("#csApply").disabled = false; msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    }
    coachForceFresh = true; coachDraft = null;
    await adminCoaches();
    el("#cfMsg").innerHTML = `<div class="msg good">Set ${rows.length} coach schedules. The ${esc(lob)} agents have been shared out between the coaches below: check the groups and click <b>Save coach groups</b>.</div>`;
  }
  async function run(){
    const k = Math.round(Number(countBox.value));
    if(!(k >= 1 && k <= 50)){ out.innerHTML = `<div class="msg err">Enter a number of coaches from 1 to 50.</div>`; return; }
    out.classList.add("muted"); out.innerHTML = "Working out the best coach schedules";
    try{ result = await coachApi("suggest", { count:k }); }catch(e){ out.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
    if(lob !== currentLob || !el("#csOut")) return;
    render();
  }
  el("#csRun").onclick = run;
  countBox.onchange = async ()=>{
    const k = Math.round(Number(countBox.value));
    if(k >= 1 && k <= 50) await sb.from("coach_lob_settings").upsert({ lob, coach_count:k, updated_at:new Date().toISOString() }, { onConflict:"lob" });
    run();
  };
  run();
}

// The coach groups: saved ones, or a fresh share-out, which can be adjusted by hand and saved.
async function loadCoachGroups(coaches, saved){
  const box = el("#coachGroups"); if(!box) return;
  box.classList.remove("muted");
  if(!coaches.length){ box.innerHTML = `Add the ${esc(currentLob)} coaches first.`; return; }
  const lob = currentLob;
  const [{ data: agents }, plan, pubRes, resultsPub] = await Promise.all([
    sb.from("agents").select("id,name,email").eq("lob", lob).eq("excluded", false),
    coachApi("plan").catch(e=>({ error: e.message })),
    sb.from("coach_lob_settings").select("coaches_published_at,coaches_published_by").eq("lob", lob).maybeSingle(),
    lobPublished(lob),
  ]);
  // Whether agents may see their coach: null before coaching.sql has the publish columns.
  const coachPub = pubRes.error ? null : { at: pubRes.data?.coaches_published_at || null, by: pubRes.data?.coaches_published_by || "" };
  if(lob !== currentLob || !el("#coachGroups")) return;
  if(plan.error){ box.innerHTML = `<div class="msg err">${esc(plan.error)}</div>`; return; }
  const ids = (agents || []).map(a=>a.id);
  const { data: asg } = ids.length ? await selectAll(()=>sb.from("assignments").select("id,agent_id,shift_shells(days,start_local,end_local,timezone,set_name)").in("agent_id", ids)) : { data: [] };
  const agentById = Object.fromEntries((agents || []).map(a=>[a.id, a])), shiftOf = Object.fromEntries((asg || []).map(a=>[a.agent_id, a.shift_shells]));
  const minutesOf = Object.fromEntries((plan.rows || []).map(r=>[r.agent_id, r.agentMinutes]));
  // Saved groups first; agents with a shift who are not in them yet show as "No coach yet".
  // The saved groups, while they still match the coaches. Otherwise (none saved yet, or a coach
  // was added or removed since) a fresh split from the coaches' schedules is shown straight away,
  // to check and save. Moves made by hand are kept until saved or shared out again.
  if(!coachDraft || coachDraft.lob !== lob || !coachDraft.manual){
    const coachIds = new Set(coaches.map(c=>c.id)), savedBy = Object.fromEntries(saved.map(s=>[s.agent_id, s.coach_id]));
    const savedFits = !coachForceFresh && saved.length > 0 && saved.every(s=>coachIds.has(s.coach_id)) && coaches.every(c=>saved.some(s=>s.coach_id === c.id));
    coachForceFresh = false;
    coachDraft = savedFits
      ? { lob, changed:false, manual:false, rows: (plan.rows || []).map(r=>({ agent_id:r.agent_id, coach_id: savedBy[r.agent_id] ?? null })) }
      : { lob, changed: (plan.rows || []).length > 0, manual:false, auto: saved.length ? "changed" : "new",
          rows: (plan.rows || []).map(r=>({ agent_id:r.agent_id, coach_id:r.coach_id })) };
  }
  coachDraft.overlap = plan.overlap || {};
  coachDraft.fresh = plan.rows || [];
  const draft = coachDraft;
  const render = ()=>{
    const coachById = Object.fromEntries(coaches.map(c=>[c.id, c]));
    const ov = (a, c) => draft.overlap[a]?.[c] ?? 0;
    const blocks = [...coaches.map(c=>({ c, rows: draft.rows.filter(r=>r.coach_id === c.id) })), { c:null, rows: draft.rows.filter(r=>!coachById[r.coach_id]) }]
      .filter(b=>b.c || b.rows.length);
    const sizes = coaches.map(c=>draft.rows.filter(r=>r.coach_id === c.id).length);
    const noCoach = draft.rows.filter(r=>!coachById[r.coach_id]).length, hasCoach = draft.rows.length - noCoach;
    box.innerHTML = `
      ${coachPub === null ? `<div class="msg warn">To let agents see their coach, run the updated supabase/coaching.sql in Supabase.</div>`
      : coachPub.at ? `<div class="msg good"><b>Published</b> ${esc(fmtET(coachPub.at))}${coachPub.by ? ` by ${esc(coachPub.by)}` : ""}. ${resultsPub === null
          ? `${esc(lob)} agents will see their coach's name once the ${esc(lob)} results are published too (Results tab).`
          : `${esc(lob)} agents can see their coach's name at the top of their page.`}</div>
        <div class="actions" style="margin-top:0;margin-bottom:12px"><button class="ghost" id="cgUnpub" type="button">Unpublish coach groups</button></div>`
      : `<div class="msg warn"><b>Not published.</b> ${esc(lob)} agents cannot see who their coach is. Publish when the groups are final.${!saved.length || draft.changed ? " Save the coach groups first." : ""}</div>
        <div class="actions" style="margin-top:0;margin-bottom:12px"><button id="cgPub" type="button" ${saved.length && !draft.changed ? "" : "disabled"}>Publish coach groups to agents</button></div>`}
      <div class="actions" style="margin-top:0">
        <button class="${noCoach ? "" : "ghost"}" id="ctPlan" type="button" ${draft.rows.length ? "" : "disabled"}>Share agents out again${noCoach && hasCoach ? ` (${noCoach} without a coach)` : ""}</button>
        <button class="ghost" id="ctShuffle" type="button" ${draft.rows.length && coaches.length > 1 ? "" : "disabled"} title="Shares the agents out at random, about the same number each, with as many as possible on a different coach">Reshuffle</button>
        <button id="ctSave" type="button" ${draft.changed ? "" : "disabled"}>Save coach groups</button>
        <button class="ghost" id="ctCsv" type="button" ${draft.rows.length ? "" : "disabled"}>Download CSV</button>
      </div>
      <div id="ctMsg"></div>
      ${!draft.changed ? "" : draft.manual && draft.auto !== "placed"
        ? `<div class="msg warn">Not saved yet. Check the groups, move anyone you need to, then click <b>Save coach groups</b>.</div>`
        : draft.auto === "placed" ? `<div class="msg warn">Placed ${draft.placedCount} agent${draft.placedCount===1?"":"s"} who had no coach: each went to a coach with fewer agents and the closest schedule. Everyone else kept their coach. Not saved yet: click <b>Save coach groups</b> to keep it.</div>`
        : draft.auto === "shuffle" ? `<div class="msg warn">Reshuffled at random: ${draft.moved} of ${draft.rows.length} agents have a different coach, still about the same number each. This ignores schedules, so check the hours together. <b>Share agents out again</b> goes back to the best fit by schedule. Not saved yet: click <b>Save coach groups</b> to keep it.</div>`
        : `<div class="msg warn">${draft.auto === "changed" ? "The coaches changed since the groups were saved, so this is a new split" : "Worked out automatically from each coach's schedule"}: about the same number of agents each, matched to their hours. Not saved yet. Check it, move anyone you need to, then click <b>Save coach groups</b>.</div>`}
      ${plan.noShift?.length ? `<p class="muted">Not included (no assigned shift yet): ${esc(plan.noShift.join(", "))}.</p>` : ""}
      ${!draft.rows.length ? `<p class="muted">No ${esc(lob)} agents have an assigned shift yet, so there is nobody to share out.</p>`
      : `<p class="muted">Week used for times: ${esc(plan.weekStart || "")}. "Together" is how many of the agent's hours a week their coach is also working.</p>
      ${blocks.map(b=>{
        const total = b.rows.reduce((n, r)=>n + (minutesOf[r.agent_id] || 0), 0), together = b.rows.reduce((n, r)=>n + (b.c ? ov(r.agent_id, b.c.id) : 0), 0);
        return `<div class="coach-block">
          <div class="coach-head"><b>${b.c ? esc(b.c.name) : "No coach yet"}</b>
            ${b.c ? `<span class="muted">${esc(describeShell(b.c, false))}</span>` : ""}
            <span class="pill ${b.c ? "ok" : "warn"}">${b.rows.length} agent${b.rows.length===1?"":"s"}</span>
            ${b.c && total ? `<span class="muted">${Math.round(100 * together / total)}% of their hours together</span>` : ""}</div>
          <table><tbody>${b.rows.map(r=>{
            const a = agentById[r.agent_id] || { name:`Agent ${r.agent_id}` }, mine = minutesOf[r.agent_id] || 0, o = b.c ? ov(r.agent_id, b.c.id) : 0;
            const low = b.c && mine && o < mine / 2;
            return `<tr><td>${esc(a.name)}</td><td class="muted">${shiftOf[r.agent_id] ? esc(describeShell(shiftOf[r.agent_id], false)) : ""}</td>
              <td>${b.c ? `<span class="${low ? "pill warn" : ""}" title="Hours a week both are working">${hrs(o)} of ${hrs(mine)} h together</span>` : ""}</td>
              <td style="text-align:right"><select class="ct-move" data-agent="${r.agent_id}" aria-label="Coach for ${esc(a.name)}">
                ${b.c ? "" : `<option value="">Pick a coach</option>`}
                ${coaches.map(c=>`<option value="${c.id}" ${c.id === r.coach_id ? "selected" : ""}>${esc(c.name)} (${hrs(ov(r.agent_id, c.id))} h)</option>`).join("")}
              </select></td></tr>`; }).join("")}</tbody></table></div>`; }).join("")}`}`;
    box.querySelectorAll("select.ct-move").forEach(s=>{ s.onchange = ()=>{
      const r = draft.rows.find(x=>x.agent_id === Number(s.dataset.agent)); if(!r || !s.value) return;
      r.coach_id = Number(s.value); draft.changed = true; draft.manual = true; draft.auto = "hand"; render();
    }; });
    el("#ctShuffle").onclick = async ()=>{
      if(draft.manual && !confirm("Reshuffle at random?\n\nThis replaces the groups shown, including your moves made by hand. Nothing is saved until you click Save.")) return;
      const current = Object.fromEntries(draft.rows.map(r=>[r.agent_id, r.coach_id]));
      el("#ctShuffle").disabled = true;
      let x; try{ x = await coachApi("plan", { shuffle:true, current }); }catch(e){ el("#ctShuffle").disabled = false; el("#ctMsg").innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
      if(coachDraft !== draft) return;
      draft.rows = (x.rows || []).map(r=>({ agent_id:r.agent_id, coach_id:r.coach_id }));
      draft.moved = draft.rows.filter(r=>current[r.agent_id] !== r.coach_id).length;
      draft.changed = true; draft.manual = false; draft.auto = "shuffle"; render();
    };
    // With coach groups in place, only agents without a coach are placed and nobody else moves.
    // Starting from scratch is only for when everyone already has a coach (or nobody does).
    el("#ctPlan").onclick = async ()=>{
      const keep = Object.fromEntries(draft.rows.filter(r=>coachById[r.coach_id]).map(r=>[r.agent_id, r.coach_id]));
      const kept = Object.keys(keep).length, missing = draft.rows.length - kept;
      if(kept && missing){
        el("#ctPlan").disabled = true;
        let x; try{ x = await coachApi("plan", { keep }); }catch(e){ el("#ctPlan").disabled = false; el("#ctMsg").innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
        if(coachDraft !== draft) return;
        const placed = new Map((x.rows || []).map(r=>[r.agent_id, r.coach_id]));
        draft.rows = draft.rows.map(r=>coachById[r.coach_id] ? r : { agent_id:r.agent_id, coach_id: placed.get(r.agent_id) ?? null });
        draft.placedCount = draft.rows.filter(r=>!keep[r.agent_id] && coachById[r.coach_id]).length;
        draft.changed = true; draft.manual = true; draft.auto = "placed"; render();
        return;
      }
      if(kept && !confirm("Everyone already has a coach.\n\nShare all the agents out again from scratch? This can move agents to a different coach. Nothing is saved until you click Save.")) return;
      draft.rows = draft.fresh.map(r=>({ agent_id:r.agent_id, coach_id:r.coach_id })); draft.changed = true; draft.manual = false; draft.auto = "new"; render();
    };
    if(el("#cgPub")) el("#cgPub").onclick = async ()=>{
      if(!confirm(`Publish the ${lob} coach groups?\n\n${lob} agents will see their coach's name at the top of their page the next time they open or refresh the app${resultsPub === null ? `, once the ${lob} results are published` : ""}.`)) return;
      const { error } = await sb.from("coach_lob_settings").upsert({ lob, coaches_published_at: new Date().toISOString(), coaches_published_by: String(currentUser.email || "").toLowerCase() }, { onConflict:"lob" });
      if(error){ el("#ctMsg").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
      await sb.from("published_results").upsert({ lob: coachLobOf(lob) }, { onConflict:"lob" });   // coaches see their won shift too
      coachDraft = null; adminCoaches();
    };
    if(el("#cgUnpub")) el("#cgUnpub").onclick = async ()=>{
      if(!confirm(`Unpublish the ${lob} coach groups?\n\n${lob} agents will no longer see who their coach is until you publish again.`)) return;
      const { error } = await sb.from("coach_lob_settings").update({ coaches_published_at: null, coaches_published_by: null }).eq("lob", lob);
      if(error){ el("#ctMsg").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
      await sb.from("published_results").delete().eq("lob", coachLobOf(lob));
      coachDraft = null; adminCoaches();
    };
    el("#ctSave").onclick = async ()=>{
      if(coachPub?.at && !confirm(`The ${lob} coach groups are published, so agents will see the new coaches as soon as you save.\n\nTo check them first, click Cancel, then Unpublish coach groups.\n\nSave now?`)) return;
      const missing = draft.rows.filter(r=>!coachById[r.coach_id]).length;
      if(missing && !confirm(`${missing} agent${missing===1?" has":"s have"} no coach and will be left out. Save anyway?`)) return;
      const rows = draft.rows.filter(r=>coachById[r.coach_id]).map(r=>({ agent_id:r.agent_id, coach_id:r.coach_id, overlap_minutes: ov(r.agent_id, r.coach_id) }));
      el("#ctSave").disabled = true;
      const { error } = await sb.rpc("replace_coach_assignments", { p_lob: lob, p_rows: rows });
      if(error){ el("#ctSave").disabled = false; el("#ctMsg").innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
      draft.changed = false;
      coachDraft = null; await adminCoaches();
      el("#coachTeams").insertAdjacentHTML("afterbegin", `<div class="msg good">Saved ${rows.length} agents into ${coaches.length} coach groups. Preview the Assembled changes below.</div>`);
    };
    el("#ctCsv").onclick = ()=>{
      const c = v => `"${String(v ?? "").replace(/"/g,'""')}"`;
      downloadCsv(`${lob.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}-coach-groups.csv`, ["coach,agent,email,shift,hours_together,hours_a_week",
        ...draft.rows.map(r=>[c(coachById[r.coach_id]?.name || ""), c(agentById[r.agent_id]?.name), c(agentById[r.agent_id]?.email), c(shiftOf[r.agent_id] ? describeShell(shiftOf[r.agent_id], false) : ""),
          c(coachById[r.coach_id] ? hrs(ov(r.agent_id, r.coach_id)) : ""), c(hrs(minutesOf[r.agent_id] || 0))].join(","))]);
    };
  };
  render();
}

// Preview, then make, the moves into each agent's coach group in Assembled.
function renderCoachTeams(){
  const box = el("#coachTeams"); if(!box) return;
  box.innerHTML = `<p class="muted">Moves each agent into their saved coach's group in Assembled (under ${esc(currentLob)} Coaches). Their other teams stay as they are. Preview first: nothing changes until you confirm.</p>
    <div class="actions" style="margin-top:0"><button class="ghost" id="ctTeams" type="button">Preview Assembled changes</button></div><div id="ctTeamsOut"></div>`;
  el("#ctTeams").onclick = async ()=>{
    const out = el("#ctTeamsOut");
    if(coachDraft?.changed){ out.innerHTML = `<div class="msg warn">Save the coach groups first. The preview uses the saved groups.</div>`; return; }
    out.innerHTML = `<p class="muted">Checking Assembled</p>`;
    let r; try{ r = await coachApi("teams"); }catch(e){ out.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
    if(r.note){ out.innerHTML = `<div class="msg warn">${esc(r.note)}</div>`; return; }
    out.innerHTML = `
      <p><b>${r.changes.length}</b> to move, ${r.unchanged} already in the right group${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.</p>
      ${r.skipped.length ? `<ul class="conflict-list">${r.skipped.map(s=>`<li>${esc(s.name)}: ${esc(s.reason)}</li>`).join("")}</ul>` : ""}
      ${r.changes.length ? `<table><thead><tr><th>Agent</th><th>Now in</th><th>Moves to</th></tr></thead><tbody>
        ${r.changes.map(c=>`<tr><td>${esc(c.name)}</td><td>${c.from.length ? esc(c.from.join(", ")) : `<span class="muted">no coach group</span>`}</td><td><b>${esc(c.to)}</b></td></tr>`).join("")}</tbody></table>
      <div class="row" style="align-items:end">
        <div style="max-width:320px"><label for="ctWho">Who to update</label><select id="ctWho"><option value="">Everyone listed (${r.changes.length})</option>
          ${r.changes.map(c=>`<option value="${c.agent_id}">Only ${esc(c.name)} (to test)</option>`).join("")}</select></div>
        <div class="actions"><button id="ctApply" type="button">Update Assembled</button></div>
      </div><div id="ctApplyOut"></div>` : ""}`;
    if(!el("#ctApply")) return;
    el("#ctApply").onclick = async ()=>{
      const one = el("#ctWho").value, n = one ? 1 : r.changes.length, res = el("#ctApplyOut");
      if(!confirm(`Move ${one ? r.changes.find(c=>String(c.agent_id) === one).name : `${n} people`} into their coach group in Assembled?\n\nOnly their ${currentLob} coach group changes; their other teams stay.`)) return;
      el("#ctApply").disabled = true;
      const updated = [], failed = [];
      for(let round = 0; round < 10; round++){
        res.innerHTML = `<p class="muted">Updating Assembled: ${updated.length} done</p>`;
        let x; try{ x = await coachApi("apply", one ? { agentIds:[Number(one)] } : {}); }catch(e){ failed.push({ name:"", error:e.message }); break; }
        updated.push(...x.updated); failed.push(...x.failed);
        if(!x.remaining || !x.updated.length) break;
      }
      res.innerHTML = `${updated.length ? `<div class="msg good">Moved ${updated.length} in Assembled.</div>` : ""}
        ${failed.length ? `<div class="msg err">${failed.length} could not be moved:<ul>${failed.map(f=>`<li>${esc(f.name)} ${esc(f.error)}</li>`).join("")}</ul></div>` : ""}`;
      el("#ctApply").disabled = false;
    };
  };
}

// Coach bid: the suggested schedules become the shells of the "<LOB> Coaches" bid group, 1 seat each.
async function openCoachBid(lob, schedules, msg){
  const group = coachLobOf(lob);
  if(!schedules?.length) return;
  const { data: old, error } = await sb.from("shift_shells").select("id").eq("lob", group);
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  const oldIds = (old || []).map(x=>x.id);
  if(oldIds.length){
    const { count: assigned } = await sb.from("assignments").select("id", { count:"exact", head:true }).in("shift_id", oldIds);
    if(assigned){ msg.innerHTML = `<div class="msg err">The coaches already have their shifts assigned, so the coach shells cannot be replaced now.</div>`; return; }
    if(!confirm(`Replace the ${oldIds.length} coach shells with these ${schedules.length}?\n\nCoaches' saved rankings of the old shells are deleted.`)) return;
    const { error: e1 } = await sb.from("bids2").delete().in("shift_id", oldIds);
    const { error: e2 } = e1 ? { error: e1 } : await sb.from("shift_shells").delete().in("id", oldIds);
    if(e2){ msg.innerHTML = `<div class="msg err">${esc(e2.message)}</div>`; return; }
  }else if(!confirm(`Create ${schedules.length} coach shells for the ${lob} coach bid?\n\nEach is one of the Smart Scheduling schedules, with 1 seat. The ${lob} coaches then rank them.`)) return;
  const rows = schedules.map(x=>({ lob: group, seats: 1, days: x.shell.days, start_local: x.shell.start_local, end_local: x.shell.end_local,
    timezone: x.shell.timezone, schedule: describeShell(x.shell, false) }));
  const { error: insErr } = await sb.from("shift_shells").insert(rows);
  if(insErr){ msg.innerHTML = `<div class="msg err">${esc(insErr.message)}</div>`; return; }
  renderCoachBid(`Created ${rows.length} coach shells.`);
}

// The coach bid, all on the LOB's Coaches tab: seven steps, each Done, Next or Not yet. It runs in
// the "<LOB> Coaches" bid group behind the scenes, so nobody has to switch "Working on".
let coachSuggestion = null;   // { lob, schedules } from the Smart Scheduling card
async function renderCoachBid(note){
  const box = el("#coachBid"), lob = currentLob, group = coachLobOf(lob);
  if(!box || isCoachLob(lob)) return;
  const [shRes, pplRes, winRes, setRes, coachRes] = await Promise.all([
    sb.from("shift_shells").select("id,days,start_local,end_local,timezone").eq("lob", group).order("id"),
    sb.from("agents").select("id,name,email,rank,excluded").eq("lob", group).eq("excluded", false).order("rank", { ascending:true, nullsFirst:false }).order("name"),
    sb.from("bid_windows").select("*").eq("lob", group).maybeSingle(),
    sb.from("coach_lob_settings").select("coaches_published_at").eq("lob", lob).maybeSingle(),
    sb.from("coaches").select("id,name,agent_id,assembled_team_id,days,start_local,end_local,timezone").eq("lob", lob),
  ]);
  if(lob !== currentLob || !el("#coachBid")) return;
  const shells = shRes.data || [], people = pplRes.data || [], win = winRes.data, coaches = coachRes.data || [], ids = people.map(x=>x.id);
  const [{ data: bids }, { data: won }, { data: saved }] = await Promise.all([
    ids.length ? selectAll(()=>sb.from("bids2").select("id,agent_id").in("agent_id", ids)) : Promise.resolve({ data: [] }),
    ids.length ? sb.from("assignments").select("agent_id,shift_id,shift_shells(days,start_local,end_local,timezone)").in("agent_id", ids) : Promise.resolve({ data: [] }),
    coaches.length ? sb.from("coach_assignments").select("agent_id").in("coach_id", coaches.map(c=>c.id)) : Promise.resolve({ data: [] }),
  ]);
  if(lob !== currentLob || !el("#coachBid")) return;
  const now = Date.now(), byId = Object.fromEntries(people.map(x=>[x.id, x]));
  const winState = !win ? "none" : now < Date.parse(win.opens_at) ? "upcoming" : now <= Date.parse(win.closes_at) ? "open" : "closed";
  const bidders = new Set((bids || []).map(b=>b.agent_id));
  const rows = (won || []).filter(w=>w.shift_shells && byId[w.agent_id]).map(w=>({ person: byId[w.agent_id], shell: w.shift_shells }))
    .sort((a, b)=>a.person.name.localeCompare(b.person.name));
  const match = matchCoaches(coaches, rows);
  // Step 5 shows each coach's group in Assembled, so have the LOB's coach groups ready.
  if(rows.length && !coachGroupCache[lob]){
    coachGroupCache[lob] = await coachApi("groups").then(r=>r.groups || []).catch(()=>[]);
    if(lob !== currentLob || !el("#coachBid")) return;
  }
  const sameSched = (c, sh) => c && String(c.days) === String(sh.days) && c.start_local === sh.start_local && c.end_local === sh.end_local && c.timezone === sh.timezone;
  const done = [
    shells.length > 0,
    people.length > 0 && people.every(x=>x.rank != null),
    winState === "closed",
    rows.length > 0,
    rows.length > 0 && rows.every(r=>{ const c = match.get(r); return c && c.agent_id === r.person.id && sameSched(c, r.shell); }),
    (saved || []).length > 0,
    !!setRes.data?.coaches_published_at,
  ];
  const nextIdx = done.indexOf(false);
  // A step already under way (for example a bid window that is open while ranks are still being
  // typed) shows what is happening instead of "Not yet", with its details visible.
  const live = [null, null, winState === "open" ? "Open" : winState === "upcoming" ? "Scheduled" : null, null, null, null, null];
  const state = i => done[i] ? "done" : i === nextIdx ? "next" : live[i] ? "next" : "later";
  const pill = i => done[i] ? `<span class="pill ok">Done</span>`
    : live[i] ? `<span class="pill next-pill">${live[i]}</span>`
    : i === nextIdx ? `<span class="pill next-pill">Next</span>` : `<span class="pill later-pill">Not yet</span>`;
  const step = (i, title, body) => `<li class="cb-step ${state(i)}" id="cbS${i + 1}"><div class="cb-head"><span class="cb-num">${i + 1}</span><b>${title}</b>${pill(i)}</div><div class="cb-body">${body}</div></li>`;
  const sugg = coachSuggestion && coachSuggestion.lob === lob ? coachSuggestion.schedules : null;
  const groupNameOf = id => (coachGroupCache[lob] || []).find(g=>g.id === id)?.name;
  const winText = winState === "none" ? "No coach bid window yet."
    : winState === "upcoming" ? `Opens ${esc(fmtET(win.opens_at))}, closes ${esc(fmtET(win.closes_at))}.`
    : winState === "open" ? `<b>Open</b> until ${esc(fmtET(win.closes_at))}.` : `Closed ${esc(fmtET(win.closes_at))}.`;
  const defOpen = win ? toLocalInput(win.opens_at) : toLocalInput(now), defClose = win ? toLocalInput(win.closes_at) : toLocalInput(now + 3 * 86400e3);

  box.innerHTML = `<div class="cb-title"><h2>${esc(lob)} coach bid</h2>
      <button class="small danger" id="cbReset" type="button" title="Clear the coach bid for the next cycle and start again at the number of coaches">Reset</button></div>
    <p class="muted">The ${esc(lob)} coaches bid on coach shifts by their rank, like agents do. Everything happens here, step by step.</p>
    ${note ? `<div class="msg good">${esc(note)}</div>` : ""}
    <ol class="cb-steps">
    ${step(0, "Coach shifts", shells.length
      ? `<p>${shells.length} coach shift${shells.length===1?"":"s"}, 1 coach each: ${shells.map(x=>esc(describeShell(x, false))).join("; ")}.</p>
         ${sugg && !rows.length && sugg.length !== shells.length ? `<p class="msg warn">The Smart Scheduling card above now has ${sugg.length} schedules, but the coach bid has ${shells.length} coach shift${shells.length===1?"":"s"}. Replace them so there is one per coach.</p>` : ""}
         ${sugg && !rows.length ? `<div class="actions"><button class="small${sugg.length !== shells.length ? "" : " ghost"}" id="cbCreate" type="button">Replace with the ${sugg.length} Smart Scheduling schedules above</button></div>` : ""}`
      : sugg ? `<p>Uses the ${sugg.length} Smart Scheduling schedules above, one per coach.</p><div class="actions"><button class="small" id="cbCreate" type="button">Create ${sugg.length} coach shifts</button></div>`
      : `<p class="muted">Set the number of coaches in the Smart Scheduling card above first.</p>`)}
    ${step(1, "Coaches and their ranks", `
      ${people.length ? `<table class="cb-table"><thead><tr><th>Rank</th><th>Coach</th><th>Bid</th><th></th></tr></thead><tbody>
        ${people.map(x=>`<tr><td><input class="rank-input" type="number" min="1" step="1" data-rank-id="${x.id}" value="${x.rank ?? ""}" placeholder="-" aria-label="Rank for ${esc(x.name)}" /></td>
          <td><b>${esc(x.name)}</b><div class="muted">${esc(x.email)}</div></td>
          <td>${bidders.has(x.id) ? `<span class="pill ok">Submitted</span>` : `<span class="muted">Not yet</span>`}</td>
          <td style="text-align:right"><button class="small ghost" data-cb-remove="${x.id}" type="button">Remove</button></td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No coaches yet. Find each one below and add them.</p>`}
      ${people.some(x=>x.rank == null) && winState !== "none" ? `<p class="msg warn">${people.filter(x=>x.rank == null).length} coach${people.filter(x=>x.rank == null).length===1?" has":"es have"} no rank yet. Type them before you assign the coach shifts (step 4): a coach with no rank gets a random shift, even if they bid.</p>` : ""}
      ${people.length && shells.length && people.length !== shells.length ? `<p class="msg warn">${people.length} coaches for ${shells.length} coach shifts. Each shift takes 1 coach${people.length > shells.length ? ", so some coaches will get none" : ""}. Set the number of coaches in Smart Scheduling to ${people.length} and replace the coach shifts in step 1, or add or remove coaches.</p>` : ""}
      <label for="cbFind">Add a coach: find by name or email</label>
      <input id="cbFind" type="search" name="coach-search" autocomplete="off" data-lpignore="true" data-1p-ignore placeholder="For example Nora" />
      <div id="cbFindMsg"></div><div id="cbList"></div>`)}
    ${step(2, "Coach bid window", `<p>${winText} ${people.length ? `${[...bidders].filter(id=>byId[id]).length} of ${people.length} coaches have bid.` : ""}</p>
      <div class="row">
        <div><label for="cbwOpen">Opens (ET)</label><input id="cbwOpen" type="datetime-local" value="${defOpen}" /></div>
        <div><label for="cbwCloseAt">Closes (ET)</label><input id="cbwCloseAt" type="datetime-local" value="${defClose}" /></div>
      </div>
      <div class="actions"><button class="small" id="cbwSave" type="button">${win ? "Save window" : "Open the coach bid"}</button>
        ${winState === "open" ? `<button class="small ghost" id="cbwClose" type="button">Close now</button>` : ""}</div>
      <p class="muted">Coaches sign in with their work email, like agents, and rank every coach shift.</p>`)}
    ${step(3, "Assign the coach shifts", `<p>${rows.length ? `Assigned ${rows.length} coach${rows.length===1?"":"es"}.` : "Best rank first, ties go to whoever submitted first, and a random open shift if their picks are taken."}</p>
      <div class="actions"><button class="small${rows.length ? " ghost" : ""}" id="cbAssign" type="button" ${shells.length && people.length ? "" : "disabled"}>${rows.length ? "Assign again" : "Assign coach shifts"}</button></div>`)}
    ${step(4, "Use the results as coach schedules", rows.length ? `
      <table class="cb-table"><thead><tr><th>Coach</th><th>Won shift</th><th>Coaches list</th></tr></thead><tbody>
        ${rows.map(r=>{ const c = match.get(r); return `<tr><td><b>${esc(r.person.name)}</b></td><td>${esc(describeShell(r.shell, false))}</td>
          <td>${c ? `updates <b>${esc(c.name)}</b>` : `<span class="pill warn">added as a new coach</span>`}
            ${c?.assembled_team_id ? ` <span class="muted">(${esc(groupNameOf(c.assembled_team_id) || "group set")})</span>`
              : coachGroupFor(coachGroupCache[lob], r.person.name) ? ` <span class="muted">(gets ${esc(coachGroupFor(coachGroupCache[lob], r.person.name).name)})</span>`
              : ` <span class="pill warn">no coach group found</span>`}</td></tr>`; }).join("")}</tbody></table>
      <div class="actions"><button class="small" id="cbUse" type="button">Use the results</button></div>`
      : `<p class="muted">After step 4, each coach's won shift becomes their coach schedule here, and the ${esc(lob)} agents are shared out between them.</p>`)}
    ${step(5, "Check and save the coach groups", `<p>${(saved || []).length ? `Saved: ${(saved || []).length} agents in coach groups.` : "Check the coach groups further down this page and click Save coach groups."}</p>
      <div class="actions"><button class="small ghost" data-cb-goto="coachGroups" type="button">Go to coach groups</button></div>`)}
    ${step(6, "Publish, then update Assembled", `<p>${done[6] ? "Published: agents see their coach and coaches see their agents." : "Publish the coach groups, then move the agents into their coach's team in Assembled."}</p>
      <div class="actions"><button class="small ghost" data-cb-goto="coachGroups" type="button">Publish coach groups</button><button class="small ghost" data-cb-goto="coachTeams" type="button">Update Assembled</button></div>`)}
    </ol><div id="cbMsg"></div>`;

  const msg = el("#cbMsg");
  const fail = e => { msg.innerHTML = `<div class="msg err">${esc(e.message || e)}</div>`; };
  if(el("#cbCreate")) el("#cbCreate").onclick = ()=> openCoachBid(lob, sugg, msg);
  // ranks, typed in; each saves straight away
  box.querySelectorAll("input[data-rank-id]").forEach(inp=>{
    inp.onchange = async ()=>{
      const raw = inp.value.trim(), rank = raw === "" ? null : Number(raw);
      if(rank !== null && !(Number.isInteger(rank) && rank >= 1)){ inp.classList.add("bad"); inp.title = "Use a whole number from 1, or leave it empty for no rank"; return; }
      inp.disabled = true;
      const { data: ok, error } = await sb.from("agents").update({ rank }).eq("id", Number(inp.dataset.rankId)).select("id");
      inp.disabled = false;
      if(error || !ok?.length){ inp.classList.add("bad"); inp.title = error ? error.message : "Could not save this rank"; return; }
      renderCoachBid();
    };
  });
  box.querySelectorAll("[data-cb-remove]").forEach(b=>{ b.onclick = async ()=>{
    const x = byId[Number(b.dataset.cbRemove)];
    if(!confirm(`Remove ${x.name} from the ${lob} coach bid?\n\nTheir ranking of the coach shifts is kept in case you add them back.`)) return;
    const { error } = await sb.from("agents").update({ excluded: true }).eq("id", x.id);
    if(error) return fail(error);
    renderCoachBid(`Removed ${x.name} from the coach bid.`);
  }; });
  coachAddSearch(group, el("#cbFind"), el("#cbList"), el("#cbFindMsg"), name=> renderCoachBid(`Added ${name}. Type their rank in the list.`));
  // bid window
  el("#cbwSave").onclick = async ()=>{
    const o = el("#cbwOpen").value, c = el("#cbwCloseAt").value;
    if(!o || !c) return fail("Fill in both times.");
    if(fromETInput(o) >= fromETInput(c)) return fail("The close time must be after the open time.");
    const { error } = await sb.rpc("replace_bid_window", { p_lob: group, p_opens: fromETInput(o).toISOString(), p_closes: fromETInput(c).toISOString(), p_require_full_ranking: true });
    if(error) return fail(error);
    renderCoachBid(win ? "Saved the coach bid window." : "The coach bid window is set.");
  };
  if(el("#cbwClose")) el("#cbwClose").onclick = async ()=>{
    if(!confirm(`Close the ${lob} coach bid now?\n\nCoaches can no longer change their rankings. Saved rankings are kept.`)) return;
    const at = new Date((await serverNow()) - 1000).toISOString();
    const { error } = await sb.from("bid_windows").update({ closes_at: at }).eq("id", win.id);
    if(error) return fail(error);
    renderCoachBid("Closed the coach bid.");
  };
  // assign
  el("#cbAssign").onclick = async ()=>{
    if(winState === "open" && !confirm("The coach bid is still open. Coaches who have not bid yet will get a random shift.\n\nAssign now?")) return;
    if(rows.length && !confirm("Assign the coach shifts again from scratch?\n\nThis replaces the current coach results.")) return;
    el("#cbAssign").disabled = true;
    const [{ data: agents, error: aErr }, { data: shellRows, error: sErr }] = await Promise.all([
      sb.from("agents").select("*").eq("lob", group).eq("excluded", false),
      sb.from("shift_shells").select("*").eq("lob", group),
    ]);
    if(aErr || sErr) return fail(aErr || sErr);
    const { data: allBids, error: bErr } = await selectAll(()=>sb.from("bids2").select("*").in("agent_id", agents.map(x=>x.id)));
    if(bErr) return fail(bErr);
    const manualRows = await loadManual();
    const manual = Object.fromEntries(Object.values(manualRows).filter(m=>agents.some(x=>x.id === m.agent_id)).map(m=>[m.agent_id, m.shift_id]));
    const results = assignShifts(agents, shellRows, allBids || [], cryptoRandom, manual);
    const { error } = await sb.rpc("replace_assignments", { p_agent_ids: agents.map(x=>x.id), p_rows: results.filter(r=>r.shift).map(r=>({ agent_id: r.agent.id, shift_id: r.shift.id })) });
    if(error) return fail(error);
    const none = results.filter(r=>!r.shift).length;
    renderCoachBid(`Assigned ${results.length - none} coach shifts${none ? `; ${none} coach${none===1?"":"es"} got none (more coaches than shifts)` : ""}.`);
  };
  // use the results
  if(el("#cbUse")) el("#cbUse").onclick = async ()=>{
    if(!confirm(`Set ${rows.length} ${lob} coach schedules from the coach bid?\n\nEach coach gets the shift they won. The saved coach groups were split for the old schedules, so they are cleared and the ${lob} agents are shared out again for you to check and save. Nothing changes in Assembled.`)) return;
    el("#cbUse").disabled = true;
    if(!coachGroupCache[lob]) coachGroupCache[lob] = await coachApi("groups").then(r=>r.groups || []).catch(()=>[]);
    const sched = sh => ({ days: sh.days, start_local: sh.start_local, end_local: sh.end_local, timezone: sh.timezone });
    let added = 0;
    const noGroup = [];
    for(const r of rows){
      const c = match.get(r), g = c?.assembled_team_id ? null : coachGroupFor(coachGroupCache[lob], r.person.name);
      if(!c?.assembled_team_id && !g) noGroup.push(r.person.name);
      const { error: e } = c
        ? await sb.from("coaches").update({ ...sched(r.shell), agent_id: r.person.id, ...(g ? { assembled_team_id: g.id } : {}) }).eq("id", c.id)
        : await sb.from("coaches").insert({ lob, name: r.person.name, agent_id: r.person.id, assembled_team_id: g ? g.id : null, ...sched(r.shell) });
      if(e) return fail(e);
      if(!c) added++;
    }
    const { error: clearErr } = await sb.rpc("replace_coach_assignments", { p_lob: lob, p_rows: [] });
    if(clearErr) return fail(clearErr);
    coachForceFresh = true; coachDraft = null;
    await adminCoaches();
    el("#cfMsg").innerHTML = `<div class="msg good">Set ${rows.length} coach schedules from the coach bid${added ? ` and added ${added} coach${added===1?"":"es"}` : ""}. The ${esc(lob)} agents have been shared out again: check the coach groups and click <b>Save coach groups</b>.</div>
      ${noGroup.length ? `<div class="msg warn">No coach group in Assembled was found for ${esc(noGroup.join(", "))}. Use Edit on ${noGroup.length===1?"that coach":"those coaches"} to pick one, or Update Assembled will skip their agents.</div>` : ""}`;
  };
  el("#cbReset").onclick = async ()=>{
    const people_too = false;   // coaches stay in the coach bid; take one out with Remove in step 2
    if(!confirm(`Reset the ${lob} coach bid?\n\nThis clears the coaches' ranks, their bids, the coach shifts, the bid window, the coach results and the saved coach groups, and unpublishes them${people_too ? ". The coaches are also taken out of the coach bid" : ". The coaches stay in the coach bid"}. It cannot be undone.\n\nYour coaches list stays. Nothing changes in Assembled.`)) return;
    el("#cbReset").disabled = true;
    const { data: all, error: pe } = await sb.from("agents").select("id").eq("lob", group);
    if(pe) return fail(pe);
    const everyone = (all || []).map(x=>x.id);
    const shellIds = shells.map(x=>x.id);
    const steps = [];
    if(everyone.length){
      steps.push(["coach results", ()=> sb.rpc("replace_assignments", { p_agent_ids: everyone, p_rows: [] })]);
      steps.push(["manual coach assignments", ()=> sb.from("manual_assignments").delete().in("agent_id", everyone)]);
      steps.push(["coach rankings", ()=> sb.from("bids2").delete().in("agent_id", everyone)]);
    }
    if(shellIds.length) steps.push(["rankings of the coach shifts", ()=> sb.from("bids2").delete().in("shift_id", shellIds)]);
    steps.push(["coach bid window", ()=> sb.from("bid_windows").delete().eq("lob", group)]);
    if(shellIds.length) steps.push(["coach shifts", ()=> sb.from("shift_shells").delete().in("id", shellIds)]);
    steps.push(["saved coach groups", ()=> sb.rpc("replace_coach_assignments", { p_lob: lob, p_rows: [] })]);
    steps.push(["publishing", ()=> sb.from("coach_lob_settings").update({ coaches_published_at: null, coaches_published_by: null }).eq("lob", lob)]);
    steps.push(["coaches' results publishing", ()=> sb.from("published_results").delete().eq("lob", group)]);
    if(everyone.length) steps.push(["coach ranks", ()=> sb.from("agents").update({ rank: null }).in("id", everyone)]);
    if(people_too && everyone.length) steps.push(["coaches", ()=> sb.from("agents").update({ excluded: true, lob_locked: false }).in("id", everyone)]);
    for(const [what, run] of steps){
      const { error } = await run();
      if(error){ el("#cbReset").disabled = false; return fail(new Error(`Could not clear the ${what}: ${error.message}`)); }
    }
    coachDraft = null; coachForceFresh = true;
    await adminCoaches();
    el("#cfMsg").innerHTML = `<div class="msg good">Reset the ${esc(lob)} coach bid. The coaches are still in it, without ranks. Start again with the number of coaches.</div>`;
    el("#coachSuggest")?.scrollIntoView({ behavior:"smooth", block:"start" });
    setTimeout(()=> el("#csCount")?.focus(), 400);
  };
  box.querySelectorAll("[data-cb-goto]").forEach(b=>{ b.onclick = ()=> el("#" + b.dataset.cbGoto)?.closest(".card")?.scrollIntoView({ behavior:"smooth", block:"start" }); });
}

function coachGroupFor(groups, personName){
  const first = String(personName || "").trim().toLowerCase().split(/\s+/)[0];
  if(!first) return null;
  const hits = (groups || []).filter(g=>String(g.name).replace(/^(coach|lead|team)\s+/i, "").trim().toLowerCase().split(/\s+/)[0] === first);
  return hits.length === 1 ? hits[0] : null;
}
// Which existing coach a coach bid result belongs to: the one already linked to that person, else
// the same full name, else a coach named by first name only ("Sam" for Sam Rivera) when only one
// coach has that first name. Each coach is matched once. null means the result adds a new coach.
function matchCoaches(coaches, rows){
  const norm = t => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");
  const taken = new Set(), out = new Map();
  const pick = (r, test) => {
    const hits = coaches.filter(c => !taken.has(c.id) && test(c));
    if(hits.length !== 1) return false;
    taken.add(hits[0].id); out.set(r, hits[0]); return true;
  };
  for(const r of rows) pick(r, c => c.agent_id === r.person.id);
  for(const r of rows) if(!out.has(r)) pick(r, c => !c.agent_id && norm(c.name) === norm(r.person.name));
  for(const r of rows) if(!out.has(r)) {
    const first = norm(r.person.name).split(" ")[0];
    pick(r, c => !c.agent_id && !norm(c.name).includes(" ") && norm(c.name) === first);
  }
  return out;
}
// Agents tab on a coach bid group: find people (synced from Assembled, including removed ones) and add them.
function setupCoachAdd(){
  coachAddSearch(currentLob, el("#caFind"), el("#caList"), el("#caMsg"), ()=> loadAgents());
}
// Search everyone synced from Assembled (including people removed from bidding) and add them to a coach bid group.
function coachAddSearch(group, input, box, msgEl, onAdded){
  if(!box || !input) return;
  let timer = null;
  const clean = ()=> input.value.trim().replace(/[,()*]/g, " ").trim();
  const search = async ()=>{
    const q = clean();
    if(q.length < 2){ box.innerHTML = ""; return; }
    // Everyone except people already active in this group: someone removed from it can be added back.
    const { data: found, error } = await sb.from("agents").select("id,name,email,lob,excluded")
      .or(`name.ilike.*${q}*,email.ilike.*${q}*`).order("name").limit(30);
    if(clean() !== q) return;
    if(error){ box.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    const data = found.filter(x=>!(x.lob === group && !x.excluded)).slice(0, 15);
    box.innerHTML = !data.length ? `<p class="muted">Nobody found. People appear here after a sync from Assembled.</p>`
      : `<table><tbody>${data.map(x=>`<tr><td><b>${esc(x.name)}</b><div class="muted">${esc(x.email)}</div></td>
          <td class="muted">${x.lob === group ? "removed from this coach bid" : `now in ${esc(isCoachLob(x.lob) ? "the " + baseLobOf(x.lob) + " coach bid" : x.lob || "no LOB")}${x.excluded ? " (removed from bidding)" : ""}`}</td>
          <td style="text-align:right"><button class="small" data-coach-add="${x.id}" type="button">${x.lob === group ? "Add back" : "Add"}</button></td></tr>`).join("")}</tbody></table>`;
    box.querySelectorAll("[data-coach-add]").forEach(b=>{ b.onclick = async ()=>{
      const person = data.find(x=>x.id === Number(b.dataset.coachAdd));
      const { count } = await sb.from("assignments").select("id", { count:"exact", head:true }).eq("agent_id", person.id);
      if(count){ msgEl.innerHTML = `<div class="msg err">${esc(person.name)} has an assigned shift in ${esc(person.lob)}, so they are bidding there. Remove that first if they should bid as a coach.</div>`; return; }
      // Someone added back to the same group keeps their rank; anyone else starts without one.
      const change = person.lob === group ? { excluded: false, lob_locked: true } : { lob: group, excluded: false, lob_locked: true, rank: null, accommodation: false, accommodation_tier: null };
      const { error: e } = await sb.from("agents").update(change).eq("id", person.id);
      if(e){ msgEl.innerHTML = `<div class="msg err">${esc(/lob_locked/.test(e.message) ? "Run the updated supabase/coaching.sql in Supabase first." : e.message)}</div>`; return; }
      input.value = ""; box.innerHTML = "";
      onAdded(person.name);
    }; });
  };
  input.oninput = ()=>{ clearTimeout(timer); timer = setTimeout(search, 250); };
}

// ---- Apply to Assembled tab
async function adminPush(){
  el("#panel").innerHTML = `
    <div class="card layer span-8">
      <h2>Apply ${esc(currentLob)} schedules to Assembled</h2>
      <div class="row">
        <div><label>Activity type in Assembled</label><select id="pType"><option>Loading</option></select></div>
      </div>
      <div class="row">
        <div><label>From date</label><input id="pStart" type="date" /></div>
        <div><label>To date</label><input id="pEnd" type="date" /></div>
      </div>
      <div class="transition-box">
        <label class="check" for="pTransition"><input type="checkbox" id="pTransition" />
          <span><b>Transition week</b>: in the first Monday-to-Sunday week, keep every shift but move any that would make someone work too many days in a row.</span></label>
        <div class="transition-limits">
          <span>4-day schedules: at most <input type="number" id="pMax4" class="inline-num" value="5" min="1" max="13" aria-label="Most days in a row for 4-day schedules" /> days in a row</span>
          <span>5-day schedules: at most <input type="number" id="pMax5" class="inline-num" value="6" min="1" max="13" aria-label="Most days in a row for 5-day schedules" /> days in a row</span>
        </div>
        <p class="muted">Use this on the first push of a new schedule. From must be a Monday, and the push must cover at least that whole week. It counts the days each agent is already working in Assembled right before From, and a day with PTO counts as a working day. A shift that would break the limit moves to one of that agent's free days off in the same week (never onto a day with PTO or anything else in Assembled), at the same hours, so everyone keeps their full weekly hours. A PTO day that week counts as one of their working days, so it can stand in for a shift. From the second week on, the new schedule applies as it is. The preview lists every move.</p>
      </div>
      <fieldset class="who-box">
        <legend>Who to update</legend>
        <label class="check" for="pWhoAll"><input type="radio" name="pWho" id="pWhoAll" value="all" checked />
          <span>Everyone in ${esc(currentLob)} with an assigned shift <span class="muted" id="pAllCount"></span></span></label>
        <label class="check" for="pWhoSome"><input type="radio" name="pWho" id="pWhoSome" value="some" />
          <span>Only the agents I pick <span class="muted">(for testing, or a few people)</span></span></label>
        <div id="pPickBox" hidden>
          <p class="muted" style="margin:0 0 6px">To push one set with its own event type, use Select only Set A (or B), pick that set's event type above, preview, then push. Then do the next set.</p>
          <div class="bulkbar">
            <span id="pPickCount">0 selected</span>
            <button class="small ghost" id="pPickAll" type="button">Select all shown</button>
            <button class="small ghost" id="pPickNone" type="button">Clear</button>
            <input id="pPickFilter" class="pick-filter" placeholder="Search names" aria-label="Search names" />
            <span id="pPickSets"></span>
          </div>
          <div id="pPickList" class="pick-list muted">Loading</div>
        </div>
      </fieldset>
      <div class="actions">
        <button class="ghost" id="previewBtn">Preview</button>
        <button id="pushBtn">Apply to Assembled</button>
      </div>
      <div id="pMsg"></div>
    </div>
    <aside class="note caution span-4 drop">
      <h3>Before you apply</h3>
      <p>This creates real events on the Assembled staffing timeline for every assigned agent, on every matching day in the range. Always preview first.</p>
      <p>Shifts already in Assembled with the same agent, activity type, start and end are skipped, so re-running a range is safe.</p>
      <p>Any day where an agent already has something in Assembled at the shift's time (time off, a training, a change made by hand, or an old schedule not deleted yet) is skipped too, and the preview lists those days.</p>
    </aside>`;
  el("#previewBtn").onclick = ()=> doPush(true);
  el("#pushBtn").onclick = ()=> doPush(false);
  document.querySelectorAll('input[name="pWho"]').forEach(r=>{
    r.onchange = ()=>{ el("#pPickBox").hidden = !el("#pWhoSome").checked; el("#pMsg").innerHTML = ""; };
  });
  loadPushPicker();
  try{
    const b = await authedFetch("/api/activity-types");
    const list = b.activity_types || [];
    el("#pType").innerHTML = list.length
      ? list.map(t=>`<option value="${esc(t.id)}" ${/shift/i.test(t.name)?"selected":""}>${esc(t.name)}</option>`).join("")
      : `<option value="">No activity types found</option>`;
  }catch(err){
    el("#pType").innerHTML = `<option value="">Could not load</option>`;
    el("#pMsg").innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
  }
}
// The LOB's agents who have an assigned shift, as a checklist for "Only the agents I pick".
async function loadPushPicker(){
  const list = el("#pPickList");
  const { data, error } = await sb.from("assignments")
    .select("agent_id, agents(id,name,lob,excluded,assembled_agent_id), shift_shells(*)");
  if(error){ list.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  const people = (data||[]).filter(r=>r.agents && r.shift_shells && r.agents.lob === currentLob && !r.agents.excluded)
    .sort((a,b)=>String(a.agents.name).localeCompare(String(b.agents.name)));
  el("#pAllCount").textContent = `(${people.length} ${people.length===1?"person":"people"})`;
  if(!people.length){ list.innerHTML = `Nobody in ${esc(currentLob)} has an assigned shift yet. Run Auto assign first.`; return; }
  list.classList.remove("muted");
  list.innerHTML = people.map(r=>`
    <label class="check pick-row" data-name="${esc(String(r.agents.name).toLowerCase())}" data-set="${esc(r.shift_shells.set_name || "")}">
      <input type="checkbox" class="push-pick" value="${r.agent_id}" />
      <span><b>${esc(r.agents.name)}</b> <span class="muted">${esc(describeShell(r.shift_shells, false))}</span>
        ${setBadge(r.shift_shells.set_name)}${r.agents.assembled_agent_id ? "" : ` <span class="pill warn">no Assembled id</span>`}</span>
    </label>`).join("");
  const update = ()=>{ const n = document.querySelectorAll(".push-pick:checked").length; el("#pPickCount").textContent = `${n} selected`; };
  list.querySelectorAll(".push-pick").forEach(c=>{ c.onchange = update; });
  const shown = ()=> [...list.querySelectorAll(".pick-row")].filter(r=>!r.hidden).map(r=>r.querySelector("input"));
  el("#pPickAll").onclick = ()=>{ shown().forEach(c=>{ c.checked = true; }); update(); };
  el("#pPickNone").onclick = ()=>{ list.querySelectorAll(".push-pick").forEach(c=>{ c.checked = false; }); update(); };
  // One button per set: ticks exactly that set's agents and nobody else.
  const sets = [...new Set(people.map(r=>r.shift_shells.set_name || ""))].sort();
  el("#pPickSets").innerHTML = sets.length > 1 || sets[0] ? sets.map(n=>{
    const count = people.filter(r=>(r.shift_shells.set_name || "") === n).length;
    return `<button class="small" type="button" data-pick-set="${esc(n)}">Select only ${n ? esc(setLabel(n)) : "no set"} (${count})</button>`;
  }).join(" ") : "";
  el("#pPickSets").querySelectorAll("button[data-pick-set]").forEach(b=>{
    b.onclick = ()=>{
      list.querySelectorAll(".pick-row").forEach(r=>{ r.querySelector("input").checked = r.dataset.set === b.dataset.pickSet; });
      update();
    };
  });
  el("#pPickFilter").oninput = e=>{
    const q = e.target.value.trim().toLowerCase();
    list.querySelectorAll(".pick-row").forEach(r=>{ r.hidden = !!q && !r.dataset.name.includes(q); });
  };
}
async function doPush(dryRun){
  const msg = el("#pMsg");
  const lob = currentLob, typeId = el("#pType").value;
  const startDate = el("#pStart").value, endDate = el("#pEnd").value;
  if(!lob || !typeId || !startDate || !endDate){
    msg.innerHTML = `<div class="msg err">Pick an LOB, an activity type, and both dates.</div>`; return;
  }
  const picked = el("#pWhoSome").checked ? [...document.querySelectorAll(".push-pick:checked")].map(c=>Number(c.value)) : null;
  if(picked && !picked.length){ msg.innerHTML = `<div class="msg err">Tick at least one agent, or choose "Everyone in ${esc(lob)}".</div>`; return; }
  const useTransition = el("#pTransition").checked;
  if(useTransition){
    const sunday = new Date(`${startDate}T00:00:00Z`); sunday.setUTCDate(sunday.getUTCDate() + 6);
    if(new Date(`${startDate}T00:00:00Z`).getUTCDay() !== 1){
      msg.innerHTML = `<div class="msg err">With the transition week on, From must be a Monday: the first day of the new work week.</div>`; return;
    }
    if(endDate < sunday.toISOString().slice(0,10)){
      msg.innerHTML = `<div class="msg err">With the transition week on, push at least the whole first week: set To to ${esc(fmtDate(sunday.toISOString().slice(0,10)))} or later.</div>`; return;
    }
  }
  const who = picked ? `${picked.length} selected agent${picked.length===1?"":"s"}` : `everyone in ${lob}`;
  if(!dryRun && !confirm(`This will create real events in Assembled for ${who}. Continue?`)) return;

  el("#previewBtn").disabled = true; el("#pushBtn").disabled = true;
  msg.innerHTML = `<div class="msg warn">${dryRun?"Previewing":"Sending to Assembled"}</div>`;
  try{
    const b = await authedFetch("/api/apply-schedules", {
      method:"POST",
      body: JSON.stringify({ lob, startDate, endDate, typeId, dryRun, agentIds: picked,
        transition: useTransition ? { limits: { 4: parseInt(el("#pMax4").value, 10), 5: parseInt(el("#pMax5").value, 10) } } : null }),
    });
    if(b.error){ msg.innerHTML = `<div class="msg warn">${esc(b.error)}</div>`; el("#previewBtn").disabled = false; el("#pushBtn").disabled = false; return; }
    let html = picked ? `<div class="msg warn">Only ${esc(who)}. Nobody else in ${esc(lob)} is touched.</div>` : "";
    const existingNote = b.alreadyInAssembled ? ` ${b.alreadyInAssembled} already in Assembled will be skipped.` : "";
    if(b.dryRun){
      html += `<div class="msg good">Preview only. This would create ${b.wouldCreate} events.${existingNote}</div>`;
      if(b.preview?.length){
        html += `<table><thead><tr><th>Agent</th><th>Starts</th><th>Ends</th></tr></thead><tbody>
          ${b.preview.map(p=>`<tr><td>${esc(p.name || p.agent_id)}</td><td>${fmtET(p.start)}</td>
            <td>${fmtET(p.end)}</td></tr>`).join("")}</tbody></table>
          <p class="muted">Showing the first few only.</p>`;
      }
    } else {
      html += `<div class="msg ${b.errors?.length?"warn":"good"}">Created ${b.created} events in Assembled.${b.alreadyInAssembled?` Skipped ${b.alreadyInAssembled} that were already there.`:""}</div>`;
      if(b.errors?.length) html += `<div class="msg err">${b.errors.map(esc).join("<br>")}</div>`;
    }
    if(useTransition){
      const moves = b.transitionMoves || [], short = b.transitionShort || [];
      html += moves.length
        ? `<div class="msg warn">Transition week: ${moves.length} shift${moves.length===1?"":"s"} ${dryRun ? "will move" : "moved"} to a day off in the same week, at the same hours, so nobody works too many days in a row and everyone keeps their full hours.</div>
           <table><thead><tr><th>Agent</th><th>Shift moves from</th><th>To</th><th>Why</th></tr></thead><tbody>
           ${moves.map(m=>`<tr><td>${esc(m.name)}</td><td>${esc(fmtDate(m.from))}</td><td><b>${esc(fmtDate(m.to))}</b></td>
             <td class="muted">would have been ${m.inARow} days in a row (limit ${m.limit})</td></tr>`).join("")}</tbody></table>`
        : `<div class="msg good">Transition week: nobody would work too many days in a row, so no shifts move.</div>`;
      const covered = b.transitionCovered || [];
      if(covered.length) html += `<div class="msg">Transition week: ${covered.length} shift${covered.length===1?" is":"s are"} covered by PTO already in Assembled. A PTO day counts as one of the agent's working days, so ${covered.length===1?"that shift is":"those shifts are"} not added:
        ${covered.map(c=>`${esc(c.name)}'s ${esc(fmtDate(c.date))} shift (PTO on ${esc(fmtDate(c.pto))})`).join("; ")}.</div>`;
      if(short.length) html += `<div class="msg err">Transition week: no free day off could take ${short.length} shift${short.length===1?"":"s"} without breaking the limit, so ${dryRun ? "they will be" : "they were"} left out. Fix these agents' hours by hand in Assembled:
        ${short.map(s=>`${esc(s.name)} on ${esc(fmtDate(s.date))}`).join("; ")}.</div>`;
    }
    if(b.swapDaysSkipped) html += `<div class="msg warn">Left ${b.swapDaysSkipped} agent-day${b.swapDaysSkipped===1?"":"s"} alone because of approved day swaps: those days are already in Assembled as Shift Swap.</div>`;
    const conflicts = b.conflicts || [];
    if(conflicts.length) html += `<div class="msg warn">${conflicts.length} shift${conflicts.length===1?"":"s"} ${b.dryRun ? "will be" : "were"} skipped because the agent already has something in Assembled at that time (for example time off, a training, or a change made by hand). Nothing is added on top of it.</div>
      <details class="conflict-list"${conflicts.length <= 15 ? " open" : ""}><summary>Show the ${conflicts.length} skipped day${conflicts.length===1?"":"s"}</summary>
      <table><thead><tr><th>Agent</th><th>Day</th><th>Already in Assembled</th></tr></thead><tbody>
      ${conflicts.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(fmtDate(c.date))}</td><td>${esc(c.found)}</td></tr>`).join("")}</tbody></table></details>`;
    if(b.skipped?.length) html += `<div class="msg warn">Skipped: ${b.skipped.map(esc).join("<br>")}</div>`;
    if(b.note) html += `<div class="msg warn">${esc(b.note)}</div>`;
    msg.innerHTML = html;
  }catch(err){ msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  el("#previewBtn").disabled = false; el("#pushBtn").disabled = false;
}

// ---------------------------------------------------------------- AGENT
async function renderAgent(){
  const v = el("#view");
  v.innerHTML = `<div class="panel-head"><span class="panel-num">..</span><h1><span>Loading</span></h1></div>`;

  const { data: agent } = await sb.from("agents").select("id,name,lob,excluded")   // agents are not shown their rank
    .eq("email", (currentUser.email||"").toLowerCase()).maybeSingle();
  myAgent = agent;

  if(myAgent && myAgent.excluded){
    el("#shell").style.setProperty("--tone", "var(--c-amber)");
    v.innerHTML = `
      <div class="panel-head"><span class="panel-num">00</span><h1><span>Hi ${esc(String(myAgent.name||"").split(" ")[0] || "there")}</span></h1></div>
      <div id="panel"><div class="card layer span-8"><h2>Not part of this bid</h2>
        <div class="msg warn">You are not included in the current shift bid. If you think this is a mistake, ask your admin.</div></div></div>`;
    return;
  }
  if(!myAgent){
    el("#shell").style.setProperty("--tone", "var(--c-amber)");
    v.innerHTML = `
      <div class="panel-head"><span class="panel-num">00</span><h1><span>Welcome</span></h1></div>
      <div id="panel"><div class="card layer span-8"><h2>Not linked yet</h2>
        <div class="msg warn">Your login is not linked to an agent record yet. Ask your admin to sync agents from Assembled, and check that your Assembled email matches <b>${esc(currentUser.email)}</b></div></div></div>`;
    return;
  }

  const { data: win } = await sb.from("bid_windows").select("*").eq("lob", myAgent.lob).maybeSingle();
  const now = Date.now();
  const open = win && now >= Date.parse(win.opens_at) && now <= Date.parse(win.closes_at);
  const fmt = fmtET;

  const [shRes, bidRes] = await Promise.all([
    sb.rpc("my_shift_shells"),   // the agent's LOB shells, without admin-only set names
    sb.from("bids2").select("*").eq("agent_id", myAgent.id).order("priority"),
  ]);
  const shells = shRes.data||[], myBids = bidRes.data||[];
  const shellIds = new Set(shells.map(s=>s.id));
  rankState = {
    shells, open: !!open, required: !!win && win.require_full_ranking !== false, need: picksNeeded(shells.length),
    order: myBids.map(b=>b.shift_id).filter(id=>shellIds.has(id)),
  };
  rankState.saved = rankState.order.join(",");

  let note;
  if(!win) note = `<div class="msg warn">No bidding window has been set for your LOB yet.</div>`;
  else if(now < Date.parse(win.opens_at)) note = `<div class="msg warn">Bidding for ${esc(myAgent.lob)} opens ${fmt(win.opens_at)}.</div>`;
  else if(now > Date.parse(win.closes_at)) note = `<div class="msg warn">Bidding for ${esc(myAgent.lob)} closed ${fmt(win.closes_at)}.</div>`;
  else note = `<div class="msg good">Bidding is open until ${fmt(win.closes_at)}.</div>`;

  const upcoming = win && now < Date.parse(win.opens_at);
  el("#shell").style.setProperty("--tone", `var(--c-${open ? "moss" : upcoming ? "amber" : "coral"})`);
  el("#railNav").innerHTML = `<div class="rail-lob"><span>Bidding for</span><strong>${esc(myAgent.lob)}</strong></div>`;
  const firstName = String(myAgent.name||"").split(" ")[0] || "there";

  v.innerHTML = `
    <div class="panel-head">
      <span class="panel-num">01</span>
      <h1><span>Hi ${esc(firstName)}</span></h1>
      <p>${!rankState.required
        ? `Pick up to ${MAX_PICKS} shifts you want and put them in order. #1 is your top choice, #2 is next, and so on.`
        : rankState.need < shells.length
        ? `Pick the ${rankState.need} shifts you want most and put them in order, from #1 (your top choice) to #${rankState.need}. You need all ${rankState.need} picks before you can save.`
        : "Put every shift in order, from the one you want most (#1) to the one you want least. You need to rank all of them before you can save."}
        If your picks are all taken by agents ahead of you, or you do not pick any before bidding closes, you will be given a random shift from the seats left.</p>
    </div>
    <div id="panel">
      <div class="card layer span-8">
        <h2>${esc(myAgent.lob)} shifts</h2>
        ${shells.length ? `
          <div id="rankStatus"></div>
          <div class="list-head"><span>Your picks, in order</span><span class="muted">Up to ${MAX_PICKS}</span></div>
          <ol class="ranklist" id="rankList"></ol>
          <div class="list-head" id="poolHead"><span>Not ranked yet</span>
            ${open ? `<button class="small ghost" id="addAll">Add all remaining</button>` : ""}</div>
          <div class="ranklist" id="poolList"></div>
          ${open ? `<div class="actions"><button id="saveBids">Save my ranking</button></div>` : ""}
          <div id="bidMsg"></div>` : `<p class="muted">No shifts are posted for your LOB yet.</p>`}
      </div>
      <aside class="ticket span-4 drop">
        <span class="ticket-label">LOB</span><strong>${esc(myAgent.lob)}</strong>
        <div class="perf"></div>
        <span class="ticket-label">Bidding</span>
        ${note}
      </aside>
      <div class="card span-12" id="myAgentsCard" hidden></div>
      <div class="card span-12" id="swapCard"><h2>Change your schedule</h2><div id="swapBody" class="muted">Loading</div></div>
    </div>`;

  loadAgentSwaps();
  loadMyCoachAgents();
  if(!shells.length) return;
  if(open){
    el("#saveBids").onclick = saveBids;
    el("#addAll").onclick = ()=>{ rankState.order.push(...unrankedShells().map(s=>s.id)); renderRanking(); };
  }
  renderRanking();
}

// The agent's ranking: rankState.order is shift ids from #1 down. Rendered as an ordered list
// with move buttons, plus a pool of shifts not ranked yet.
let rankState = null;
const unrankedShells = () => rankState.shells.filter(s=>!rankState.order.includes(s.id));
function shellRow(s){
  const days = s.days ? String(s.days).split(",").map(n=>DAY_NAMES[+n]).filter(Boolean).join(", ") : "";
  const time = s.start_local && s.end_local ? `${s.start_local} to ${s.end_local} ${s.timezone||""}` : "";
  return `<div class="grow"><strong>${esc(days || describeShell(s, false))}</strong><span>${esc(time)}</span></div>
    <span class="seats">${s.seats} seat${s.seats===1?"":"s"}</span>`;
}
function renderRanking(){
  const { shells, order, open, required } = rankState;
  const byId = Object.fromEntries(shells.map(s=>[s.id, s])), pool = unrankedShells(), last = order.length - 1;
  const atLimit = order.length >= MAX_PICKS;

  el("#rankList").innerHTML = order.length ? order.map((id, i)=>`
    <li class="bidrow ranked">
      <span class="pos" aria-label="Rank ${i+1}">${i+1}</span>
      ${shellRow(byId[id])}
      ${open ? `<span class="move">
        <button class="small ghost" data-up="${i}" aria-label="Move up" ${i===0?"disabled":""}>&uarr;</button>
        <button class="small ghost" data-down="${i}" aria-label="Move down" ${i===last?"disabled":""}>&darr;</button>
        <button class="small ghost" data-out="${i}" aria-label="Take out of ranking">&times;</button>
      </span>` : ""}
    </li>`).join("")
    : `<li class="ranklist-empty">${open ? "Nothing ranked yet. Add shifts from the list below: the first one you add becomes #1." : "You did not rank any shifts."}</li>`;

  el("#poolHead").hidden = !pool.length;
  el("#poolList").innerHTML = pool.map(s=>`
    <div class="bidrow pool">
      ${shellRow(s)}
      ${open ? `<button class="small" data-add="${s.id}" ${atLimit ? "disabled" : ""}>${atLimit ? `${MAX_PICKS} picked` : `Add as #${order.length + 1}`}</button>` : ""}
    </div>`).join("");

  const done = order.length, total = shells.length, need = rankState.need, most = Math.min(MAX_PICKS, total);
  const over = done - MAX_PICKS, complete = over <= 0 && (!required || done === need);
  el("#rankStatus").innerHTML = over > 0
    ? `<div class="msg err">You can pick at most ${MAX_PICKS} shifts. Take out ${over} to save.</div>`
    : required
    ? `<div class="msg ${complete ? "good" : "warn"}">${complete ? (need === total ? `All ${total} shifts ranked.` : `All ${need} picks made.`)
        : `Picked ${done} of ${need}. ${need === total ? "Rank every shift" : `Pick ${need}`} to save.`}</div>`
    : `<div class="msg ${done ? "good" : "warn"}">Picked ${done} of up to ${most}.${done < most ? " Pick as many as you want." : ""}</div>`;
  if(!open) return;
  if(el("#addAll")) el("#addAll").hidden = !pool.length || pool.length > MAX_PICKS - done;

  const saveBtn = el("#saveBids");
  saveBtn.disabled = !complete;
  saveBtn.textContent = over > 0 ? `Take out ${over} to save` : !complete ? `Pick ${need - done} more to save` : "Save my ranking";
  const msgBox = el("#bidMsg");
  if(order.join(",") !== rankState.saved){ msgBox.innerHTML = `<div class="msg warn">You have unsaved changes.</div>`; msgBox.dataset.state = "unsaved"; }
  else if(msgBox.dataset.state === "unsaved"){ msgBox.innerHTML = ""; msgBox.dataset.state = ""; }

  const swap = (a, b) => { [order[a], order[b]] = [order[b], order[a]]; renderRanking(); };
  document.querySelectorAll("#rankList [data-up]").forEach(b=>{ b.onclick = ()=> swap(+b.dataset.up, +b.dataset.up - 1); });
  document.querySelectorAll("#rankList [data-down]").forEach(b=>{ b.onclick = ()=> swap(+b.dataset.down, +b.dataset.down + 1); });
  document.querySelectorAll("#rankList [data-out]").forEach(b=>{ b.onclick = ()=>{ order.splice(+b.dataset.out, 1); renderRanking(); }; });
  document.querySelectorAll("#poolList [data-add]").forEach(b=>{ b.onclick = ()=>{ if(order.length >= MAX_PICKS) return; order.push(Number(b.dataset.add)); renderRanking(); }; });
}
async function saveBids(){
  const msg = el("#bidMsg"), { order, required, need } = rankState;
  if(order.length > MAX_PICKS){
    msg.innerHTML = `<div class="msg err">You can pick at most ${MAX_PICKS} shifts.</div>`; return;
  }
  if(required && order.length !== need){
    msg.innerHTML = `<div class="msg err">Pick ${need} shifts before saving.</div>`; return;
  }
  el("#saveBids").disabled = true;
  const { error } = await sb.rpc("replace_my_bids", { p_bids: order.map((shift_id, i)=>({ shift_id, priority:i+1 })) });
  el("#saveBids").disabled = false;
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  rankState.saved = order.join(",");
  msg.dataset.state = "saved";
  msg.innerHTML = `<div class="msg good">Your ranking was saved. You can change it any time while bidding is open.</div>`;
}

// ---------------------------------------------------------------- SHIFT SWAPS
// Agent A asks agent B (same LOB) to swap shifts for one day; B accepts; an admin approves, which
// replaces that day in Assembled for both (as Shift Swap). See supabase/swaps.sql and api/swaps.js.
function swapStatusText(r){
  return ({
    pending_partner: r.mine ? `Waiting for ${r.other_name}` : "Waiting for you",
    pending_admin: "Waiting for admin approval",
    approved: "Approved",
    declined: r.auto_declined ? "Auto declined: the trade window closed" : r.mine ? `Declined by ${r.other_name}` : "You declined",
    cancelled: r.mine ? "You cancelled" : `Cancelled by ${r.other_name}`,
    rejected: "Rejected by admin",
  })[r.status] || r.status;
}
const swapPill = (status, text) =>
  `<span class="pill ${status === "approved" ? "ok" : ["declined","cancelled","rejected"].includes(status) ? "err" : "warn"}">${esc(text)}</span>`;
const fmtDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday:"short", month:"short", day:"numeric", timeZone:"UTC" });
const fmtRange = (a, b) => a === b ? fmtDate(a) : `${fmtDate(a)} to ${fmtDate(b)}`;
const shellText = s => s ? describeShell(s) : "(shift no longer exists)";
const localToday = etToday;
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); };
// Whether a shell works on a date ("YYYY-MM-DD"); its days are weekday numbers, 0 = Sunday.
const shellOnDay = (shell, date) => !!shell && String(shell.days || "").split(",").map(Number).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
// The Mondays of this work week and the next five, for picking a rest-day swap week.
const swapWeeks = () => { const t = etToday(), dow = new Date(`${t}T00:00:00Z`).getUTCDay(); const mon = addDays(t, -((dow + 6) % 7));
  return Array.from({ length:6 }, (_, i)=> addDays(mon, 7 * i)); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

// ---- agent side
// For a coach: the agents in their coach group, once the coach groups are published.
async function loadMyCoachAgents(){
  const card = el("#myAgentsCard");
  if(!card) return;
  const { data, error } = await sb.rpc("my_coach_agents");
  if(error || !data || !el("#myAgentsCard")) return;
  card.hidden = false;
  if(!data.published){
    card.innerHTML = `<h2>Your agents</h2><p class="muted">Your ${esc(data.lob)} agents will show here once your admin publishes the coach groups.</p>`;
    return;
  }
  const list = data.agents || [];
  card.innerHTML = `<h2>Your agents <span class="muted" style="font-size:15px">(${list.length})</span></h2>
    ${list.length ? `<table><thead><tr><th>Agent</th><th>Assigned shift</th></tr></thead><tbody>
      ${list.map(a=>`<tr><td><b>${esc(a.name)}</b></td><td>${a.shift ? esc(describeShell(a.shift, false)) : `<span class="muted">no shift yet</span>`}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">No ${esc(data.lob)} agents are in your coach group yet.</p>`}`;
}
async function loadAgentSwaps(){
  const box = el("#swapBody");
  if(!box) return;
  const [{ data: board, error }, tradeRes] = await Promise.all([sb.rpc("swap_board"), sb.rpc("trade_board")]);
  if(error){ box.innerHTML = `<p class="muted">Shift swaps are not available right now.</p>`; return; }
  if(!board){ el("#swapCard").hidden = true; return; }
  const { me, colleagues, requests } = board;
  // Until an admin publishes this LOB's results, nobody's shift is shown (older databases send no "published").
  if(board.published === false){
    box.classList.remove("muted");
    box.innerHTML = `<p class="muted">Your assigned shift will show here once your admin publishes the ${esc(me.lob)} results. Trades and day swaps open after that.</p>`;
    return;
  }
  // The result goes at the top of the page too: the trades card is below all the picks.
  el("#yourShift")?.remove();
  if(me.shift) el("#view .panel-head")?.insertAdjacentHTML("beforeend",
    `<div class="msg good your-shift" id="yourShift"><span>Your assigned shift</span><strong>${esc(describeShell(me.shift))}</strong>
      <a href="#swapCard">Trade your shift or swap a rest day below</a></div>`);
  if(me.shift) sb.rpc("my_coach").then(({ data })=>{
    const banner = el("#yourShift");
    if(data?.name && banner && !el("#yourCoach")) banner.querySelector("a").insertAdjacentHTML("beforebegin",
      `<div class="your-coach" id="yourCoach"><span class="lbl">Your coach</span><b>${esc(data.name)}</b></div>`);
  });
  // Shift trades (before the push) need shift-trades.sql; without it, only day swaps show, as before.
  const tradeBoard = tradeRes.error ? null : tradeRes.data;
  const pushed = !tradeBoard || tradeBoard.pushed;      // day swaps are for schedules already in Assembled
  const trades = tradeBoard ? tradeBoard.trades : [];
  // Day swaps are always open. Trades follow the LOB's trade window
  // (tradeBoard.window). Databases set up before windows send no "window" key: no check then.
  const gated = "window" in board, win = board.window, swapOpen = !gated || !!(win && win.open);
  const tradeGated = !!tradeBoard && "window" in tradeBoard, tWin = tradeGated ? tradeBoard.window : win;
  const tradeOpen = tradeGated ? !!(tWin && tWin.open) : swapOpen;
  const fmtTime = fmtET;
  const windowNote = (w, isGated, what) => !isGated ? ""
    : !w ? `<div class="msg warn">${what} are not open for ${esc(me.lob)} yet.</div>`
    : w.open ? `<div class="msg good">${what} are open until ${esc(fmtTime(w.closes_at))}.</div>`
    : Date.now() < Date.parse(w.opens_at) ? `<div class="msg warn">${what} open ${esc(fmtTime(w.opens_at))} and close ${esc(fmtTime(w.closes_at))}.</div>`
    : `<div class="msg warn">${what} closed ${esc(fmtTime(w.closes_at))}.</div>`;
  const askedOfMe = requests.filter(r=>!r.mine && r.status === "pending_partner");
  const history = requests.filter(r=>!askedOfMe.includes(r));
  const tradesAsked = trades.filter(t=>!t.mine && t.status === "pending_partner");
  const tradeHistory = trades.filter(t=>!tradesAsked.includes(t));
  const tradeWaiting = trades.some(t=>["pending_partner","pending_admin"].includes(t.status));
  const choices = me.shift ? colleagues.filter(c=>c.shift && c.shift.id !== me.shift.id) : [];
  const colleagueOptions = choices.map(c=>`<option value="${c.id}">${esc(c.name)}: ${esc(describeShell(c.shift))}</option>`).join("");
  const today = localToday();
  const showTrades = tradeBoard && me.shift;

  // Two kinds of request, kept visibly apart so nobody mixes them up:
  // a shift trade changes your regular shift for good; a rest-day swap changes one week only.
  const showTradeKind = showTrades || tradesAsked.length || tradeHistory.length;
  const showSwapKind = me.shift || askedOfMe.length || history.length;
  const kindHead = (title, badge, blurb) => `
    <div class="kind-head"><h3>${title}</h3><span class="kind-badge">${badge}</span></div>
    <p class="kind-blurb">${blurb}</p>`;
  // A shift trade as two lines: the shift now, and the shift every week after.
  const changeLine = (from, to) => `<span class="change"><span class="change-lbl">Now</span><span>${esc(shellText(from))}</span>
    <span class="change-lbl">Every week after</span><b>${esc(shellText(to))}</b></span>`;
  // The Monday of a date's week, for naming the one week a rest-day swap covers.
  const weekOf = d => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));

  box.innerHTML = `
    <p>${me.shift ? `Your regular shift: <b>${esc(describeShell(me.shift))}</b>` : "You can trade or swap once you have an assigned shift."}</p>
    ${showTradeKind && showSwapKind ? `<div class="kind-guide">
      <a href="#kindTrade" class="kind-trade"><b>Want a different shift for good?</b>Permanent shift trade</a>
      <a href="#kindSwap" class="kind-swap"><b>Need a different day off in one week?</b>Rest-day swap</a>
    </div>` : ""}
    ${showTradeKind ? `<section class="swapkind kind-trade" id="kindTrade" aria-label="Permanent shift trade">
      ${kindHead("Permanent shift trade", "Permanent",
        `Exchange your whole shift with a colleague <b>for good</b>. Their shift becomes your regular schedule every week, and yours becomes theirs.`)}
      ${tradesAsked.length ? `<div class="list-head"><span>Permanent trades asked of you</span></div>
        <div class="ranklist">${tradesAsked.map(t=>`
          <div class="bidrow swaprow">
            <div class="grow"><strong>${esc(t.other_name)} wants to trade shifts with you permanently</strong>
              ${changeLine(t.my_shift, t.their_shift)}
              ${t.note ? `<span>&ldquo;${esc(t.note)}&rdquo;</span>` : ""}</div>
            <span class="move">${tradeOpen ? `<button class="small" data-accept-trade="${t.id}">Accept trade</button>` : ""}
              <button class="small ghost" data-decline-trade="${t.id}">Decline</button></span>
          </div>`).join("")}</div>` : ""}
      ${showTrades ? `
        ${windowNote(tWin, tradeGated || gated, "Shift trades")}
        ${pushed && tradeOpen ? `<p class="muted">Your schedule is already in Assembled. If the trade is approved, your admin picks the Monday your new shift starts.</p>` : ""}
        ${!tradeOpen ? ""
        : tradeWaiting ? `<p class="muted">You have a trade waiting. Once it is finished or cancelled you can ask for another.</p>`
        : choices.length ? `
          <label for="trWith">Trade with someone in ${esc(me.lob)}</label>
          <select id="trWith">${colleagueOptions}</select>
          <div id="trPreview" class="change-preview"></div>
          <label for="trNote">Note for them and your admin (optional)</label>
          <input id="trNote" maxlength="300" placeholder="For example: I need mornings for school" />
          <p class="muted" style="margin-top:8px">They accept first, then your admin approves it.</p>
          <div class="actions"><button id="trSend">Request permanent trade</button></div>`
          : `<p class="muted">Nobody else in ${esc(me.lob)} has a different shift to trade with yet.</p>`}` : ""}
      <div id="trMsg"></div>
      ${tradeHistory.length ? `<div class="list-head"><span>Your permanent trades</span></div>
        <table><thead><tr><th>With</th><th>Your shift every week after</th><th>Status</th><th></th></tr></thead><tbody>
        ${tradeHistory.map(t=>`<tr><td>${esc(t.other_name)}</td><td>${esc(shellText(t.their_shift))}</td>
          <td>${swapPill(t.status, t.status === "approved" && t.start_date ? `Approved: starts ${fmtDate(t.start_date)}` : swapStatusText(t))}${t.admin_note ? `<div class="muted">${esc(t.admin_note)}</div>` : ""}</td>
          <td style="text-align:right">${t.mine && ["pending_partner","pending_admin"].includes(t.status)
            ? `<button class="small ghost" data-cancel-trade="${t.id}">Cancel</button>` : ""}</td></tr>`).join("")}
        </tbody></table>` : ""}
    </section>` : ""}
    ${showSwapKind ? `<section class="swapkind kind-swap" id="kindSwap" aria-label="Rest-day swap">
      ${kindHead("Rest-day swap", "One week only",
        `Swap one of your days off for one of a colleague's work days, in a single Monday-to-Sunday week. Your regular shift <b>does not change</b>.`)}
      ${askedOfMe.length ? `<div class="list-head"><span>Rest-day swaps asked of you</span></div>
        <div class="ranklist">${askedOfMe.map(r=>`
          <div class="bidrow swaprow">
            <div class="grow">${r.give_date
              ? `<strong>${esc(r.other_name)} wants to swap rest days with you, week of ${esc(fmtDate(weekOf(r.give_date)))} only</strong>
                 <span>You would work <b>${esc(fmtDate(r.give_date))}</b> (starting at their usual start time, for your usual hours) and be off <b>${esc(fmtDate(r.take_date))}</b>. They would do the opposite. Your regular shift stays the same.</span>`
              : `<strong>${esc(r.other_name)} wants to swap: ${esc(fmtRange(r.start_date, r.end_date))}</strong>
                 <span>You would work ${esc(shellText(r.their_shift))} instead of ${esc(shellText(r.my_shift))}.</span>`}
              ${r.note ? `<span>&ldquo;${esc(r.note)}&rdquo;</span>` : ""}</div>
            <span class="move"><button class="small" data-accept="${r.id}">Accept swap</button>
              <button class="small ghost" data-decline="${r.id}">Decline</button></span>
          </div>`).join("")}</div>` : ""}
      ${me.shift ? `
        <p class="muted" style="margin:12px 0 8px">On the day you take, you start at their usual start time and work your own usual hours (for example 9 hours if you are on a 5x9), so your hours stay the same.${!pushed ? " You can ask now; your admin approves once the new schedule is in Assembled." : ""}</p>
        ${choices.length ? `
          <label for="swWith">Swap with someone in ${esc(me.lob)}</label>
          <select id="swWith">${colleagueOptions}</select>
          <label for="swWeek">Week</label>
          <select id="swWeek">${swapWeeks().map(m=>`<option value="${m}">Week of ${esc(fmtDate(m))}</option>`).join("")}</select>
          <div class="row">
            <div><label for="swGive">Day you give (you will be off)</label><select id="swGive"></select></div>
            <div><label for="swTake">Day you take (you will work)</label><select id="swTake"></select></div>
          </div>
          <div id="swDaysNote"></div>
          <label for="swNote">Note for them and your admin (optional)</label>
          <input id="swNote" maxlength="300" placeholder="For example: family event on Friday" />
          <p class="muted" style="margin-top:8px">They accept first, then your admin approves it.</p>
          <div class="actions"><button id="swSend">Request rest-day swap</button></div>`
          : `<p class="muted">Nobody else in ${esc(me.lob)} has a different shift to swap with yet.</p>`}` : ""}
      <div id="swMsg"></div>
      ${history.length ? `<div class="list-head"><span>Your rest-day swaps</span></div>
        <table><thead><tr><th>Days</th><th>With</th><th>You would work</th><th>Status</th><th></th></tr></thead><tbody>
        ${history.map(r=>`<tr><td>${r.give_date
            ? esc(r.mine ? `Off ${fmtDate(r.give_date)}, work ${fmtDate(r.take_date)}` : `Work ${fmtDate(r.give_date)}, off ${fmtDate(r.take_date)}`)
            : esc(fmtRange(r.start_date, r.end_date))}</td><td>${esc(r.other_name)}</td>
          <td>${r.give_date ? "Their start time, your usual hours" : esc(shellText(r.their_shift))}</td>
          <td>${swapPill(r.status, swapStatusText(r))}${r.admin_note ? `<div class="muted">${esc(r.admin_note)}</div>` : ""}</td>
          <td style="text-align:right">${r.mine && ["pending_partner","pending_admin"].includes(r.status)
            ? `<button class="small ghost" data-cancel-swap="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")}
        </tbody></table>` : ""}
    </section>` : ""}`;

  // Each kind shows its own messages, under its own form.
  const act = async (fn, args, done, msgId) => {
    const { error } = await sb.rpc(fn, args);
    if(error){ const m = el(msgId); if(m) m.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    await loadAgentSwaps();
    const m = el(msgId);
    if(m) m.innerHTML = `<div class="msg good">${esc(done)}</div>`;
  };
  box.querySelectorAll("[data-accept]").forEach(b=>{ b.onclick = ()=> act("respond_swap", { p_id:Number(b.dataset.accept), p_accept:true }, "Accepted. The rest-day swap now goes to your admin for approval.", "#swMsg"); });
  box.querySelectorAll("[data-decline]").forEach(b=>{ b.onclick = ()=> act("respond_swap", { p_id:Number(b.dataset.decline), p_accept:false }, "Declined.", "#swMsg"); });
  box.querySelectorAll("[data-cancel-swap]").forEach(b=>{
    b.onclick = ()=>{ if(confirm("Cancel this rest-day swap request?")) act("cancel_swap", { p_id:Number(b.dataset.cancelSwap) }, "Rest-day swap request cancelled.", "#swMsg"); };
  });
  box.querySelectorAll("[data-accept-trade]").forEach(b=>{
    b.onclick = ()=>{
      const t = tradesAsked.find(x=>String(x.id) === b.dataset.acceptTrade);
      if(t && !confirm(`Accept a PERMANENT shift trade with ${t.other_name}?\n\nYour regular shift changes for good, every week:\nNow: ${shellText(t.my_shift)}\nAfter: ${shellText(t.their_shift)}\n\nYour admin approves it next.`)) return;
      act("respond_trade", { p_id:Number(b.dataset.acceptTrade), p_accept:true }, "Accepted. The permanent trade now goes to your admin for approval.", "#trMsg");
    };
  });
  box.querySelectorAll("[data-decline-trade]").forEach(b=>{ b.onclick = ()=> act("respond_trade", { p_id:Number(b.dataset.declineTrade), p_accept:false }, "Declined.", "#trMsg"); });
  box.querySelectorAll("[data-cancel-trade]").forEach(b=>{
    b.onclick = ()=>{ if(confirm("Cancel this permanent trade request?")) act("cancel_trade", { p_id:Number(b.dataset.cancelTrade) }, "Trade request cancelled.", "#trMsg"); };
  });
  const tradePick = ()=> choices.find(c=>String(c.id) === el("#trWith").value);
  if(el("#trWith")){
    const showTradePreview = ()=>{ el("#trPreview").innerHTML = changeLine(me.shift, tradePick().shift); };
    el("#trWith").onchange = showTradePreview; showTradePreview();
  }
  if(el("#trSend")) el("#trSend").onclick = async ()=>{
    const other = tradePick();
    if(!confirm(`Ask ${other.name} for a PERMANENT shift trade?\n\nYour regular shift changes for good, every week:\nNow: ${shellText(me.shift)}\nAfter: ${shellText(other.shift)}\n\n${other.name} accepts first, then your admin approves it${pushed ? " and picks the Monday it starts" : ""}.`)) return;
    el("#trSend").disabled = true;
    await act("request_trade", { p_partner_id:Number(other.id), p_note:el("#trNote").value },
      `Permanent trade request sent to ${other.name}. Once they accept, it goes to your admin for approval.`, "#trMsg");
    if(el("#trSend")) el("#trSend").disabled = false;
  };
  // Rest-day swap: only offer days that work. Give = I work and they are off; take = I am off
  // and they work; both in the chosen week and not in the past.
  const fillSwapDays = ()=>{
    const with_ = el("#swWith"), other = choices.find(c=>String(c.id) === with_.value);
    const week = Array.from({ length:7 }, (_, i)=> addDays(el("#swWeek").value, i)).filter(d=>d >= today);
    const give = week.filter(d=>shellOnDay(me.shift, d) && !shellOnDay(other.shift, d));
    const take = week.filter(d=>!shellOnDay(me.shift, d) && shellOnDay(other.shift, d));
    const opts = list => list.map(d=>`<option value="${d}">${esc(fmtDate(d))}</option>`).join("");
    el("#swGive").innerHTML = opts(give); el("#swTake").innerHTML = opts(take);
    const ok = give.length && take.length;
    el("#swDaysNote").innerHTML = ok ? "" : `<div class="msg warn">${!give.length
      ? `${esc(other.name)} works every day you work that week, so there is no day to give.`
      : `${esc(other.name)} is off on all of your days off that week, so there is no day to take.`} Try another week or colleague.</div>`;
    el("#swSend").disabled = !ok;
    showSwapPreview();
  };
  // What the swap does, in one line, under the day pickers.
  const showSwapPreview = ()=>{
    const give = el("#swGive").value, take = el("#swTake").value;
    if(!give || !take) return;
    el("#swDaysNote").innerHTML = `<div class="change-preview">Week of ${esc(fmtDate(el("#swWeek").value))} only: you are off <b>${esc(fmtDate(give))}</b> and work <b>${esc(fmtDate(take))}</b>.
      After that week you are back on your regular shift.</div>`;
  };
  if(el("#swWith")){
    el("#swWith").onchange = fillSwapDays; el("#swWeek").onchange = fillSwapDays;
    el("#swGive").onchange = showSwapPreview; el("#swTake").onchange = showSwapPreview;
    fillSwapDays();
  }
  if(el("#swSend")) el("#swSend").onclick = async ()=>{
    const give = el("#swGive").value, take = el("#swTake").value, with_ = el("#swWith");
    if(!give || !take){ el("#swMsg").innerHTML = `<div class="msg err">Pick a day to give and a day to take.</div>`; return; }
    const name = with_.options[with_.selectedIndex].text.split(":")[0];
    if(!confirm(`Ask ${name} for a ONE-WEEK rest-day swap?\n\nWeek of ${fmtDate(el("#swWeek").value)} only: you would be off ${fmtDate(give)} and work ${fmtDate(take)}. ${name} would work ${fmtDate(give)} and be off ${fmtDate(take)}.\n\nYour regular shift does not change.`)) return;
    el("#swSend").disabled = true;
    await act("request_day_swap", { p_partner_id:Number(with_.value), p_give:give, p_take:take, p_note:el("#swNote").value },
      `Rest-day swap request sent to ${name}. Once they accept, it goes to your admin for approval.`, "#swMsg");
    if(el("#swSend")) el("#swSend").disabled = false;
  };
}

// ---- admin side
async function adminSwaps(){
  el("#panel").innerHTML = `
    <div class="card layer span-8"><h2>${esc(currentLob)} shift trades waiting for you</h2><div id="trPending" class="muted">Loading</div></div>
    <aside class="note span-4 drop">
      <h3>Trades and day swaps</h3>
      <ol>
        <li><b>Shift trades</b> are for good: two agents exchange their assigned shifts. Before the push, approving changes Results only; nothing goes to Assembled until you push.</li>
        <li><b>After the push</b>, you pick the Monday the new shifts start and preview the change. Approving rewrites both agents' days in Assembled from then to the end of their pushed schedule (same first-week rule as the push; training, meetings and time off kept), exchanges their shifts in Results, and sends Zoho their new schedules. Add breaks and lunch afterwards with Breaks.</li>
        <li><b>Day swaps</b> swap rest days, after the push, and are always open: in one Monday-to-Sunday week, one agent gives a work day the other has off, and takes a day off the other works. Approving gives each agent the partner's day: they start at the partner's usual start time but work their own length (9 or 11 hours), breaks and lunch, in Assembled as <b>Shift Swap</b>. Daily and weekly hours stay the same.</li>
        <li>An agent asks a colleague in the same LOB, and the colleague accepts before it reaches you. Requests are listed oldest first.</li>
        <li>Shift trades have a <b>trade window</b> (below): agents can only ask for and accept trades while it is open. Declining, cancelling and your decisions work any time.</li>
        <li>Running Auto assign again after approving trades undoes them.</li>
      </ol>
    </aside>
    <div class="card"><h2>${esc(currentLob)} day swaps waiting for you</h2><div id="swPending" class="muted">Loading</div></div>
    ${windowCardHtml("trade")}
    <div class="card span-6"><h2>All LOB trade windows</h2><div id="swwList" class="muted">Loading</div></div>
    <div class="card"><h2>Other ${esc(currentLob)} shift trades</h2><div id="trOther" class="muted">Loading</div></div>
    <div class="card"><h2>Other ${esc(currentLob)} day swaps</h2><div id="swOther" class="muted">Loading</div></div>`;
  for(const kind of Object.keys(WINDOW_KINDS)){
    const id = suffix => `#${WINDOW_KINDS[kind].prefix}${suffix}`;
    el(id("Save")).onclick = ()=> saveSwapWindow(kind);
    el(id("CloseNow")).onclick = ()=> closeSwapWindowNow(kind);
    el(id("Remove")).onclick = ()=> removeSwapWindow(kind);
  }
  loadAdminSwaps();
  loadAdminTrades();
  loadSwapWindows(true);
}
// Shift trades for the current LOB, oldest first: approve (exchanges the two assignments) or reject.
async function loadAdminTrades(){
  const pendingBox = el("#trPending"), otherBox = el("#trOther");
  if(!pendingBox) return;
  await sb.rpc("expire_closed_trades");   // unanswered trades in a closed window become auto declined
  const { data, error } = await selectAll(()=>sb.from("shift_trades").select(
    "*, requester:agents!shift_trades_requester_id_fkey(name), partner:agents!shift_trades_partner_id_fkey(name)," +
    "requester_shift:shift_shells!shift_trades_requester_shift_id_fkey(*), partner_shift:shift_shells!shift_trades_partner_shift_id_fkey(*)")
    .eq("lob", currentLob), "created_at");
  if(error){
    const missing = /shift_trades/.test(error.message) || ["42P01", "PGRST205"].includes(error.code);
    pendingBox.innerHTML = otherBox.innerHTML = `<div class="msg ${missing ? "warn" : "err"}">${missing ? "Shift trades are not in the database yet. Run the Shift trades SQL in Supabase first." : esc(error.message)}</div>`;
    return;
  }
  const pending = data.filter(t=>t.status === "pending_admin"), others = data.filter(t=>t.status !== "pending_admin");
  // Trades whose two agents are both in Assembled already are approved from a start date, with a preview.
  const ids = [...new Set(pending.flatMap(t=>[t.requester_id, t.partner_id]))];
  const pushedRes = ids.length ? await sb.from("assignments").select("agent_id,pushed_at").in("agent_id", ids) : { data:[] };
  const pushedIds = new Set((pushedRes.data || []).filter(r=>r.pushed_at).map(r=>r.agent_id));
  const afterPush = t => pushedIds.has(t.requester_id) && pushedIds.has(t.partner_id);
  const t0 = etToday(), firstMonday = addDays(t0, ((8 - new Date(`${t0}T00:00:00Z`).getUTCDay()) % 7) || 7);
  pendingBox.innerHTML = pending.length ? pending.map((t, i)=>`
    <div class="swap-review" data-trade="${t.id}" data-after-push="${afterPush(t) ? 1 : ""}">
      <div class="swap-order"><b>#${i + 1}</b> <span class="muted">Requested ${esc(fmtET(t.created_at))}</span></div>
      <div class="swap-pair"><b>${esc(t.requester?.name)}</b> <span class="muted">${esc(t.requester_shift ? describeShell(t.requester_shift, false) : shellText(null))} ${setBadge(t.requester_shift?.set_name)}</span>
        <span class="swap-arrow">&harr;</span><b>${esc(t.partner?.name)}</b> <span class="muted">${esc(t.partner_shift ? describeShell(t.partner_shift, false) : shellText(null))} ${setBadge(t.partner_shift?.set_name)}</span></div>
      ${afterPush(t) ? `
        <p class="muted">Trade for good, <b>after the push</b>: both schedules are in Assembled. Approving rewrites both agents' days in Assembled from the start date to the end of their pushed schedule, then exchanges their shifts in Results.${t.note ? ` &ldquo;${esc(t.note)}&rdquo;` : ""}</p>
        <div class="row"><div style="max-width:240px"><label>New shifts start on (a Monday)</label><input type="date" class="trStart" value="${firstMonday}" min="${firstMonday}" step="7" /></div></div>`
      : `<p class="muted">Trade for good: each gets the other's shift as their new schedule.${t.note ? ` &ldquo;${esc(t.note)}&rdquo;` : ""}</p>`}
      <label>Note to the agents (optional)</label><input class="trNote" maxlength="300" />
      <div class="actions">
        ${afterPush(t) ? `<button class="ghost" data-trade-act="preview">Preview changes</button><button data-trade-act="approve" disabled>Approve trade</button>`
          : `<button data-trade-act="approve">Approve trade</button>`}
        <button class="danger" data-trade-act="reject">Reject</button>
      </div>
      <div class="trMsg"></div><div class="swPreview"></div>
    </div>`).join("") : `No ${esc(currentLob)} shift trades are waiting for approval.`;
  pendingBox.querySelectorAll(".swap-review[data-trade]").forEach(card=>{
    const id = Number(card.dataset.trade), msg = card.querySelector(".trMsg"), out = card.querySelector(".swPreview");
    const viaAssembled = !!card.dataset.afterPush, approveBtn = card.querySelector('[data-trade-act="approve"]');
    const start = ()=> card.querySelector(".trStart")?.value;
    let previewed = null;   // the start date the preview was for
    const busy = on => card.querySelectorAll("button").forEach(x=>{ x.disabled = on || (viaAssembled && x === approveBtn && previewed !== start()); });
    card.querySelector(".trStart")?.addEventListener("change", ()=>{ previewed = null; out.innerHTML = ""; msg.innerHTML = ""; busy(false); });
    const done = async text => { await loadAdminTrades(); el("#trPending").insertAdjacentHTML("afterbegin", text); markPendingSwaps(); };
    card.querySelectorAll("button[data-trade-act]").forEach(b=>{
      b.onclick = async ()=>{
        const act = b.dataset.tradeAct, note = card.querySelector(".trNote").value;
        if(act === "preview"){
          if(!start()){ msg.innerHTML = `<div class="msg err">Pick the Monday the new shifts start.</div>`; return; }
          busy(true); msg.innerHTML = `<div class="msg warn">Checking Assembled</div>`;
          const { ok, body } = await swapApi({ trade:true, action:"preview", id, startDate: start() });
          previewed = ok && !body.issues.length ? start() : null;
          busy(false);
          if(!ok){ msg.innerHTML = `<div class="msg err">${esc(body.error)}</div>`; out.innerHTML = ""; return; }
          msg.innerHTML = body.issues.length
            ? `<div class="msg err">This trade cannot be approved from ${esc(fmtDate(body.startDate))} yet:<br>${body.issues.map(esc).join("<br>")}</div>`
            : `<div class="msg good">Preview only, nothing has changed yet. Approving changes both agents' schedules in Assembled as shown below. Check it, then click Approve trade.</div>`;
          out.innerHTML = renderTradePreview(body);
          return;
        }
        if(act === "approve" && viaAssembled){
          if(previewed !== start()) return;
          if(!confirm(`Approve this trade from ${fmtDate(start())}? This rewrites both agents' schedules in Assembled straight away.`)) return;
          busy(true); msg.innerHTML = `<div class="msg warn">Updating Assembled. This can take up to a minute.</div>`;
          const { ok, body } = await swapApi({ trade:true, action:"approve", id, startDate: start(), note });
          busy(false);
          if(!ok){ msg.innerHTML = `<div class="msg err">${esc(body.error)}${(body.issues||[]).length ? "<br>" + body.issues.map(esc).join("<br>") : ""}</div>`; return; }
          const zr = body.zoho && body.zoho.result;
          await done(`<div class="msg good">Trade approved. From ${esc(fmtDate(body.startDate))}, ${body.people.map(p=>`${esc(p.name)} works ${esc(describeShell(p.to, false))}`).join(" and ")} in Assembled, and their shifts are exchanged in Results.
            Add breaks and lunch for both from ${esc(fmtDate(body.startDate))} with Breaks on the Apply to Assembled tab.${zr && zr.every(x=>x.ok) ? " Zoho is updated for both." : ""}</div>
            ${zr && zr.some(x=>!x.ok) ? `<div class="msg warn">Zoho was not updated for ${zr.filter(x=>!x.ok).map(x=>`${esc(x.name)} (${esc(x.error)})`).join("; ")}. Update their schedule in Zoho by hand.</div>` : ""}
            ${!zr ? `<div class="msg warn">Zoho was not updated${body.zoho && body.zoho.off ? `: ${esc(String(body.zoho.off).replace(/.$/, ""))}` : body.zoho && body.zoho.error ? `: ${esc(body.zoho.error)}` : ": sending to Zoho is off"}. Update both schedules in Zoho by hand.</div>` : ""}`);
          return;
        }
        const approve = act === "approve";
        card.querySelectorAll("button").forEach(x=>{ x.disabled = true; });
        const { error } = await sb.rpc("decide_trade", { p_id:id, p_approve:approve, p_note:note });
        if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; busy(false); return; }
        await done(`<div class="msg good">${approve ? "Trade approved. Their shifts are exchanged in Results and will go to Assembled when you push." : "Trade rejected."}</div>`);
      };
    });
  });
  otherBox.innerHTML = others.length ? `<table><thead><tr><th>Requested</th><th>Agents</th><th>Shifts</th><th>Status</th><th>Decided</th><th>Note</th></tr></thead><tbody>
    ${others.map(t=>`<tr><td>${esc(fmtET(t.created_at))}</td>
      <td>${esc(t.requester?.name)} &harr; ${esc(t.partner?.name)}</td>
      <td class="muted">${esc(shellText(t.requester_shift))} &harr; ${esc(shellText(t.partner_shift))}</td>
      <td>${swapPill(t.status, ({ pending_partner:`Waiting for ${t.partner?.name || "partner"}`, approved: t.start_date ? `Approved, from ${fmtDate(t.start_date)}` : "Approved",
        declined: t.auto_declined ? "Auto declined: window closed" : "Declined by partner",
        cancelled:"Cancelled by requester", rejected:"Rejected" })[t.status] || t.status)}</td>
      <td>${t.decided_at ? `${esc(new Date(t.decided_at).toLocaleDateString("en-US", { timeZone:APP_TZ }))}<div class="muted">${esc(t.decided_by || "")}</div>` : ""}</td>
      <td>${esc(t.admin_note || t.note || "")}${t.result && t.result.added != null ? `<div class="muted">${t.result.removed} old days removed, ${t.result.added} new shifts added in Assembled</div>` : ""}</td></tr>`).join("")}
    </tbody></table>` : "No other shift trades yet.";
}
// What approving a trade after the push changes in Assembled and Zoho, from the preview.
function renderTradePreview(p){
  const time = t => new Date(t * 1000).toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit", timeZone:APP_TZ });
  const rows = p.people.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td class="muted">${esc(describeShell(x.from, false))}</td><td><b>${esc(describeShell(x.to, false))}</b></td>
    <td>${x.through ? `${esc(fmtDate(p.startDate))} to ${esc(fmtDate(x.through))}<div class="muted">${x.removed.length} old day${x.removed.length === 1 ? "" : "s"} removed, ${x.added.length} new shift${x.added.length === 1 ? "" : "s"} added${x.shiftType ? ` as ${esc(x.shiftType)}` : ""}</div>`
      : `<span class="muted">Nothing in Assembled from ${esc(fmtDate(p.startDate))}</span>`}</td></tr>`).join("");
  const points = [];
  for(const x of p.people){
    for(const m of x.moves) points.push(`${esc(x.name)}: the shift on ${esc(fmtDate(m.from))} moves to ${esc(fmtDate(m.to))} that week, so they don't work too many days in a row.`);
    for(const n of x.notes) points.push(esc(n));
    for(const o of x.outside) points.push(o.timeoff
      ? `${esc(x.name)}'s ${esc(o.type)} on ${esc(fmtDate(o.date))} is kept, but that is now a day off for them. Remove it in Assembled if it's no longer needed.`
      : `${esc(x.name)}'s ${esc(o.type)} on ${esc(fmtDate(o.date))}, ${esc(time(o.start))} to ${esc(time(o.end))}, is kept at the same time, but it is outside their new hours. Move it in Assembled.`);
    for(const c of x.conflicts) points.push(`${esc(x.name)} already has ${esc(c.found)} on ${esc(fmtDate(c.date))} at the new shift's time, so no shift is added that day. Add it in Assembled by hand.`);
  }
  const kept = p.people.reduce((n, x)=>n + x.kept, 0), breaks = p.people.reduce((n, x)=>n + x.droppedBreaks, 0);
  return `<table><thead><tr><th>From ${esc(fmtDate(p.startDate))}</th><th>Now</th><th>New shift</th><th>In Assembled</th></tr></thead><tbody>${rows}</tbody></table>
    ${p.warnings.length ? `<div class="msg warn">${p.warnings.map(esc).join("<br>")}</div>` : ""}
    ${points.length ? `<ul class="preview-list">${points.map(x=>`<li>${x}</li>`).join("")}</ul>` : ""}
    <p class="muted">Times are in ET. ${kept ? `${kept} training, meeting or time-off event${kept === 1 ? " is" : "s are"} kept as ${kept === 1 ? "it is" : "they are"}. ` : ""}${breaks ? "Breaks and lunch are not copied, because the hours change: after approving, add them with Breaks on the Apply to Assembled tab. " : ""}Days before ${esc(fmtDate(p.startDate))} are not changed.</p>
    ${tradeZohoNote(p.zoho)}`;
}
function tradeZohoNote(z){
  if(!z) return "";
  if(z.off) return `<p class="muted">Zoho: not updated. ${esc(z.off)}</p>`;
  if(z.error) return `<div class="msg warn">Zoho could not be checked (${esc(z.error)}). Approving still updates Assembled; update Zoho by hand.</div>`;
  if(!z.sendingOn) return `<p class="muted">Zoho: sending is turned off, so only Assembled is updated.</p>`;
  const ok = z.people.filter(x=>!x.problems.length), bad = z.people.filter(x=>x.problems.length);
  return `<div class="msg ${bad.length ? "warn" : "good"}">Zoho: approving also sends ${ok.length ? ok.map(x=>`<b>${esc(x.zohoName)}</b>`).join(" and ") : "nobody"} their new schedule from the start date (permanent: Only for this range unticked).${bad.length ? ` Not ${bad.map(x=>`${esc(x.name)} (${esc(x.problems.join("; "))})`).join("; ")}: update them in Zoho by hand.` : ""}</div>`;
}
// ---- trade windows (one per LOB): when agents may ask for and accept shift trades, stored in
// swap_windows with kind 'trade'. Day swaps are always open, so they have no window.
const WINDOW_KINDS = {
  trade: { prefix:"tw", title:"trade window", noun:"shift trades", fromBid:true,
    hint:"Agents can ask for and accept shift trades only between these times. Usually it opens when bidding closes and ends before you push." },
};
const windowStatus = (w, now = Date.now()) => now < Date.parse(w.opens_at) ? "Upcoming" : now > Date.parse(w.closes_at) ? "Closed" : "Open";
function windowCardHtml(kind){
  const k = WINDOW_KINDS[kind], p = k.prefix, lob = esc(currentLob);
  return `<div class="card span-6">
      <h2>${lob} ${k.title}</h2>
      <p class="muted">${k.hint} Without a window, ${k.noun} are closed.</p>
      <div id="${p}Status"></div>
      <div class="row">
        <div><label for="${p}Open">Opens (ET)</label><input id="${p}Open" type="datetime-local" /></div>
        <div><label for="${p}Close">Closes (ET)</label><input id="${p}Close" type="datetime-local" /></div>
      </div>
      ${k.fromBid ? `<div class="actions" id="${p}FromBidRow" hidden><button class="small ghost" id="${p}FromBid" type="button">Open when ${lob} bidding closes</button></div>` : ""}
      <div class="actions">
        <button id="${p}Save" type="button">Save ${k.title}</button>
        <button class="ghost" id="${p}CloseNow" type="button" hidden>Close ${k.noun} now</button>
        <button class="danger" id="${p}Remove" type="button" hidden>Remove window</button>
      </div>
      <div id="${p}Msg"></div>
    </div>`;
}
// Rows from before the split have no kind: they are trade windows.
const windowKind = w => w.kind || "trade";
async function loadSwapWindows(fillForm){
  const list = el("#swwList"), lob = currentLob;
  if(!list) return;
  const [{ data, error }, { data: bidWin }] = await Promise.all([
    sb.from("swap_windows").select("*").order("lob"),
    sb.from("bid_windows").select("lob,closes_at").eq("lob", lob).maybeSingle(),
  ]);
  if(error){
    const missing = /swap_windows/.test(error.message) || ["42P01", "PGRST205"].includes(error.code);
    list.innerHTML = `<div class="msg err">${missing ? "Windows are not in the database yet. Run the Swap windows SQL in Supabase first." : esc(error.message)}</div>`;
    for(const k of Object.values(WINDOW_KINDS)) el(`#${k.prefix}Save`).disabled = true;
    return;
  }
  const fmt = fmtET;
  for(const [kind, k] of Object.entries(WINDOW_KINDS)){
    const p = k.prefix, mine = data.find(w=>w.lob === lob && windowKind(w) === kind);
    if(fillForm || !el(`#${p}Open`).value){
      el(`#${p}Open`).value = mine ? toLocalInput(mine.opens_at) : k.fromBid && bidWin ? toLocalInput(bidWin.closes_at) : "";
      el(`#${p}Close`).value = mine ? toLocalInput(mine.closes_at) : "";
    }
    if(k.fromBid){
      el(`#${p}FromBidRow`).hidden = !bidWin;
      el(`#${p}FromBid`).onclick = ()=>{ el(`#${p}Open`).value = toLocalInput(bidWin.closes_at); };
    }
    const state = mine && windowStatus(mine);
    el(`#${p}CloseNow`).hidden = state !== "Open";
    el(`#${p}Remove`).hidden = !mine;
    el(`#${p}Save`).textContent = mine ? "Save changes" : `Save ${k.title}`;
    el(`#${p}Status`).innerHTML = !mine ? `<div class="msg warn">No ${k.title} is set for ${esc(lob)}, so ${esc(lob)} agents cannot ask for ${k.noun}.</div>`
      : state === "Open" ? `<div class="msg good">Open now, until ${esc(fmt(mine.closes_at))}.</div>`
      : state === "Upcoming" ? `<div class="msg warn">Opens ${esc(fmt(mine.opens_at))}.</div>`
      : `<div class="msg warn">Closed ${esc(fmt(mine.closes_at))}. Set new times to open it again.</div>`;
  }
  const pill = s => `<span class="pill ${s === "Open" ? "ok" : "warn"}">${s}</span>`;
  const rows = data.filter(w=>windowKind(w) === "trade").sort((a,b)=>a.lob.localeCompare(b.lob));
  list.innerHTML = rows.length ? `<table><thead><tr><th>LOB</th><th>Opens</th><th>Closes</th><th>Status</th></tr></thead><tbody>
    ${rows.map(w=>`<tr><td>${w.lob === lob ? `<b>${esc(w.lob)}</b>` : esc(w.lob)}</td>
      <td>${esc(fmt(w.opens_at))}</td><td>${esc(fmt(w.closes_at))}</td><td>${pill(windowStatus(w))}</td></tr>`).join("")}
    </tbody></table>` : "No trade windows set.";
}
async function saveSwapWindow(kind){
  const k = WINDOW_KINDS[kind], p = k.prefix, lob = currentLob;
  const o = el(`#${p}Open`).value, c = el(`#${p}Close`).value, msg = el(`#${p}Msg`), btn = el(`#${p}Save`);
  if(!o || !c){ msg.innerHTML = `<div class="msg err">Fill in both times.</div>`; return; }
  if(fromETInput(o) >= fromETInput(c)){ msg.innerHTML = `<div class="msg err">The close time must be after the open time.</div>`; return; }
  btn.disabled = true;
  const { error } = await sb.from("swap_windows").upsert(
    { lob, kind, opens_at: fromETInput(o).toISOString(), closes_at: fromETInput(c).toISOString(), updated_at: new Date().toISOString() }, { onConflict:"lob,kind" });
  btn.disabled = false;
  if(error){ msg.innerHTML = `<div class="msg err">${esc(/kind/.test(error.message) ? "The two windows are not in the database yet. Run the updated swaps SQL in Supabase first." : error.message)}</div>`; return; }
  msg.innerHTML = `<div class="msg good">Saved the ${esc(lob)} ${k.title}.</div>`;
  loadSwapWindows(true);
}
async function closeSwapWindowNow(kind){
  const k = WINDOW_KINDS[kind], lob = currentLob, msg = el(`#${k.prefix}Msg`);
  if(!confirm(`Close ${lob} ${k.noun} now?\n\n${lob} agents will no longer be able to ask for or accept ${k.noun}. Requests already waiting for you stay, and you can still approve or reject them.${kind === "trade" ? "\n\nTrades the other agent has not accepted yet are auto declined." : ""}`)) return;
  const now = await serverNow();
  const { data: rows } = await sb.from("swap_windows").select("opens_at").eq("lob", lob).eq("kind", kind);
  const w = (rows || [])[0];
  if(!w){ loadSwapWindows(true); return; }
  if(now < Date.parse(w.opens_at)){ msg.innerHTML = `<div class="msg err">This window has not opened yet. Use Remove window instead.</div>`; return; }
  const { error } = await sb.from("swap_windows").update({ closes_at: new Date(now - 1000).toISOString(), updated_at: new Date().toISOString() }).eq("lob", lob).eq("kind", kind);
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  msg.innerHTML = `<div class="msg good">Closed ${esc(lob)} ${k.noun}.</div>`;
  loadSwapWindows(true);
}
async function removeSwapWindow(kind){
  const k = WINDOW_KINDS[kind], p = k.prefix, lob = currentLob, msg = el(`#${p}Msg`);
  if(!confirm(`Remove the ${lob} ${k.title}?\n\n${lob} agents will not be able to ask for or accept ${k.noun} until you set a new one.`)) return;
  const { error } = await sb.from("swap_windows").delete().eq("lob", lob).eq("kind", kind);
  if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  el(`#${p}Open`).value = ""; el(`#${p}Close`).value = "";
  msg.innerHTML = `<div class="msg good">Removed the ${esc(lob)} ${k.title}.</div>`;
  loadSwapWindows(true);
}
async function swapApi(payload){
  const { data:{ session } } = await sb.auth.getSession();
  const r = await fetch("/api/swaps", { method:"POST", body:JSON.stringify(payload),
    headers:{ Authorization:`Bearer ${session.access_token}`, "Content-Type":"application/json" } });
  return { ok:r.ok, body: await r.json().catch(()=>({ error:`Request failed (${r.status})` })) };
}
// Swaps waiting for an admin, across every LOB: { lob: count }.
async function pendingSwapCounts(){
  const [{ data }, trades] = await Promise.all([
    sb.from("swap_requests").select("id,lob").eq("status", "pending_admin"),
    sb.from("shift_trades").select("id,lob").eq("status", "pending_admin"),
  ]);
  const counts = {};
  for(const r of [...(data || []), ...(trades.error ? [] : trades.data || [])]) counts[r.lob] = (counts[r.lob] || 0) + 1;
  return counts;
}
// Shows how many swaps are waiting (all LOBs) on the Swaps menu item.
async function markPendingSwaps(){
  const total = Object.values(await pendingSwapCounts()).reduce((a, b)=>a + b, 0);
  const btn = document.querySelector('#railNav button[data-t="swaps"]');
  if(!btn) return;
  btn.querySelector(".tab-badge")?.remove();
  if(total) btn.insertAdjacentHTML("beforeend", `<span class="tab-badge" title="${total} swap${total===1?"":"s"} waiting for approval">${total}</span>`);
}
async function loadAdminSwaps(){
  const pendingBox = el("#swPending"), otherBox = el("#swOther");
  // Oldest request first, so swaps are handled in the order agents asked for them.
  const { data, error } = await selectAll(()=>sb.from("swap_requests").select(
    "*, requester:agents!swap_requests_requester_id_fkey(name), partner:agents!swap_requests_partner_id_fkey(name)," +
    "requester_shift:shift_shells!swap_requests_requester_shift_id_fkey(*), partner_shift:shift_shells!swap_requests_partner_shift_id_fkey(*)")
    .eq("lob", currentLob), "created_at");
  if(error){ pendingBox.innerHTML = otherBox.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  const pending = data.filter(r=>r.status === "pending_admin"), others = data.filter(r=>r.status !== "pending_admin");

  pendingBox.innerHTML = pending.length ? pending.map((r, i)=>`
    <div class="swap-review" data-id="${r.id}">
      <div class="swap-order"><b>#${i + 1}</b> <span class="muted">Requested ${esc(fmtET(r.created_at))}</span></div>
      <div class="swap-pair"><b>${esc(r.requester?.name)}</b> <span class="muted">${esc(shellText(r.requester_shift))}</span>
        <span class="swap-arrow">&harr;</span><b>${esc(r.partner?.name)}</b> <span class="muted">${esc(shellText(r.partner_shift))}</span></div>
      ${r.give_date
        ? `<p class="swap-days"><b>Rest-day swap</b> &middot; ${esc(r.requester?.name)}: off ${esc(fmtDate(r.give_date))}, works ${esc(fmtDate(r.take_date))}
            &middot; ${esc(r.partner?.name)}: works ${esc(fmtDate(r.give_date))}, off ${esc(fmtDate(r.take_date))}${r.note ? ` &middot; &ldquo;${esc(r.note)}&rdquo;` : ""}</p>`
        : `<p class="muted">Asked for ${esc(fmtDate(r.start_date))}.${r.note ? ` &ldquo;${esc(r.note)}&rdquo;` : ""}</p>
           <div class="row">
             <div style="max-width:240px"><label>Day</label><input type="date" class="swDate" value="${r.start_date}" /></div>
           </div>`}
      <label>Note to the agents (optional)</label><input class="swNote" maxlength="300" />
      <div class="actions">
        <button class="ghost" data-act="preview">Preview changes</button>
        <button data-act="approve" disabled>Approve swap</button>
        <button class="danger" data-act="reject">Reject</button>
      </div>
      <div class="swMsg"></div><div class="swPreview"></div>
    </div>`).join("") : `No ${esc(currentLob)} day swaps are waiting for approval.<div id="swElsewhere"></div>`;
  if(!pending.length){
    // Swaps are listed per LOB, so point to any other LOB that has some waiting.
    const counts = await pendingSwapCounts(), lobs = Object.keys(counts).filter(l=>l !== currentLob).sort();
    const box = el("#swElsewhere");
    if(box && lobs.length){
      box.innerHTML = `<div class="msg warn" style="margin-top:10px">Waiting in other LOBs: ${lobs.map(l=>
        `<button class="small" data-go-lob="${esc(l)}" type="button">${esc(l)} (${counts[l]})</button>`).join(" ")}</div>`;
      box.querySelectorAll("button[data-go-lob]").forEach(b=>{
        b.onclick = async ()=>{
          if(!leaveUnsavedOk()) return;
          currentLob = b.dataset.goLob;
          try{ localStorage.setItem(LOB_KEY, currentLob); }catch{}
          await renderAdmin();
        };
      });
    }
  }
  markPendingSwaps();

  otherBox.innerHTML = others.length ? `<table><thead><tr><th>Requested</th><th>Dates</th><th>Agents</th><th>Status</th><th>Decided</th><th>Note</th></tr></thead><tbody>
    ${others.map(r=>`<tr><td>${esc(fmtET(r.created_at))}</td><td>${r.give_date ? `${esc(fmtDate(r.give_date))} &harr; ${esc(fmtDate(r.take_date))}` : esc(fmtRange(r.start_date, r.end_date))}</td>
      <td>${esc(r.requester?.name)} &harr; ${esc(r.partner?.name)}</td>
      <td>${swapPill(r.status, ({ pending_partner:`Waiting for ${r.partner?.name || "partner"}`, approved:"Approved", declined:"Declined by partner",
        cancelled:"Cancelled by requester", rejected:"Rejected" })[r.status] || r.status)}</td>
      <td>${r.decided_at ? `${esc(new Date(r.decided_at).toLocaleDateString("en-US", { timeZone:APP_TZ }))}<div class="muted">${esc(r.decided_by || "")}</div>` : ""}</td>
      <td>${esc(r.admin_note || r.note || "")}${r.result && r.result.moved != null ? `<div class="muted">${r.result.moved} events moved in Assembled</div>`
        : r.result && r.result.added != null ? `<div class="muted">${r.result.added} Shift Swap and break events added in Assembled</div>` : ""}</td></tr>`).join("")}
    </tbody></table>` : "No other swaps yet.";

  pendingBox.querySelectorAll(".swap-review").forEach(card=>{
    const id = Number(card.dataset.id), msg = card.querySelector(".swMsg"), out = card.querySelector(".swPreview");
    const approveBtn = card.querySelector('[data-act="approve"]');
    const dates = () => card.querySelector(".swDate") ? { date: card.querySelector(".swDate").value } : {};
    let previewed = null;
    card.querySelectorAll(".swDate").forEach(i=>{ i.onchange = ()=>{ previewed = null; approveBtn.disabled = true; out.innerHTML = ""; msg.innerHTML = ""; }; });
    const busy = on => card.querySelectorAll("button").forEach(b=>{ b.disabled = on || (b === approveBtn && !previewed); });

    card.querySelector('[data-act="preview"]').onclick = async ()=>{
      const d = dates();
      if(card.querySelector(".swDate") && !d.date){ msg.innerHTML = `<div class="msg err">Pick the day to swap.</div>`; return; }
      busy(true); msg.innerHTML = `<div class="msg warn">Checking Assembled</div>`;
      const { ok, body } = await swapApi({ action:"preview", id, ...d });
      previewed = ok && !body.issues.length ? JSON.stringify(d) : null;
      busy(false);
      if(!ok){ msg.innerHTML = `<div class="msg err">${esc(body.error)}</div>`; return; }
      msg.innerHTML = body.issues.length
        ? `<div class="msg err">This swap cannot be approved yet:<br>${body.issues.map(esc).join("<br>")}</div>`
        : `<div class="msg good">Preview only, nothing has changed yet. Approving changes both agents' schedules in Assembled as shown below. Check it, then click Approve swap.</div>`;
      out.innerHTML = renderSwapPreview(body);
    };
    approveBtn.onclick = async ()=>{
      const d = dates();
      if(previewed !== JSON.stringify(d)) return;
      if(!confirm(`Approve this swap? This changes both agents' schedules in Assembled straight away.`)) return;
      busy(true); msg.innerHTML = `<div class="msg warn">Updating Assembled</div>`;
      const { ok, body } = await swapApi({ action:"approve", id, ...d, note: card.querySelector(".swNote").value });
      busy(false);
      if(!ok){ msg.innerHTML = `<div class="msg err">${esc(body.error)}${(body.issues||[]).length ? "<br>" + body.issues.map(esc).join("<br>") : ""}</div>`; return; }
      await loadAdminSwaps();
      el("#swPending").insertAdjacentHTML("afterbegin", `<div class="msg good">Approved. ${body.restDay
        ? `Both agents' days are updated in Assembled: ${esc(fmtDate(body.giveDate))} and ${esc(fmtDate(body.takeDate))}, as Shift Swap.`
        : `Both agents' ${esc(fmtDate(body.date))} is updated in Assembled as Shift Swap.`}</div>`);
    };
    card.querySelector('[data-act="reject"]').onclick = async ()=>{
      if(!confirm("Reject this swap? Nothing changes in Assembled.")) return;
      busy(true);
      const { ok, body } = await swapApi({ action:"reject", id, note: card.querySelector(".swNote").value });
      busy(false);
      if(!ok){ msg.innerHTML = `<div class="msg err">${esc(body.error)}</div>`; return; }
      await loadAdminSwaps();
      el("#swPending").insertAdjacentHTML("afterbegin", `<div class="msg good">Swap rejected.</div>`);
    };
  });
}
// What one day swap does in Assembled: for each agent, the day that is removed and the day
// they get instead (the partner's day, with the work as Shift Swap and breaks and lunch kept).
function renderSwapPreview(p){
  const time = t => new Date(t * 1000).toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", timeZone:APP_TZ });
  const day = events => events.length
    ? `<b>${time(events[0].start)} to ${time(Math.max(...events.map(e=>e.end)))}</b>
       <div class="muted">${events.map(e=>`${esc(e.type)} ${time(e.start)}`).join(" &middot; ")}</div>`
    : `<span class="muted">Day off</span>`;
  const hours = events => { const s = events.filter(e=>!/break|lunch/i.test(e.type)).reduce((n, e)=>n + (e.end - e.start), 0) / 3600; return s ? ` <span class="muted">(${+s.toFixed(2)} h worked)</span>` : ""; };
  const label = (side, which) => p.restDay ? `${which === "removed" ? "Off" : "Works"} ${esc(fmtDate(side[which === "removed" ? "removedDate" : "addedDate"]))}` : "";
  return `<table><thead><tr><th>${p.restDay ? "Rest-day swap" : esc(fmtDate(p.date))}</th><th>Removed from Assembled</th><th>Gets instead</th></tr></thead><tbody>
    ${[[p.requester, p.a], [p.partner, p.b]].map(([who, side])=>`<tr><td><b>${esc(who.name)}</b></td>
      <td>${p.restDay ? `<div class="muted">${label(side, "removed")}</div>` : ""}${day(side.removed)}${hours(side.removed)}</td>
      <td>${p.restDay ? `<div class="muted">${label(side, "added")}</div>` : ""}${day(side.added)}${hours(side.added)}</td></tr>`).join("")}
    </tbody></table><p class="muted">Times are in ET.${p.restDay ? " On the day they pick up, each starts at the partner's usual start time and works their own length, breaks and lunch." : ""}</p>`;
}

boot();
