// Single email hook. Plug a provider via env (RESEND_API_KEY), else it logs in demo mode.
// Mirrors the SMS deliver() pattern in otp.js — no frontend changes needed to go live.
const RESEND = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'ReGear <updates@regear.in>';

async function sendEmail(to, subject, text) {
  if (!to) return;
  if (RESEND) {
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to, subject, text }),
        signal: ctrl.signal,
      });
      clearTimeout(tm);
      if (!r.ok) console.error('[MAIL] provider responded', r.status);
    } catch (e) {
      console.error('[MAIL] send failed:', e.message);
    }
  } else {
    console.log(`[MAIL demo] to=${to} | ${subject}\n            ${text}`);
  }
}

module.exports = { sendEmail };
