// WhatsApp-berichten via Twilio (https://www.twilio.com/whatsapp) — HTTPS-API, geen extra pakket.
// Let op: WhatsApp laat een bedrijf enkel ongevraagd berichten sturen met een vooraf goedgekeurde template,
// of binnen 24u nadat de klant zelf iets stuurde. Zie README.
const https = require('https');

function twilioConfig(env = process.env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_WHATSAPP_FROM) return null;
  return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_WHATSAPP_FROM };
}

// Belgische telefoonnummers naar E.164 (+32…). Geeft null als het niet lukt.
function naarE164(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[\s().\-\/]/g, '');
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('00')) { s = '+' + s.slice(2); return /^\+\d{8,15}$/.test(s) ? s : null; }
  if (s.startsWith('0')) { s = '+32' + s.slice(1); return /^\+\d{8,15}$/.test(s) ? s : null; }
  if (/^\d{8,12}$/.test(s)) return '+32' + s;
  return null;
}

function sendWhatsApp({ to, body }, cfg = twilioConfig()) {
  if (!cfg) return Promise.reject(new Error('Twilio niet ingesteld'));
  const naar = naarE164(to);
  if (!naar) return Promise.reject(new Error('ongeldig telefoonnummer'));
  const from = cfg.from.startsWith('whatsapp:') ? cfg.from : 'whatsapp:' + cfg.from;
  const form = new URLSearchParams({ From: from, To: 'whatsapp:' + naar, Body: String(body || '').slice(0, 1500) }).toString();
  const auth = Buffer.from(cfg.sid + ':' + cfg.token).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
      timeout: 15000,
    }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { const j = JSON.parse(b); if (r.statusCode < 300) return resolve({ sid: j.sid, status: j.status }); reject(new Error(j.message || ('Twilio ' + r.statusCode))); } catch (e) { reject(new Error('Twilio ' + r.statusCode)); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Twilio timeout')); });
    req.end(form);
  });
}

module.exports = { twilioConfig, sendWhatsApp, naarE164 };
