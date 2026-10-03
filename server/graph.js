// Directe agenda-koppeling met Microsoft 365 via Microsoft Graph (OAuth2 authorization code + refresh token).
// Instellingen in instellingen/ms: { clientId, clientSecret, tenant, refreshToken, account }.
// Vereist een eenmalige Azure/Entra app-registratie (zie README).
const https = require('https');

const AUTH_HOST = 'login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'openid offline_access Calendars.ReadWrite';
let tokenCache = { token: '', exp: 0 };

function tenantOf(cfg) { return cfg.tenant || 'common'; }

function authUrl(cfg, redirectUri, state) {
  const q = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: redirectUri,
    response_mode: 'query', scope: SCOPE, state,
  });
  return `https://${AUTH_HOST}/${encodeURIComponent(tenantOf(cfg))}/oauth2/v2.0/authorize?` + q.toString();
}

function postForm(host, path, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} if (r.statusCode < 300) return resolve(j); reject(new Error(j.error_description || j.error || ('Microsoft ' + r.statusCode))); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Microsoft timeout')); });
    req.end(body);
  });
}

function exchangeCode(cfg, code, redirectUri) {
  return postForm(AUTH_HOST, `/${encodeURIComponent(tenantOf(cfg))}/oauth2/v2.0/token`, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, scope: SCOPE,
  });
}

async function accessToken(cfg) {
  if (!cfg || !cfg.refreshToken) throw new Error('Office 365 niet verbonden');
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const j = await postForm(AUTH_HOST, `/${encodeURIComponent(tenantOf(cfg))}/oauth2/v2.0/token`, {
    client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token',
    refresh_token: cfg.refreshToken, scope: SCOPE,
  });
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000, refresh: j.refresh_token };
  return j.access_token;
}
function nieuwRefreshToken() { return tokenCache.refresh; } // na accessToken(): roterend refresh-token indien MS er een nieuw gaf

function graph(method, path, token, body) {
  const data = body ? JSON.stringify(body) : null;
  const headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Prefer': 'outlook.timezone="Romance Standard Time"' };
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  return new Promise((resolve, reject) => {
    const req = https.request(GRAPH + path, { method, headers, timeout: 15000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = {}; try { j = b ? JSON.parse(b) : {}; } catch (e) {} if (r.statusCode < 300) return resolve(j); reject(new Error((j.error && j.error.message) || ('Graph ' + r.statusCode))); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Graph timeout')); });
    if (data) req.write(data); req.end();
  });
}

async function wieBenIk(token) { const me = await graph('GET', '/me', token); return me.mail || me.userPrincipalName || ''; }

const pad = n => String(n).padStart(2, '0');
function eindWall(dt, min) {
  const [y, mo, d] = dt.slice(0, 10).split('-').map(Number);
  const [h, mi] = (dt.slice(11, 16) || '00:00').split(':').map(Number);
  const x = new Date(Date.UTC(y, mo - 1, d, h, mi) + min * 60000);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:00`;
}

// Maakt (of werkt bij) een agenda-afspraak voor een klant. Geeft het event-id terug.
async function zetAfspraak(cfg, klant, duur) {
  const token = await accessToken(cfg);
  if (!klant.kennismaking || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(klant.kennismaking)) throw new Error('Geen geldig tijdstip');
  const start = klant.kennismaking.slice(0, 16) + ':00';
  const body = {
    subject: 'Kennismaking · ' + (klant.naam || 'Klant'),
    start: { dateTime: start, timeZone: 'Romance Standard Time' },
    end: { dateTime: eindWall(klant.kennismaking, duur), timeZone: 'Romance Standard Time' },
    location: { displayName: klant.locatie || '' },
    body: { contentType: 'text', content: [klant.type ? 'Type: ' + klant.type : '', klant.email ? 'E-mail: ' + klant.email : '', klant.telefoon ? 'Tel: ' + klant.telefoon : ''].filter(Boolean).join('\n') },
  };
  if (klant.msEventId) { const ev = await graph('PATCH', '/me/events/' + encodeURIComponent(klant.msEventId), token, body); return ev.id || klant.msEventId; }
  const ev = await graph('POST', '/me/events', token, body);
  return ev.id;
}

module.exports = { authUrl, exchangeCode, accessToken, nieuwRefreshToken, wieBenIk, zetAfspraak };
