// justPIXIT Studio – server. Enkel Node.js (geen externe pakketten).
// Routes:
//   /            → /app (beheer, login vereist)
//   /afspraak    → publieke boekingspagina
//   /api/...     → data (login vereist), /api/boeking/... publiek
//   /_blob/:id   → opgeladen bestanden (login vereist)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { sendMail, smtpConfig } = require('./smtp');
const { resendConfig, sendViaResend, testResend } = require('./resend');
const { twilioConfig, sendWhatsApp, testTwilio } = require('./twilio');
const { maakUBL } = require('./ubl');
const { STANDAARD_MAILS, vul } = require('./mails');
const { bouwFeed, nieuwToken } = require('./agenda');
const graph = require('./graph');

// Instellingen van koppelingen: eerst uit .env (admin-override), anders uit de database (ingevuld via de pagina Koppelingen).
const KOPPEL_VELDEN = {
  mail: { resendApiKey:'RESEND_API_KEY', resendFrom:'RESEND_FROM', smtpHost:'SMTP_HOST', smtpPort:'SMTP_PORT', smtpUser:'SMTP_USER', smtpPass:'SMTP_PASS', smtpFrom:'SMTP_FROM', adminEmail:'ADMIN_EMAIL' },
  whatsapp: { twilioSid:'TWILIO_ACCOUNT_SID', twilioToken:'TWILIO_AUTH_TOKEN', twilioFrom:'TWILIO_WHATSAPP_FROM' },
};
const ENVMAP = Object.assign({}, KOPPEL_VELDEN.mail, KOPPEL_VELDEN.whatsapp, KOPPEL_VELDEN.facturen);
const GEHEIM = new Set(['resendApiKey','smtpPass','twilioToken','efApiKey']);
function koppelDoc() { return store.get('instellingen', 'koppelingen') || {}; }
function viaEnv(field) { const v = process.env[ENVMAP[field]]; return v !== undefined && v !== ''; }
function kv(field) { if (viaEnv(field)) return process.env[ENVMAP[field]]; const d = koppelDoc(); return d[field] || ''; }
function effEnv() { const o = {}; for (const f in ENVMAP) o[ENVMAP[f]] = kv(f); return o; }
const vandaagBE = () => nuBrussel().slice(0, 10);
function plusDagen(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + (Number(n) || 0)); return d.toISOString().slice(0, 10); }
function verkoperDoc() { return store.get('instellingen', 'facturatie') || {}; }
function msDoc() { return store.get('instellingen', 'ms') || {}; }
function msVerbonden() { const mm = msDoc(); return !!(mm.clientId && mm.clientSecret && mm.refreshToken); }
function msRedirect(req) { return publicBase(req) + '/api/ms/callback'; }
async function msZet(klant) { if (!msVerbonden()) return; try { const dur = boekingConfig().duur || 60; const id = await graph.zetAfspraak(msDoc(), klant, dur); const nw = graph.nieuwRefreshToken(); const mm = msDoc(); if (nw) mm.refreshToken = nw; store.set('instellingen', 'ms', mm); const k = store.get('klanten', klant.id); if (k) { k.msEventId = id; store.set('klanten', klant.id, k); } } catch (e) { console.error('[ms]', e.message); } }
function verkoperKlaar() { const v = verkoperDoc(); return !!(v.btw && v.bedrijfsnaam); }

const mailActief = () => !!(resendConfig(effEnv()) || smtpConfig(effEnv()));
function verstuurMail(opts) {
  if (resendConfig(effEnv())) return sendViaResend(opts, resendConfig(effEnv()));
  if (smtpConfig(effEnv())) return sendMail(opts, smtpConfig(effEnv()));
  return Promise.resolve(false);
}
const { slotsVoorPeriode, boekingDefaults, nuBrussel } = require('./boeking');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const UPDATE_TOKEN = process.env.UPDATE_TOKEN || '';
const WATCHTOWER_URL = (process.env.WATCHTOWER_URL || 'http://watchtower:8080').replace(/\/$/, '');
const REPO = process.env.GITHUB_REPO || 'NickB-VTIZ/studio';

// Versie van deze build (version.json wordt in de Docker-image geschreven door GitHub Actions).
let VERSION = { version: 'dev', commit: '', builtAt: '' };
try { VERSION = Object.assign(VERSION, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'))); } catch (e) {}
const UPDATE_ENABLED = !!UPDATE_TOKEN;

// Nieuwste beschikbare versie opvragen bij GitHub (laatste release), met korte cache.
let latestCache = { at: 0, data: null };
function cmpVersie(a, b) { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; }
function nieuwsteVersie() {
  if (Date.now() - latestCache.at < 60000) return Promise.resolve(latestCache.data);
  return new Promise(resolve => {
    const req = https.get(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'justpixit-studio', 'Accept': 'application/vnd.github+json' }, timeout: 6000 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => {
        try { const tag = (JSON.parse(b).tag_name || '').replace(/^v/, ''); latestCache = { at: Date.now(), data: tag || null }; resolve(latestCache.data); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function triggerWatchtower() {
  return new Promise((resolve, reject) => {
    const u = new URL(WATCHTOWER_URL + '/v1/update');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'Authorization': 'Bearer ' + UPDATE_TOKEN }, timeout: 15000 }, r => {
      r.on('data', () => {}); r.on('end', () => r.statusCode < 400 ? resolve(true) : reject(new Error('watchtower ' + r.statusCode)));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Ontbrekende instellingen: niet crashen (dan toont Traefik enkel een 404), maar een duidelijke pagina tonen.
const SETUP_FOUTEN = [];
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) SETUP_FOUTEN.push('ADMIN_PASSWORD ontbreekt of is korter dan 8 tekens');
if (!SESSION_SECRET || SESSION_SECRET.length < 16) SETUP_FOUTEN.push('SESSION_SECRET ontbreekt of is korter dan 16 tekens');
if (SETUP_FOUTEN.length) console.error('[setup] ' + SETUP_FOUTEN.join('; ') + ' — vul .env in en herstart (./restart.sh)');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const store = new Store(DATA_DIR);
seedIfEmpty();

/* ---------- helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const text = (res, code, s, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(s); };
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('te groot')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 5 * 1024 * 1024) { const b = await readBody(req, limit); if (!b.length) return {}; return JSON.parse(b.toString('utf8')); }
function cookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return out; }
const sign = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('base64url');
function makeSession() { const exp = Date.now() + 30 * 864e5; const payload = `${exp}.${crypto.randomBytes(8).toString('hex')}`; return `${payload}.${sign(payload)}`; }
function validSession(token) {
  if (!token) return false; const i = token.lastIndexOf('.'); if (i < 0) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(payload.split('.')[0]) > Date.now();
}
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || !!req.socket.encrypted;
const authed = req => validSession(cookies(req).sid);
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

// Eenvoudige rate limiter voor login en boekingen (per IP, in geheugen).
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, arr] of hits) if (!arr.some(t => now - t < 36e5)) hits.delete(k); }, 6e5).unref();

function instellingen() { return store.get('instellingen', 'algemeen') || {}; }
function boekingConfig() { return Object.assign({}, boekingDefaults(), instellingen().boeking || {}); }
function publicBase(req) { return BASE_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`; }

/* ---------- static ---------- */
function serveFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return text(res, 404, 'Niet gevonden');
    const headers = Object.assign({ 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size }, extraHeaders);
    res.writeHead(200, headers); fs.createReadStream(file).pipe(res);
  });
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  // --- publiek ---
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (limited('login:' + ip, 10, 15 * 60e3)) return json(res, 429, { error: 'Te veel pogingen. Probeer over een kwartier opnieuw.' });
    const body = await readJson(req, 10e3).catch(() => ({}));
    if (!safeEq(body.wachtwoord || '', ADMIN_PASSWORD)) return json(res, 401, { error: 'Verkeerd wachtwoord' });
    res.setHeader('Set-Cookie', `sid=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${isHttps(req) ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/logout' && m === 'POST') { res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0'); return json(res, 200, { ok: true }); }

  if (p === '/api/boeking/slots' && m === 'GET') {
    const cfg = boekingConfig();
    if (!cfg.actief) return json(res, 200, { actief: false });
    const bezet = store.list('klanten').filter(k => k.kennismaking && k.fase !== 'geen_deal').map(k => k.kennismaking);
    const slots = slotsVoorPeriode(cfg, bezet);
    return json(res, 200, { actief: true, titel: cfg.titel, intro: cfg.intro, locatie: cfg.locatie, duur: cfg.duur, bevestiging: cfg.bevestiging, types: cfg.types, vragen: cfg.vragen, dagen: slots });
  }
  if (p === '/api/boeking' && m === 'POST') {
    const ip = clientIp(req);
    if (limited('boek:' + ip, 8, 60 * 60e3)) return json(res, 429, { error: 'Te veel aanvragen vanaf dit adres. Probeer later opnieuw.' });
    const cfg = boekingConfig();
    if (!cfg.actief) return json(res, 400, { error: 'Online boeken staat momenteel uit.' });
    const b = await readJson(req, 50e3).catch(() => null);
    if (!b) return json(res, 400, { error: 'Ongeldige aanvraag' });
    const naam = String(b.naam || '').trim().slice(0, 120), email = String(b.email || '').trim().slice(0, 160), telefoon = String(b.telefoon || '').trim().slice(0, 40);
    const slot = String(b.slot || ''), type = String(b.type || '').slice(0, 40), datumEvent = String(b.datumEvent || '').slice(0, 10), bericht = String(b.bericht || '').trim().slice(0, 2000);
    if (naam.length < 2) return json(res, 400, { error: 'Vul je naam in.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Vul een geldig e-mailadres in.' });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot)) return json(res, 400, { error: 'Kies een tijdstip.' });
    const bezet = store.list('klanten').filter(k => k.kennismaking && k.fase !== 'geen_deal').map(k => k.kennismaking);
    const vrij = slotsVoorPeriode(cfg, bezet).some(d => d.slots.includes(slot));
    if (!vrij) return json(res, 409, { error: 'Dit tijdstip is net ingenomen of niet meer beschikbaar. Kies een ander moment.' });
    const vandaag = nuBrussel().slice(0, 10);
    const slug = naam.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'klant';
    const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    const extra = Object.entries(b.antwoorden && typeof b.antwoorden === 'object' ? b.antwoorden : {}).map(([q, a]) => `${String(q).slice(0, 120)}: ${String(a).slice(0, 500)}`).join('\n');
    const notitie = [bericht, extra].filter(Boolean).join('\n\n');
    const doc = {
      naam, type: cfg.types.includes(type) ? type : (cfg.types[0] || ''), bron: 'Online afspraak', email, telefoon, locatie: '', gasten: '', budget: '',
      kennismaking: slot, datumEvent: /^\d{4}-\d{2}-\d{2}$/.test(datumEvent) ? datumEvent : '', deadline: '', ontwerpDatum: '',
      fase: 'ingepland', faseDatums: { ingepland: vandaag }, nieuw: true,
      fiche: { producten: {}, stijl: {}, uitnodiging: {}, bedankjes: {}, offerte: {}, extras: '', notities: notitie },
      logboek: [{ d: vandaag, t: 'Afspraak geboekt via de website' + (bericht ? ': ' + bericht : ''), s: 'afspraak', ts: new Date().toISOString() }],
      aangemaakt: new Date().toISOString(), bijgewerkt: new Date().toISOString(),
    };
    store.set('klanten', id, doc);
    msZet(Object.assign({ id }, doc));
    const when = `${slot.slice(8, 10)}/${slot.slice(5, 7)}/${slot.slice(0, 4)} om ${slot.slice(11, 16)}`;
    // Mails zijn best-effort.
    if (mailActief()) {
      const r2 = resendConfig(effEnv()), s2 = smtpConfig(effEnv());
      const admin = kv('adminEmail') || (r2 && r2.from) || (s2 && s2.from);
      const alg = instellingen(); const sjab = Object.assign({}, STANDAARD_MAILS, alg.mails || {});
      const voornaam = (naam.split(/\s|&/)[0] || '').trim();
      const basis = { voornaam, naam, wanneer: when, duur: cfg.duur, locatie: cfg.locatie, titel: cfg.titel, bevestiging: cfg.bevestiging, afzender: cfg.afzender || alg.afzender || 'justPIXIT', email, telefoon: telefoon || '-', type: doc.type || '-', datumEvent: doc.datumEvent || '-', bericht: notitie || '(geen bericht)', app: publicBase(req) + '/app' };
      verstuurMail({ to: admin, replyTo: email, subject: `Nieuwe afspraak: ${naam} – ${when}`, text: vul(sjab.boekingAdmin, basis) }).catch(e => console.error('[mail] admin:', e.message));
      verstuurMail({ to: email, subject: `Bevestiging: ${cfg.titel} op ${when}`, text: vul(sjab.boekingKlant, basis) }).catch(e => console.error('[mail] klant:', e.message));
    }
    return json(res, 200, { ok: true, slot, duur: cfg.duur, titel: cfg.titel, locatie: cfg.locatie, bevestiging: cfg.bevestiging, mail: mailActief() });
  }

  // --- vanaf hier: login vereist ---
  if (!authed(req)) return json(res, 401, { error: 'Niet aangemeld' });

  if (p === '/api/me') return json(res, 200, { ok: true, base: publicBase(req), mail: mailActief(), whatsapp: !!twilioConfig(effEnv()), facturen: verkoperKlaar(), office365: msVerbonden(), versie: VERSION.version });
  if (p === '/api/version' && m === 'GET') {
    const latest = await nieuwsteVersie();
    return json(res, 200, { running: VERSION, latest, repo: REPO, updateBeschikbaar: latest ? cmpVersie(latest, VERSION.version) > 0 : false, updateEnabled: UPDATE_ENABLED });
  }
  if (p === '/api/update' && m === 'POST') {
    if (!UPDATE_ENABLED) return json(res, 400, { error: 'Automatisch updaten is niet ingesteld (UPDATE_TOKEN ontbreekt in .env).' });
    // Fire-and-forget: Watchtower haalt de nieuwe image en herstart deze container. Dit proces stopt dan mee.
    triggerWatchtower().catch(e => console.error('[update]', e.message));
    return json(res, 200, { started: true });
  }
  if (p === '/api/whatsapp' && m === 'POST') {
    if (!twilioConfig(effEnv())) return json(res, 400, { error: 'WhatsApp is niet ingesteld. Vul de Twilio-gegevens in bij Koppelingen.' });
    const b = await readJson(req, 20e3).catch(() => ({}));
    const klant = store.get('klanten', String(b.klantId || ''));
    if (!klant) return json(res, 404, { error: 'Klant niet gevonden' });
    if (!klant.telefoon) return json(res, 400, { error: 'Deze klant heeft geen telefoonnummer.' });
    const tekst = String(b.tekst || '').trim();
    if (!tekst) return json(res, 400, { error: 'Leeg bericht' });
    try {
      const r = await sendWhatsApp({ to: klant.telefoon, body: tekst }, twilioConfig(effEnv()));
      const t = vandaagBE();
      klant.logboek = (klant.logboek || []).concat([{ d: t, t: 'WhatsApp verstuurd: ' + tekst.slice(0, 200), s: 'telefoon', ts: new Date().toISOString() }]);
      store.set('klanten', klant.id, klant);
      return json(res, 200, { ok: true, status: r.status });
    } catch (e) { return json(res, 502, { error: 'Versturen mislukt: ' + e.message }); }
  }
  const facMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/factuur-ubl$/);
  if (facMatch && m === 'POST') {
    const v = verkoperDoc();
    if (!verkoperKlaar()) return json(res, 400, { error: 'Vul eerst je facturatiegegevens in (minstens bedrijfsnaam en BTW-nummer) bij Koppelingen.' });
    const klant = store.get('klanten', facMatch[1]);
    if (!klant) return json(res, 404, { error: 'Klant niet gevonden' });
    const b = await readJson(req, 10e3).catch(() => ({}));
    const offerte = (klant.offertes || []).find(o => o.id === String(b.offerteId || ''));
    if (!offerte) return json(res, 400, { error: 'Offerte niet gevonden' });
    try {
      const prefix = v.prefix || (new Date().getFullYear() + '-');
      const n = Number(v.volgnummer) || 1;
      const nummer = prefix + String(n).padStart(3, '0');
      const datum = vandaagBE();
      const verval = plusDagen(datum, Number(v.betaaltermijn) || 30);
      const verkoper = { naam: v.bedrijfsnaam, straat: v.straat, postcode: v.postcode, stad: v.stad, land: v.land || 'BE', btw: v.btw, iban: v.iban, email: v.email };
      const xml = maakUBL(verkoper, klant, offerte, nummer, { datum, vervaldatum: verval });
      v.volgnummer = n + 1; store.set('instellingen', 'facturatie', v);
      offerte.factuur = { nummer, op: datum, ubl: true };
      klant.id = facMatch[1]; const { id, ...rest } = klant; store.set('klanten', facMatch[1], rest);
      return json(res, 200, { ok: true, nummer, filename: ('factuur-' + nummer + '.xml').replace(/[^A-Za-z0-9.\-]/g, '_'), xml });
    } catch (e) { return json(res, 500, { error: 'E-factuur maken mislukt: ' + e.message }); }
  }
  if (p === '/api/ms' && m === 'GET') { const mm = msDoc(); return json(res, 200, { verbonden: msVerbonden(), account: mm.account || '', clientIdSet: !!mm.clientId, secretSet: !!mm.clientSecret, tenant: mm.tenant || 'common', redirect: msRedirect(req) }); }
  if (p === '/api/ms' && m === 'POST') { const b = await readJson(req, 10e3).catch(() => ({})); const mm = msDoc(); if ('clientId' in b) mm.clientId = String(b.clientId || '').trim(); if ('tenant' in b) mm.tenant = String(b.tenant || '').trim() || 'common'; if (b.clientSecret) mm.clientSecret = String(b.clientSecret).trim(); store.set('instellingen', 'ms', mm); return json(res, 200, { ok: true }); }
  if (p === '/api/ms/ontkoppel' && m === 'POST') { store.set('instellingen', 'ms', {}); return json(res, 200, { ok: true }); }
  if (p === '/api/ms/connect' && m === 'GET') {
    const mm = msDoc(); if (!mm.clientId || !mm.clientSecret) return text(res, 400, 'Vul eerst Client-ID en Client-secret in bij Koppelingen.');
    const st = Date.now() + '.' + crypto.randomBytes(6).toString('hex');
    res.setHeader('Set-Cookie', `msstate=${st}.${sign('ms:' + st)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isHttps(req) ? '; Secure' : ''}`);
    res.writeHead(302, { Location: graph.authUrl(mm, msRedirect(req), st) }); return res.end();
  }
  if (p === '/api/ms/callback' && m === 'GET') {
    const code = url.searchParams.get('code'); const st = url.searchParams.get('state');
    const ck = cookies(req).msstate || ''; const ci = ck.lastIndexOf('.'); const okState = ci > 0 && ck.slice(0, ci) === st && ck.slice(ci + 1) === sign('ms:' + st);
    if (!code || !okState) return text(res, 400, 'Koppeling afgebroken of verlopen. Probeer opnieuw.');
    try { const mm = msDoc(); const tok = await graph.exchangeCode(mm, code, msRedirect(req)); mm.refreshToken = tok.refresh_token; try { mm.account = await graph.wieBenIk(tok.access_token); } catch (e) {} store.set('instellingen', 'ms', mm); res.writeHead(302, { Location: '/app' }); return res.end(); }
    catch (e) { return text(res, 502, 'Verbinden mislukt: ' + e.message); }
  }
  if (p === '/api/ms/sync' && m === 'POST') {
    if (!msVerbonden()) return json(res, 400, { error: 'Office 365 is niet verbonden.' });
    const vd = vandaagBE(); let n = 0, fouten = 0;
    for (const k of store.list('klanten')) {
      if (k.fase === 'geen_deal' || !k.kennismaking || k.kennismaking.slice(0, 10) < vd) continue;
      try { const id = await graph.zetAfspraak(msDoc(), k, boekingConfig().duur || 60); const kk = store.get('klanten', k.id); if (kk) { kk.msEventId = id; store.set('klanten', k.id, kk); } n++; } catch (e) { fouten++; }
    }
    const nw = graph.nieuwRefreshToken(); if (nw) { const m2 = msDoc(); m2.refreshToken = nw; store.set('instellingen', 'ms', m2); }
    return json(res, 200, { ok: true, aantal: n, fouten });
  }
  if (p === '/api/facturatie' && m === 'GET') return json(res, 200, { verkoper: verkoperDoc(), klaar: verkoperKlaar() });
  if (p === '/api/agenda' && m === 'GET') {
    const a = store.get('instellingen', 'agenda') || {};
    if (!a.token) { a.token = nieuwToken(); store.set('instellingen', 'agenda', a); }
    return json(res, 200, { url: publicBase(req) + '/cal/' + a.token + '.ics' });
  }
  if (p === '/api/agenda/nieuw' && m === 'POST') {
    store.set('instellingen', 'agenda', { token: nieuwToken() });
    const a = store.get('instellingen', 'agenda');
    return json(res, 200, { url: publicBase(req) + '/cal/' + a.token + '.ics' });
  }
  if (p === '/api/facturatie' && m === 'POST') {
    const b = await readJson(req, 20e3).catch(() => ({}));
    const v = verkoperDoc();
    for (const f of ['bedrijfsnaam', 'straat', 'postcode', 'stad', 'land', 'btw', 'iban', 'email', 'prefix', 'betaaltermijn']) if (f in b) v[f] = String(b[f] ?? '').trim();
    if ('volgnummer' in b) { const nn = parseInt(b.volgnummer, 10); if (Number.isFinite(nn) && nn > 0) v.volgnummer = nn; }
    store.set('instellingen', 'facturatie', v);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/koppelingen' && m === 'GET') {
    const velden = {};
    for (const f in ENVMAP) {
      const env = viaEnv(f); const waarde = kv(f); const geheim = GEHEIM.has(f);
      velden[f] = { viaEnv: env, secret: geheim, set: !!waarde, value: geheim ? '' : waarde, hint: geheim && waarde ? '••••••' + waarde.slice(-4) : '' };
    }
    const groepActief = { mail: mailActief(), whatsapp: !!twilioConfig(effEnv()), facturen: verkoperKlaar() };
    return json(res, 200, { velden, groepen: groepActief });
  }
  if (p === '/api/koppelingen' && m === 'POST') {
    const b = await readJson(req, 50e3).catch(() => ({}));
    const d = koppelDoc();
    if (Array.isArray(b.wis)) for (const g of b.wis) for (const f in (KOPPEL_VELDEN[g] || {})) delete d[f];
    const data = b.data && typeof b.data === 'object' ? b.data : {};
    for (const f in data) {
      if (!(f in ENVMAP) || viaEnv(f)) continue;            // onbekend of vergrendeld via .env → overslaan
      const v = String(data[f] ?? '').trim();
      if (GEHEIM.has(f) && v === '') continue;              // leeg geheim veld = behouden
      if (v === '') delete d[f]; else d[f] = v;
    }
    store.set('instellingen', 'koppelingen', d);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/koppelingen/test' && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    try {
      if (b.groep === 'mail') {
        if (resendConfig(effEnv())) { await testResend(resendConfig(effEnv())); return json(res, 200, { ok: true, detail: 'Resend-sleutel werkt.' }); }
        if (smtpConfig(effEnv())) return json(res, 200, { ok: true, detail: 'SMTP is ingesteld (geen testbericht verstuurd).' });
        return json(res, 400, { error: 'Nog geen e-mail ingesteld.' });
      }
      if (b.groep === 'whatsapp') { await testTwilio(twilioConfig(effEnv())); return json(res, 200, { ok: true, detail: 'Twilio-verbinding werkt.' }); }
      if (b.groep === 'facturen') { return verkoperKlaar() ? json(res, 200, { ok: true, detail: 'Facturatiegegevens zijn ingevuld. Je kan e-facturen (UBL) maken.' }) : json(res, 400, { error: 'Vul minstens bedrijfsnaam en BTW-nummer in.' }); }
      return json(res, 400, { error: 'Onbekende koppeling' });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (p === '/api/data' && m === 'GET') {
    const klanten = {}; for (const k of store.list('klanten')) { const { id, ...rest } = k; klanten[id] = rest; }
    const instellingen = {}; const algD = store.get('instellingen', 'algemeen'); if (algD) instellingen.algemeen = algD; // enkel 'algemeen'; geheimen blijven server-side
    return json(res, 200, { klanten, instellingen });
  }
  const docMatch = p.match(/^\/api\/doc\/(klanten|instellingen)\/([A-Za-z0-9_\-.~:@+]{1,200})$/);
  if (docMatch) {
    const [, col, id] = docMatch;
    if (m === 'PUT') { const body = await readJson(req).catch(() => null); if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Ongeldig document' }); store.set(col, id, body); return json(res, 200, { ok: true }); }
    if (m === 'DELETE') { store.delete(col, id); return json(res, 200, { ok: true }); }
    if (m === 'GET') { const d = store.get(col, id); return d ? json(res, 200, d) : json(res, 404, { error: 'Niet gevonden' }); }
  }
  if (p === '/api/upload' && m === 'POST') {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    const allowed = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
    if (!allowed[type]) return json(res, 415, { error: 'Enkel PDF, PNG, JPG of WebP' });
    let buf; try { buf = await readBody(req, 25 * 1024 * 1024); } catch (e) { return json(res, 413, { error: 'Bestand te groot (max 25 MB)' }); }
    if (!buf.length) return json(res, 400, { error: 'Leeg bestand' });
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(UPLOAD_DIR, id + allowed[type]), buf);
    const naam = decodeURIComponent(req.headers['x-filename'] || '').slice(0, 200);
    fs.writeFileSync(path.join(UPLOAD_DIR, id + '.json'), JSON.stringify({ naam, type, size: buf.length, d: new Date().toISOString() }));
    return json(res, 200, { id, url: '/_blob/' + id, sizeBytes: buf.length, contentType: type });
  }
  const upMatch = p.match(/^\/api\/upload\/([a-f0-9]{32})$/);
  if (upMatch && m === 'DELETE') {
    for (const f of fs.readdirSync(UPLOAD_DIR)) if (f.startsWith(upMatch[1])) fs.unlinkSync(path.join(UPLOAD_DIR, f));
    return json(res, 200, { deleted: true });
  }
  return json(res, 404, { error: 'Onbekende route' });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/gezond' || p === '/health') return text(res, 200, 'ok');
    const calM = p.match(/^\/cal\/([a-f0-9]{16,64})\.ics$/);
    if (calM) {
      const a = store.get('instellingen', 'agenda') || {};
      if (!a.token || a.token !== calM[1]) return text(res, 404, 'Niet gevonden');
      const duur = (boekingConfig().duur) || 60;
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="justpixit.ics"' });
      return res.end(bouwFeed(store.list('klanten'), duur));
    }
    if (SETUP_FOUTEN.length) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!doctype html><html lang="nl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>justPIXIT Studio – instellen</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 20px;color:#1E2824;line-height:1.5"><h1 style="font-weight:600">Nog even instellen</h1>
<p>De app draait, maar het bestand <code>.env</code> is niet volledig:</p><ul>${SETUP_FOUTEN.map(f => '<li>' + f + '</li>').join('')}</ul>
<p>Op de server, in de map van de app:</p><pre style="background:#EEF1EC;padding:12px;border-radius:8px;overflow:auto">cp .env.example .env
nano .env        # ADMIN_PASSWORD en SESSION_SECRET invullen
./restart.sh</pre><p>Een goede SESSION_SECRET maak je met <code>openssl rand -hex 32</code>.</p></body></html>`);
    }
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p === '/') { res.writeHead(302, { Location: '/app' }); return res.end(); }
    if (p === '/app' || p === '/app/') return serveFile(res, path.join(PUBLIC_DIR, 'app.html'), { 'Cache-Control': 'no-store' });
    if (p === '/afspraak' || p === '/afspraak/' || p === '/boek') return serveFile(res, path.join(PUBLIC_DIR, 'afspraak.html'), { 'Cache-Control': 'no-store' });
    const blob = p.match(/^\/_blob\/([a-f0-9]{32})$/);
    if (blob) {
      if (!authed(req)) return text(res, 401, 'Niet aangemeld');
      const f = fs.readdirSync(UPLOAD_DIR).find(x => x.startsWith(blob[1]) && !x.endsWith('.json'));
      if (!f) return text(res, 404, 'Niet gevonden');
      return serveFile(res, path.join(UPLOAD_DIR, f), { 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline' });
    }
    // overige statische bestanden uit public/
    const safe = path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, { 'Cache-Control': 'public, max-age=3600' });
    return text(res, 404, 'Niet gevonden');
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'Serverfout' });
  }
});

server.listen(PORT, () => console.log(`justPIXIT Studio draait op poort ${PORT} · data in ${DATA_DIR}${smtpConfig() ? ' · mail aan' : ' · mail uit (geen SMTP_HOST)'}`));
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });

/* ---------- voorbeelddata bij eerste start ---------- */
function seedIfEmpty() {
  if (store.list('klanten').length || store.getMeta('geseed')) return;
  const t = nuBrussel().slice(0, 10);
  const add = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const a = n => add(t, n);
  const base = () => ({ email: '', telefoon: '', gasten: '', budget: '', ontwerpDatum: '', voorbeeld: true, fiche: { producten: {}, stijl: {}, uitnodiging: {}, bedankjes: {}, offerte: {}, extras: '', notities: '' }, aangemaakt: new Date().toISOString(), bijgewerkt: new Date().toISOString() });
  const vb = {
    'vb-lotte-bram': Object.assign(base(), { naam: 'Voorbeeld · Lotte & Bram', type: 'Huwelijk', bron: 'Online afspraak', locatie: 'Gent', kennismaking: a(5) + 'T19:00', datumEvent: a(250), deadline: a(150), fase: 'ingepland', faseDatums: { ingepland: a(-2) }, logboek: [{ d: a(-2), t: 'Afspraak geboekt via de website', s: 'afspraak' }] }),
    'vb-emma-jules': Object.assign(base(), { naam: 'Voorbeeld · Emma & Jules', type: 'Huwelijk', bron: 'Instagram', locatie: 'Brugge', kennismaking: a(-9) + 'T20:00', datumEvent: a(220), deadline: a(140), fase: 'gehad', faseDatums: { ingepland: a(-20), gehad: a(-9) }, logboek: [{ d: a(-9), t: 'Fase → Kennismaking gehad', s: 'fase' }] }),
    'vb-baby-noor': Object.assign(base(), { naam: 'Voorbeeld · Baby Noor', type: 'Geboorte', bron: 'Via via', locatie: '', kennismaking: a(-34) + 'T10:00', datumEvent: a(60), deadline: a(50), fase: 'offerte', faseDatums: { ingepland: a(-42), gehad: a(-34), offerte: a(-17) }, offertes: [{ id: 'vbof1', titel: 'Offerte', status: 'Verstuurd', datum: a(-17), geldigTot: '', btw: '21', korting: '', notitie: '', bestanden: [], regels: [{ oms: 'Geboortekaartje enkel, wild white', aantal: '120', prijs: '1,85' }, { oms: 'Ontwerp', aantal: '1', prijs: '150' }] }], logboek: [{ d: a(-17), t: 'Fase → Offerte verstuurd', s: 'fase' }] }),
    'vb-sarah-tom': Object.assign(base(), { naam: 'Voorbeeld · Sarah & Tom', type: 'Huwelijk', bron: 'Website', locatie: 'Antwerpen', kennismaking: a(-120) + 'T19:00', datumEvent: a(200), deadline: a(100), ontwerpDatum: a(-16), fase: 'ontwerp_bezig', faseDatums: { ingepland: a(-130), gehad: a(-120), offerte: a(-110), goedgekeurd: a(-90), ontwerp_gepland: a(-70), ontwerp_bezig: a(-16) }, logboek: [{ d: a(-16), t: 'Fase → Ontwerp in progress', s: 'fase' }] }),
  };
  for (const [id, d] of Object.entries(vb)) store.set('klanten', id, d);
  store.setMeta('geseed', '1');
  console.log('[seed] voorbeeldklanten toegevoegd');
}
