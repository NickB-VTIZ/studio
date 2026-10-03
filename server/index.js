// justPIXIT Studio – server. Enkel Node.js (geen externe pakketten).
// Routes:
//   /            → /app (beheer, login vereist)
//   /afspraak    → publieke boekingspagina
//   /api/...     → data (login vereist), /api/boeking/... publiek
//   /_blob/:id   → opgeladen bestanden (login vereist)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { sendMail, smtpConfig } = require('./smtp');
const { slotsVoorPeriode, boekingDefaults, nuBrussel } = require('./boeking');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) { console.error('Zet ADMIN_PASSWORD (minstens 8 tekens) in .env'); process.exit(1); }
if (!SESSION_SECRET || SESSION_SECRET.length < 16) { console.error('Zet SESSION_SECRET (een lange willekeurige tekst) in .env'); process.exit(1); }

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
    const when = `${slot.slice(8, 10)}/${slot.slice(5, 7)}/${slot.slice(0, 4)} om ${slot.slice(11, 16)}`;
    // Mails zijn best-effort.
    if (smtpConfig()) {
      const admin = ADMIN_EMAIL || smtpConfig().from;
      sendMail({ to: admin, replyTo: email, subject: `Nieuwe afspraak: ${naam} – ${when}`, text: `${naam} boekte een ${cfg.titel.toLowerCase()} op ${when}.\n\nE-mail: ${email}\nTelefoon: ${telefoon || '-'}\nType: ${doc.type}\nDatum event: ${doc.datumEvent || '-'}\n\n${notitie || '(geen bericht)'}\n\nOpen de fiche: ${publicBase(req)}/app` }).catch(e => console.error('[mail] admin:', e.message));
      sendMail({ to: email, subject: `Bevestiging: ${cfg.titel} op ${when}`, text: `Hoi ${naam.split(/\s|&/)[0]},\n\n${cfg.bevestiging}\n\nWanneer: ${when} (${cfg.duur} min)\nWaar: ${cfg.locatie}\n\nTot dan!\n${cfg.afzender || 'justPIXIT'}` }).catch(e => console.error('[mail] klant:', e.message));
    }
    return json(res, 200, { ok: true, slot, duur: cfg.duur, titel: cfg.titel, locatie: cfg.locatie, bevestiging: cfg.bevestiging, mail: !!smtpConfig() });
  }

  // --- vanaf hier: login vereist ---
  if (!authed(req)) return json(res, 401, { error: 'Niet aangemeld' });

  if (p === '/api/me') return json(res, 200, { ok: true, base: publicBase(req), mail: !!smtpConfig() });
  if (p === '/api/data' && m === 'GET') {
    const klanten = {}; for (const k of store.list('klanten')) { const { id, ...rest } = k; klanten[id] = rest; }
    return json(res, 200, { klanten, instellingen: store.data.instellingen || {} });
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
    if (p.startsWith('/api/')) return await api(req, res, url);
    if (p === '/') { res.writeHead(302, { Location: '/app' }); return res.end(); }
    if (p === '/app' || p === '/app/') return serveFile(res, path.join(PUBLIC_DIR, 'app.html'), { 'Cache-Control': 'no-store' });
    if (p === '/afspraak' || p === '/afspraak/' || p === '/boek') return serveFile(res, path.join(PUBLIC_DIR, 'afspraak.html'), { 'Cache-Control': 'no-store' });
    if (p === '/gezond' || p === '/health') return text(res, 200, 'ok');
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
  if (store.list('klanten').length || store.data.meta.geseed) return;
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
  for (const [id, d] of Object.entries(vb)) store.data.klanten[id] = d;
  store.data.meta.geseed = true;
  store.save();
  console.log('[seed] voorbeeldklanten toegevoegd');
}
