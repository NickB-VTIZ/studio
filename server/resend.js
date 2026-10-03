// E-mail via Resend (https://resend.com) — eenvoudige HTTPS-API, geen extra pakket.
const https = require('https');

function resendConfig(env = process.env) {
  if (!env.RESEND_API_KEY) return null;
  return { key: env.RESEND_API_KEY, from: env.RESEND_FROM || env.SMTP_FROM || '' };
}

function sendViaResend({ to, subject, text, replyTo }, cfg = resendConfig()) {
  if (!cfg || !cfg.from || !to) return Promise.resolve(false);
  const body = JSON.stringify({ from: cfg.from, to: [to], subject, text, reply_to: replyTo || undefined });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { if (r.statusCode < 300) return resolve(true); let msg = b; try { msg = JSON.parse(b).message || b; } catch (e) {} reject(new Error('Resend ' + r.statusCode + ': ' + msg)); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.end(body);
  });
}

// Controleert de sleutel zonder een mail te versturen: een POST naar /emails met een leeg body.
// Een geldige sleutel geeft 422 (ontbrekende velden) — de auth is dan gelukt. 401 = sleutel ongeldig.
function testResend(cfg = resendConfig()) {
  if (!cfg) return Promise.reject(new Error('Resend niet ingesteld'));
  const body = '{}';
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 12000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => {
        if (r.statusCode === 401) return reject(new Error('API-sleutel ongeldig. Kopieer de sleutel opnieuw uit Resend (begint met re_).'));
        if (r.statusCode === 403) return reject(new Error('De sleutel wordt herkend maar heeft geen zendrechten. Maak in Resend een sleutel met "Sending access".'));
        return resolve(true); // 422/400/200: auth gelukt, de sleutel werkt
      });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Resend timeout')); }); req.end(body);
  });
}
module.exports = { resendConfig, sendViaResend, testResend };
