// Who is an admin, and what each admin may change: the public.admins table, which the database
// security rules use too (is_admin(), has_perm()). Admins and permissions are managed on the app's
// Admins screen. ADMIN_EMAILS (Vercel / .env.local) is only a backup for when the table cannot be
// read, so that removing someone on the Admins screen really removes them.
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY.

// Every permission, and what admins had before permissions existed (all but these two).
const ALL_PERMISSIONS = ["roster", "shells", "windows", "assign", "swaps", "push", "manual", "admins"];
const LEGACY_PERMISSIONS = ALL_PERMISSIONS.filter(p => p !== "manual" && p !== "admins");

// email -> permissions array, or null when the table cannot be read.
async function adminTable() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  try {
    let r = await fetch(`${SUPABASE_URL}/rest/v1/admins?select=email,permissions`, { headers });
    let legacy = false;
    if (!r.ok) { r = await fetch(`${SUPABASE_URL}/rest/v1/admins?select=email`, { headers }); legacy = true; }   // before permissions existed
    if (!r.ok) return null;
    const map = new Map();
    for (const a of await r.json()) if (a.email) map.set(String(a.email).trim().toLowerCase(), legacy || !Array.isArray(a.permissions) ? LEGACY_PERMISSIONS : a.permissions);
    return map;
  } catch { return null; }
}
const envAdmins = () => String(process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

async function adminEmails() {
  const table = await adminTable();
  return table ? [...table.keys()] : envAdmins();
}

async function isAdminEmail(email) {
  return (await adminEmails()).includes(String(email || "").trim().toLowerCase());
}

// The admin's permissions, or null if they are not an admin.
async function permissionsFor(email) {
  const e = String(email || "").trim().toLowerCase(), table = await adminTable();
  if (table) return table.has(e) ? table.get(e) : null;
  return envAdmins().includes(e) ? LEGACY_PERMISSIONS : null;
}

async function hasPermission(email, permission) {
  const perms = await permissionsFor(email);
  return !!perms && perms.includes(permission);
}

module.exports = { adminEmails, isAdminEmail, permissionsFor, hasPermission, ALL_PERMISSIONS };
