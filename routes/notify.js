// Shared order-email helper, used by both admin and operator status changes.
const db = require('../db');
const { sendEmail } = require('./mailer');

// Emails the customer for a given order stage using the editable template,
// gated by the admin "email_notifications" setting (Communications). Missing = on.
function notify(order, status) {
  if (!order || !order.customer_email) return;
  const flag = db.prepare("SELECT value FROM settings WHERE key='email_notifications'").get();
  if (flag && String(flag.value) === '0') return;
  const tpl = db.prepare('SELECT * FROM order_templates WHERE key=?').get(order.type + ':' + status);
  if (!tpl) return;
  const fill = (s) => String(s || '')
    .replace(/{name}/g, order.customer_name || 'there')
    .replace(/{ref}/g, order.ref)
    .replace(/{device}/g, order.device_label || 'your device')
    .replace(/{amount}/g, '₹' + Number(order.amount || 0).toLocaleString('en-IN'))
    .replace(/{status}/g, tpl.label || status);
  sendEmail(order.customer_email, fill(tpl.subject || 'Update on your order'), fill(tpl.body || ''));
}

module.exports = { notify };
