// Zoom-meetings aanmaken via de Zoom API (Server-to-Server OAuth).
// Instellingen in instellingen/zoom: { accountId, clientId, clientSecret }.
const https = require('https');
let tok = { token: '', exp: 0 };

function zoomConfig(doc) { if (!doc || !doc.accountId || !doc.clientId || !doc.clientSecret) return null; return doc; }

function req(host, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path, method, headers, timeout: 15000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = {}; try { j = b ? JSON.parse(b) : {}; } catch (e) {} if (res.statusCode < 300) return resolve(j); reject(new Error((j && (j.message || j.error)) || ('Zoom ' + res.statusCode))); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Zoom timeout')); });
    if (body) r.write(body); r.end();
  });
}

async function token(cfg) {
  if (tok.token && Date.now() < tok.exp) return tok.token;
  const auth = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
  const j = await req('zoom.us', '/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(cfg.accountId), 'POST',
    { 'Authorization': 'Basic ' + auth, 'Content-Length': 0 });
  tok = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 };
  return j.access_token;
}

// start: 'YYYY-MM-DDTHH:MM' lokale Brusselse tijd. Geeft {joinUrl, id}.
async function maakMeeting(cfg, { topic, start, duur }) {
  const t = await token(cfg);
  const body = JSON.stringify({
    topic: topic || 'Kennismaking', type: 2,
    start_time: start.slice(0, 16) + ':00', timezone: 'Europe/Brussels',
    duration: duur || 60, settings: { join_before_host: true, waiting_room: false },
  });
  const j = await req('api.zoom.us', '/v2/users/me/meetings', 'POST',
    { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  return { joinUrl: j.join_url, id: j.id };
}

// Verplaatst een bestaande meeting (zelfde link blijft gelden).
async function wijzigMeeting(cfg, id, { start, duur }) {
  const t = await token(cfg);
  const body = JSON.stringify({ start_time: start.slice(0, 16) + ':00', timezone: 'Europe/Brussels', duration: duur || 60 });
  await req('api.zoom.us', '/v2/meetings/' + encodeURIComponent(id), 'PATCH',
    { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  return true;
}

async function test(cfg) { await token(cfg); return true; }

module.exports = { zoomConfig, maakMeeting, wijzigMeeting, test };
