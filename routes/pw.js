// Password hashing with Node's built-in scrypt (no dependency).
// Verifies legacy plaintext too, so existing accounts keep working and
// get upgraded to a hash on their next successful login.
const crypto = require('crypto');

function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + dk;
}
function isHashed(s) { return typeof s === 'string' && s.startsWith('scrypt$'); }
function verify(pw, stored) {
  if (!stored) return false;
  if (isHashed(stored)) {
    const [, salt, dk] = stored.split('$');
    const calc = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    const a = Buffer.from(dk, 'hex'), b = Buffer.from(calc, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return stored === String(pw); // legacy plaintext
}
module.exports = { hash, verify, isHashed };
