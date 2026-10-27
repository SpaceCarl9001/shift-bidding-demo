// The floating "Demo" panel: switch between sample people, or reset the sample data.
(function () {
  const REPO = "https://github.com/SpaceCarl9001/shift-bidding-demo";
  const PORTFOLIO = "https://spacecarl9001.github.io";
  const SEEN = "shiftBiddingDemo.seenIntro";
  const PEOPLE = [
    { email: "owner@example.com", name: "Owner", role: "Admin, every permission",
      tip: "Run Auto assign for Support, then publish it on Results. On Swaps, preview and approve Jordan's day swap, or a Sales shift trade from a Monday (it rewrites both schedules in Assembled). On Coaches, try Smart Scheduling." },
    { email: "lead@example.com", name: "Team lead", role: "Admin who can only approve swaps and set windows",
      tip: "Every tab is viewable, but buttons outside this admin's permissions are locked." },
    { email: "maria.santos@example.com", name: "Maria Santos", role: "Support agent, bidding is open",
      tip: "Rank the Support shifts from favourite to least favourite and save. Once an admin runs and publishes Auto assign, her shift appears here." },
    { email: "jordan.reyes@example.com", name: "Jordan Reyes", role: "Sales agent with an assigned shift",
      tip: "See the assigned shift and coach, answer Sam's rest-day swap request, or ask a colleague for one. Sales is already in Assembled and its trade window is open, so you can also ask for a permanent trade: the admin picks the Monday it starts." },
    { email: "nora.quinn@example.com", name: "Nora Quinn", role: "Sales coach",
      tip: "Coaches bid on coach shifts too. Nora sees the agents in her coach group, with their shifts." },
  ];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const db = () => window.DemoDB.get();
  const switchTo = email => {
    const d = db(); d.user = email; d.logins[email] = d.logins[email] || "active";
    try { localStorage.setItem("shiftBiddingDemo.db.v1", JSON.stringify(d)); } catch {}
    location.reload();
  };

  function render(open) {
    document.getElementById("demoDock")?.remove();
    const d = db(), current = d.user;
    const known = PEOPLE.find(p => p.email === current);
    const others = [...d.tables.agents.filter(a => !PEOPLE.some(p => p.email === a.email)).map(a => ({ email: a.email, label: `${a.name} (${a.excluded ? "removed" : a.lob})` })),
      ...d.tables.admins.filter(a => !PEOPLE.some(p => p.email === a.email)).map(a => ({ email: a.email, label: `${a.email} (admin)` }))]
      .sort((a, b) => a.label.localeCompare(b.label));
    const who = known ? known.name : current ? (d.tables.agents.find(a => a.email === current)?.name || current) : "Signed out";
    const dock = document.createElement("div");
    dock.id = "demoDock";
    dock.innerHTML = `
      <button type="button" class="demo-fab" aria-expanded="${open}" aria-controls="demoPanel">
        <span class="demo-dot"></span><span>Demo</span><span class="demo-who">${esc(who)}</span></button>
      <section class="demo-panel" id="demoPanel" ${open ? "" : "hidden"} aria-label="Demo controls">
        <header><strong>Live demo</strong><button type="button" class="demo-x" aria-label="Close">&times;</button></header>
        <p class="demo-intro">A shift-bidding app I built for contact center scheduling, running here on made-up people in your browser.
          Nothing leaves this page. Sign in as anyone below to see each side of it.</p>
        <div class="demo-people">
          ${PEOPLE.map(p => `<button type="button" class="demo-person ${p.email === current ? "on" : ""}" data-email="${esc(p.email)}">
            <b>${esc(p.name)}</b><span>${esc(p.role)}</span></button>`).join("")}
        </div>
        ${known ? `<p class="demo-tip"><b>Try:</b> ${esc(known.tip)}</p>` : ""}
        <label class="demo-label" for="demoOther">Or sign in as someone else</label>
        <select id="demoOther"><option value="">Choose a person</option>${others.map(o => `<option value="${esc(o.email)}" ${o.email === current ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
        <div class="demo-actions">
          <button type="button" class="demo-link" id="demoOut">See the sign-in screen</button>
          <button type="button" class="demo-link" id="demoReset">Reset the demo data</button>
        </div>
        <footer><a href="${REPO}" target="_blank" rel="noopener">How it's built (GitHub)</a><a href="${PORTFOLIO}">Back to my portfolio</a></footer>
      </section>`;
    document.body.appendChild(dock);
    const panel = dock.querySelector(".demo-panel"), fab = dock.querySelector(".demo-fab");
    const toggle = show => { panel.hidden = !show; fab.setAttribute("aria-expanded", String(show)); if (!show) { try { localStorage.setItem(SEEN, "1"); } catch {} } };
    fab.onclick = () => toggle(panel.hidden);
    dock.querySelector(".demo-x").onclick = () => toggle(false);
    dock.querySelectorAll(".demo-person").forEach(b => { b.onclick = () => switchTo(b.dataset.email); });
    dock.querySelector("#demoOther").onchange = e => { if (e.target.value) switchTo(e.target.value); };
    dock.querySelector("#demoOut").onclick = () => { const x = db(); x.user = null; try { localStorage.setItem("shiftBiddingDemo.db.v1", JSON.stringify(x)); } catch {} location.reload(); };
    dock.querySelector("#demoReset").onclick = () => {
      if (!confirm("Reset the demo? Everything you changed goes back to the starting sample data.")) return;
      window.DemoDB.reset();
      try { for (const k of Object.keys(localStorage)) if (k.startsWith("shiftBidding")) localStorage.removeItem(k); } catch {}
      location.reload();
    };
  }
  let seen = false; try { seen = !!localStorage.getItem(SEEN); } catch {}
  const start = () => render(!seen);
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  // On the sign-in screen: every sample person signs in with any password.
  new MutationObserver(() => {
    const hint = document.getElementById("loginHint");
    if (hint && !hint.dataset.demo) {
      hint.dataset.demo = "1";
      hint.insertAdjacentHTML("afterend", `<p class="msg demo-login">Demo: try <b>owner@example.com</b> or <b>maria.santos@example.com</b> with any password,
        or use the Demo button to switch people.</p>`);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
