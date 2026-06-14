// Attach (or change) the mobile number used for SUPERADMIN phone-OTP login.
// The admin console now signs in only via a phone OTP, so the number must be
// on an account that holds the admin_panel permission.
//
// Usage:
//   npm run set-admin-phone -- <admin-email> <phone>
//   node --experimental-sqlite scripts/set-admin-phone.js admin@regear.in 9876543210
//
// Recovery: run this any time you change phones or get locked out.
const db = require('../db');

const email = (process.argv[2] || '').trim();
const phone = (process.argv[3] || '').trim();

if (!email || !phone) {
  console.error('Usage: npm run set-admin-phone -- <admin-email> <phone>');
  process.exit(1);
}

const u = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?) OR username=?').get(email, email);
if (!u) {
  console.error('No user found with email/username: ' + email);
  console.error('Tip: the seeded superadmin is admin@regear.in');
  process.exit(1);
}

const perms = db.prepare(`SELECT DISTINCT rp.perm FROM user_roles ur
  JOIN role_permissions rp ON rp.role_key=ur.role_key WHERE ur.user_id=?`).all(u.id).map(r => r.perm);
if (!perms.includes('admin_panel')) {
  console.error('User "' + email + '" exists but is NOT a superadmin (no admin_panel permission).');
  console.error('Give it the Super Admin role in Admin → Access first, or pick the seeded admin@regear.in.');
  process.exit(1);
}

db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, u.id);
console.log('✔ Set login phone "' + phone + '" on superadmin: ' + (u.email || u.username));
console.log('  Sign in at /admin by entering this number and the OTP.');
