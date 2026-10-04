// justPIXIT Studio – server. Enkel Node.js (geen externe pakketten).
// Routes:
//   /  en /mijn  → klantenportaal: login voor bestaande klanten (geen menu); /app → beheer (login vereist)
//   /afspraak    → publieke boekingspagina
//   /dossier?c=…  → klantflow met persoonlijke code, zonder login: afspraak verzetten/annuleren, offerte goed-/afkeuren, vragenlijst, contract
//   /api/...     → data (login vereist), /api/boeking/... publiek, /api/portaal/... klantsessie
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
const { STANDAARD_MAILS, vul, bouwMail } = require('./mails');
const { fasenVoor, FASES, FI: FI_SERVER, GESTOPT } = require('./fases');
const { BEHEER_MODULES, BEHEER_TABS, PORTAAL_MODULES, ALLE_MODULES, MODULE_IDS,
  MODULE_GROEPEN, GROEP_IDS, groepNaarTabs, TAB_MAP } = require('./modules');
const { bouwFeed, nieuwToken } = require('./agenda');
const graph = require('./graph');
const zoom = require('./zoom');

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
function zoomDoc() { return store.get('instellingen', 'zoom') || {}; }
function zoomActief() { return !!zoom.zoomConfig(zoomDoc()); }
function videoBeschikbaar() { const c = boekingConfig(); const out = []; if (c.videoTeams && msVerbonden()) out.push({ id: 'teams', label: 'Microsoft Teams' }); if (c.videoZoom && zoomActief()) out.push({ id: 'zoom', label: 'Zoom' }); return out; }
async function msZet(klant) { if (!msVerbonden()) return; try { const dur = boekingConfig().duur || 60; const id = (await graph.zetAfspraak(msDoc(), klant, dur)).id; const nw = graph.nieuwRefreshToken(); const mm = msDoc(); if (nw) mm.refreshToken = nw; store.set('instellingen', 'ms', mm); const k = store.get('klanten', klant.id); if (k) { k.msEventId = id; store.set('klanten', klant.id, k); } } catch (e) { console.error('[ms]', e.message); } }
function verkoperKlaar() { const v = verkoperDoc(); return !!(v.btw && v.bedrijfsnaam); }

const mailActief = () => !!(resendConfig(effEnv()) || smtpConfig(effEnv()));
function logMail(e) {
  const d = store.get('instellingen', 'maillog') || { items: [] };
  d.items = (d.items || []); d.items.unshift(Object.assign({ ts: new Date().toISOString() }, e));
  if (d.items.length > 100) d.items.length = 100;
  store.set('instellingen', 'maillog', d);
}
// Stuurt een mail en logt altijd het resultaat. Geeft {ok,error} terug (gooit niet).
async function verstuurMail(opts, meta = {}) {
  const r = resendConfig(effEnv()), sm = smtpConfig(effEnv());
  let ok = false, fout = '', via = '';
  try {
    if (r) { via = 'Resend'; await sendViaResend(opts, r); ok = true; }
    else if (sm) { via = 'SMTP'; await sendMail(opts, sm); ok = true; }
    else throw new Error('Geen e-mailkoppeling ingesteld (vul Resend in bij Koppelingen).');
  } catch (e) { fout = e.message || String(e); }
  logMail({ to: opts.to, subject: opts.subject, soort: meta.soort || '', via, status: ok ? 'ok' : 'fout', fout });
  if (!ok) console.error('[mail]', meta.soort || '', fout);
  return { ok, error: fout };
}
const { slotsVoorPeriode, boekingDefaults, nuBrussel } = require('./boeking');

const fmtWanneer = slot => `${slot.slice(8, 10)}/${slot.slice(5, 7)}/${slot.slice(0, 4)} om ${slot.slice(11, 16)}`;
const bezetteSlots = (behalveId) => store.list('klanten').filter(k => k.kennismaking && !GESTOPT.has(k.fase) && k.id !== behalveId).map(k => k.kennismaking);
const portaalUrl = req => publicBase(req) + '/mijn';
function adminAdres() { const r2 = resendConfig(effEnv()), s2 = smtpConfig(effEnv()); return kv('adminEmail') || (r2 && r2.from) || (s2 && s2.from) || ''; }
function mailBasis(doc, req, extra = {}) {
  const alg = instellingen(), cfg = boekingConfig();
  const voornaam = (String(doc.naam || '').split(/\s|&/)[0] || '').trim();
  return Object.assign({ voornaam, naam: doc.naam, duur: cfg.duur, locatie: doc.videoprovider || cfg.locatie, titel: cfg.titel, bevestiging: cfg.bevestiging,
    afzender: cfg.afzender || alg.afzender || 'justPIXIT', email: doc.email || '-', telefoon: doc.telefoon || '-', type: doc.type || '-', datumEvent: doc.datumEvent || '-',
    wanneer: doc.kennismaking ? fmtWanneer(doc.kennismaking) : '-', app: publicBase(req) + '/app', videoprovider: doc.videoprovider || '' }, extra);
}
const videoKnop = doc => doc.videolink ? { url: doc.videolink, label: 'Deelnemen aan ' + (doc.videoprovider || 'videocall') } : null;
function sjablonen() { return Object.assign({}, STANDAARD_MAILS, instellingen().mails || {}); }

// Unieke wijzigcode per boeking: nieuwe leads verzetten hun afspraak via /afspraak/wijzig?c=… zonder login.
function zorgWijzigCode(id) { const k = store.get('klanten', id); if (!k) return ''; if (!k.wijzigCode) { k.wijzigCode = crypto.randomBytes(9).toString('base64url'); store.set('klanten', id, k); } return k.wijzigCode; }
const wijzigUrl = (req, code) => publicBase(req) + '/dossier?c=' + encodeURIComponent(code); // verzetlink = dossierlink
const wijzigKnop = (req, doc) => doc.wijzigCode ? { url: wijzigUrl(req, doc.wijzigCode), label: 'Afspraak verplaatsen' } : null;
function klantViaWijzigCode(code) { if (!code || code.length < 8) return null; return store.list('klanten').find(k => k.wijzigCode && safeEq(k.wijzigCode, code)) || null; }

// Offertetotalen (zelfde rekenwijze als in de app: "1,85" → 1.85).
const num = v => { const n = parseFloat(String(v ?? '').replace(/\s|€/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
function offerteTotalen(o) { const sub = (o.regels || []).reduce((a, r) => a + num(r.aantal) * num(r.prijs), 0); const kort = num(o.korting); const basis = Math.max(0, sub - kort); const btw = basis * num(o.btw) / 100; return { sub, kort, basis, btw, tot: basis + btw }; }
const euro = n => (Number(n) || 0).toLocaleString('nl-BE', { style: 'currency', currency: 'EUR' });

// Agenda (Outlook/Teams) en Zoom laten volgen na een gewijzigd tijdstip. Gooit niet; geeft een lijst problemen terug.
async function syncAgenda(id) {
  const doc = store.get('klanten', id); const problemen = [];
  if (!doc || !doc.kennismaking || GESTOPT.has(doc.fase)) return problemen;
  const duur = boekingConfig().duur || 60;
  if (msVerbonden()) {
    try { const r = await graph.zetAfspraak(msDoc(), Object.assign({}, doc, { id }), duur, { teams: doc.videoprovider === 'Teams' }); const nw = graph.nieuwRefreshToken(); if (nw) { const mm = msDoc(); mm.refreshToken = nw; store.set('instellingen', 'ms', mm); } if (r.id && r.id !== doc.msEventId) { const k = store.get('klanten', id); if (k) { k.msEventId = r.id; store.set('klanten', id, k); } } }
    catch (e) { problemen.push('Outlook-agenda bijwerken mislukt: ' + e.message); }
  }
  if (doc.videoprovider === 'Zoom' && zoomActief()) {
    if (doc.zoomMeetingId) { try { await zoom.wijzigMeeting(zoomDoc(), doc.zoomMeetingId, { start: doc.kennismaking, duur }); } catch (e) { problemen.push('Zoom-meeting verplaatsen mislukt: ' + e.message); } }
    else problemen.push('Zoom-meeting kon niet automatisch verplaatst worden (geen meeting-id); pas ze aan in Zoom.');
  }
  return problemen;
}

// Verplaatst de kennismaking van een klant: controleert het slot, werkt Outlook/Teams en Zoom bij, logt en mailt.
// door: 'klant' of 'jou'. opts.vrijKiezen = admin mag buiten de boekingsblokken (enkel botsingen worden geweigerd).
async function verplaatsAfspraak(id, slot, door, req, opts = {}) {
  const doc = store.get('klanten', id);
  if (!doc) throw Object.assign(new Error('Klant niet gevonden'), { status: 404 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot)) throw Object.assign(new Error('Kies een geldig tijdstip.'), { status: 400 });
  if (GESTOPT.has(doc.fase)) throw Object.assign(new Error('Dit traject is gestopt; de afspraak kan niet verplaatst worden.'), { status: 400 });
  if (slot === doc.kennismaking) throw Object.assign(new Error('Dat is al het huidige moment.'), { status: 400 });
  const cfg = boekingConfig(), duur = cfg.duur || 60;
  const bezet = bezetteSlots(id);
  if (opts.vrijKiezen) {
    if (slot < nuBrussel()) throw Object.assign(new Error('Dat moment ligt in het verleden.'), { status: 400 });
    const a = Date.parse(slot + ':00Z'), span = (duur + (cfg.buffer || 0)) * 60e3;
    if (bezet.some(b => { const x = Date.parse(b.slice(0, 16) + ':00Z'); return a < x + span && x < a + span; })) throw Object.assign(new Error('Op dat moment staat al een ander gesprek.'), { status: 409 });
  } else if (!slotsVoorPeriode(cfg, bezet).some(d => d.slots.includes(slot))) {
    throw Object.assign(new Error('Dit tijdstip is niet (meer) beschikbaar. Kies een ander moment.'), { status: 409 });
  }
  const vorig = doc.kennismaking || '', vandaag = vandaagBE(), ts = new Date().toISOString();
  doc.kennismaking = slot; doc.bijgewerkt = ts;
  doc.logboek = (doc.logboek || []).concat([{ d: vandaag, t: `Afspraak verplaatst door ${door}: ${vorig ? fmtWanneer(vorig) : '—'} → ${fmtWanneer(slot)}`, s: 'afspraak', ts }]);
  if (!doc.wijzigCode) doc.wijzigCode = crypto.randomBytes(9).toString('base64url');
  store.set('klanten', id, doc);
  const problemen = await syncAgenda(id);
  if (problemen.length) { const k2 = store.get('klanten', id); for (const p of problemen) k2.logboek.push({ d: vandaag, t: p, s: 'afspraak', ts }); store.set('klanten', id, k2); }
  // Mails (best-effort)
  let gemaild = false;
  if (mailActief() && opts.mail !== false) {
    const sjab = sjablonen(); const admin = adminAdres();
    const basis = mailBasis(doc, req, { vorig: vorig ? fmtWanneer(vorig) : '—', door: door === 'klant' ? 'de klant' : 'jou' });
    const knoppen = { videolink: videoKnop(doc), wijziglink: wijzigKnop(req, doc) };
    if (doc.email) { const k = bouwMail(sjab.verplaatstKlant, basis, knoppen, ['wijziglink']); verstuurMail({ to: doc.email, subject: `Afspraak verplaatst: ${cfg.titel} op ${fmtWanneer(slot)}`, text: k.text, html: k.html }, { soort: 'afspraak verplaatst (klant)' }); gemaild = true; }
    if (admin && door === 'klant') { const a = bouwMail(sjab.verplaatstAdmin, basis, { videolink: videoKnop(doc) }, ['videolink']); verstuurMail({ to: admin, replyTo: doc.email || undefined, subject: `Afspraak verplaatst: ${doc.naam} – ${fmtWanneer(slot)}`, text: a.text, html: a.html }, { soort: 'afspraak verplaatst (melding)' }); }
  }
  return { ok: true, slot, vorig, problemen, gemaild };
}

// Geeft een fiche toegang tot het portaal: maakt (indien nodig) een klant-gebruiker en een uitnodigingslink
// om een wachtwoord in te stellen. Geeft {link, gemaild, bestond, email}.
async function geefPortaaltoegang(id, req, { mail = true } = {}) {
  const doc = store.get('klanten', id); if (!doc) throw Object.assign(new Error('Klant niet gevonden'), { status: 404 });
  if (!doc.email) throw Object.assign(new Error('Deze klant heeft geen e-mailadres op de fiche.'), { status: 400 });
  let u = gebruikerViaKlant(id) || gebruikerViaEmail(doc.email);
  const bestond = !!u;
  if (u && u.role !== 'klant') throw Object.assign(new Error('Dit e-mailadres hoort al bij een ander account.'), { status: 409 });
  if (!u) { const vn = (String(doc.naam || '').replace(/^Voorbeeld\s*·\s*/, '').split(/\s|&/)[0] || '').trim(); const uid = maakGebruiker(doc.email, 'klant', id, { voornaam: vn, naam: doc.naam || '' }); u = store.get('gebruikers', uid); u.id = uid; }
  else if (u.klantId !== id) { u.klantId = id; store.set('gebruikers', u.id, u); }
  const uid = u.id;
  const token = maakInvite(uid, mail ? 72 : 24 * 7); // gekopieerde link: een week geldig
  const link = publicBase(req) + '/wachtwoord?t=' + encodeURIComponent(token);
  let gemaild = false;
  if (mail) {
    if (!mailActief()) throw Object.assign(new Error('E-mail is niet ingesteld (zie Koppelingen).'), { status: 400 });
    const m = bouwMail(sjablonen().portaalLogin, mailBasis(doc, req), { loginlink: { url: link, label: 'Stel mijn wachtwoord in' } });
    const r = await verstuurMail({ to: doc.email, subject: 'Toegang tot jullie pagina bij justPIXIT', text: m.text, html: m.html }, { soort: 'portaaltoegang' });
    if (!r.ok) throw Object.assign(new Error('Mail versturen mislukt: ' + r.error), { status: 502 });
    gemaild = true;
  }
  return { link, gemaild, bestond, email: doc.email };
}

// Dossierlink: dezelfde persoonlijke code als de verzetlink, maar voor de hele klantflow zonder login
// (afspraak verzetten/annuleren, offerte goedkeuren of afkeuren, vragenlijst, contract).
const dossierUrl = (req, code) => publicBase(req) + '/dossier?c=' + encodeURIComponent(code);
const dossierKnop = (req, doc, label) => doc.wijzigCode ? { url: dossierUrl(req, doc.wijzigCode), label: label || 'Open mijn dossier' } : null;
function bestandOpSchijf(id) { // {pad, naam, type} van een geüpload bestand
  if (!/^[a-f0-9]{32}$/.test(String(id))) return null;
  const f = fs.readdirSync(UPLOAD_DIR).find(x => x.startsWith(id) && !x.endsWith('.json')); if (!f) return null;
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, id + '.json'), 'utf8')); } catch (e) {}
  return { pad: path.join(UPLOAD_DIR, f), naam: meta.naam || f, type: meta.type || 'application/octet-stream' };
}
const bijlageVan = id => { const b = bestandOpSchijf(id); return b ? { filename: b.naam, content: fs.readFileSync(b.pad), contentType: b.type } : null; };
// Vragenlijsten per type klant (bewerkbaar in Beheer → instellingen/algemeen.vragenlijsten). Eén vraag per regel.
const STANDAARD_VRAGENLIJSTEN = {
  Huwelijk: ['Jullie namen zoals ze op de uitnodiging moeten staan', 'Datum en uur van de ceremonie', 'Locatie(s): ceremonie, receptie, feest', 'Tot wanneer mogen gasten antwoorden (RSVP)?', 'Hoeveel uitnodigingen hebben jullie nodig?', 'Welke stijl of sfeer spreekt jullie aan? (kleuren, lettertypes, voorbeelden)', 'Is er een dresscode of thema?', 'Zijn er extra kaartjes nodig (menu, naamkaartjes, bedankjes)?', 'Hebben jullie een website of QR-code voor meer info?', 'Nog iets dat ik zeker moet weten?'],
  Geboorte: ['Naam van de baby (en eventueel tweede naam)', 'Geboortedatum en -uur, gewicht en lengte', 'Namen van de ouders', 'Namen van broers/zussen, meter en peter', 'Hoeveel kaartjes hebben jullie nodig?', 'Welke stijl spreekt jullie aan? (kleuren, illustraties, voorbeelden)', 'Komt er een foto op het kaartje?', 'Welke tekst of quote willen jullie erbij?', 'Gegevens voor kraambezoek of een geboortelijst?', 'Nog iets dat ik zeker moet weten?'],
  Ander: ['Wat wil je laten ontwerpen?', 'Voor wanneer heb je het nodig?', 'Hoeveel exemplaren?', 'Welke stijl of sfeer spreekt je aan?', 'Nog iets dat ik zeker moet weten?'],
};
function vragenlijstVoor(k) { const alg = instellingen(); const lijsten = Object.assign({}, STANDAARD_VRAGENLIJSTEN, alg.vragenlijsten || {}); const t = k.type && lijsten[k.type] ? k.type : (lijsten.Ander ? 'Ander' : Object.keys(lijsten)[0]); return (lijsten[t] || []).map(String).filter(Boolean); }
function contractInfo(k) { const c = k.contract || {}; const b = c.bestandId ? bestandOpSchijf(c.bestandId) : null; return { bestandId: c.bestandId || '', naam: b ? b.naam : '', verstuurdOp: c.verstuurdOp || '', getekend: c.getekend ? { naam: c.getekend.naam, op: c.getekend.op } : null }; }
// Schrijfactie vanuit de app samenvoegen met wat er intussen server-side veranderde (klant via dossier/portaal):
// - PATCH: enkel de meegestuurde velden; PUT: hele fiche, maar server-velden blijven staan
// - logboek: unie op tijdstempel; faseDatums: samengevoegd
// - offertes: velden die de klant zette (status, goedkeuring, afwijzing, reactie) winnen van een oudere kopie uit de app
const SERVER_VELDEN = ['wijzigCode', 'portaalNonce', 'msEventId', 'zoomMeetingId', 'vragenlijst', 'contract', 'voorschot', 'bijlages', 'geannuleerdeAfspraak', 'naGoedkeuringVerstuurdOp'];
function mergeKlantSchrijf(oud, body, patch) {
  const uit = patch ? Object.assign({}, oud, body) : Object.assign({}, body);
  for (const f of SERVER_VELDEN) if (oud[f] && !(f in body)) uit[f] = oud[f];
  if ('logboek' in body && Array.isArray(oud.logboek)) { const gezien = new Set((body.logboek || []).map(l => l.ts || (l.d + '|' + l.t))); uit.logboek = (body.logboek || []).concat(oud.logboek.filter(l => !gezien.has(l.ts || (l.d + '|' + l.t)))); }
  if ('faseDatums' in body && oud.faseDatums) uit.faseDatums = Object.assign({}, oud.faseDatums, body.faseDatums || {});
  if ('offertes' in body && Array.isArray(oud.offertes)) {
    uit.offertes = (body.offertes || []).map(o => { const vorige = oud.offertes.find(x => x.id === o.id); if (!vorige || !vorige.klantTs || (o.klantTs && o.klantTs >= vorige.klantTs)) return o;
      return Object.assign({}, o, { status: vorige.status, klantTs: vorige.klantTs, goedgekeurdOp: vorige.goedgekeurdOp, goedgekeurdVia: vorige.goedgekeurdVia, afgewezenOp: vorige.afgewezenOp, klantReactie: vorige.klantReactie, klantReactieOp: vorige.klantReactieOp }); });
    if (!patch) for (const v of oud.offertes) if (v.klantTs && !uit.offertes.some(o => o.id === v.id) && !(body.offertes || []).length) uit.offertes.push(v);
  }
  // fase: als de klant intussen de offerte goedkeurde (fase goedgekeurd gezet door server) en de app een oudere fase terugstuurt zonder dat ze die bewust wijzigde
  if (!patch && oud.fase === 'goedgekeurd' && body.fase && FI_SERVER[body.fase] < FI_SERVER.goedgekeurd && (oud.faseDatums || {}).goedgekeurd && !(body.faseDatums || {}).goedgekeurd) { uit.fase = oud.fase; }
  return uit;
}
function logboek(doc, tekst, soort) { const ts = new Date().toISOString(); doc.logboek = (doc.logboek || []).concat([{ d: vandaagBE(), t: tekst, s: soort || 'afspraak', ts }]); doc.bijgewerkt = ts; }
function meldAdmin(req, onderwerp, basisExtra, soort) { // korte melding naar Liesbeth (sjabloon dossierMelding)
  if (!mailActief()) return; const admin = adminAdres(); if (!admin) return;
  const mm = bouwMail(sjablonen().dossierMelding, Object.assign({ onderwerp, app: publicBase(req) + '/app', afzender: instellingen().afzender || 'justPIXIT' }, basisExtra), {});
  verstuurMail({ to: admin, replyTo: basisExtra.email && basisExtra.email !== '-' ? basisExtra.email : undefined, subject: onderwerp, text: mm.text, html: mm.html }, { soort });
}

// Annuleert de kennismaking: agenda-item (Outlook/Teams) en Zoom-meeting weg, fase → Gesprek geannuleerd, mails.
async function annuleerAfspraak(id, door, req, reden = '') {
  const doc = store.get('klanten', id); if (!doc) throw Object.assign(new Error('Klant niet gevonden'), { status: 404 });
  if (!doc.kennismaking) throw Object.assign(new Error('Er staat geen afspraak om te annuleren.'), { status: 400 });
  if (GESTOPT.has(doc.fase)) throw Object.assign(new Error('Dit traject is al gestopt.'), { status: 400 });
  const problemen = [], was = doc.kennismaking, wasFase = doc.fase;
  if (doc.msEventId && msVerbonden()) { try { await graph.verwijderAfspraak(msDoc(), doc.msEventId); doc.msEventId = ''; const nw = graph.nieuwRefreshToken(); if (nw) { const mm = msDoc(); mm.refreshToken = nw; store.set('instellingen', 'ms', mm); } } catch (e) { problemen.push('Outlook-item verwijderen mislukt: ' + e.message); } }
  if (doc.zoomMeetingId && zoomActief()) { try { await zoom.verwijderMeeting(zoomDoc(), doc.zoomMeetingId); doc.zoomMeetingId = ''; } catch (e) { problemen.push('Zoom-meeting verwijderen mislukt: ' + e.message); } }
  doc.geannuleerdeAfspraak = was; doc.kennismaking = ''; doc.videolink = ''; doc.videoprovider = '';
  doc.stopNa = wasFase; doc.fase = 'geannuleerd'; doc.faseDatums = Object.assign({}, doc.faseDatums, { geannuleerd: vandaagBE() });
  logboek(doc, `Afspraak van ${fmtWanneer(was)} geannuleerd door ${door}` + (reden ? ': ' + reden : ''), 'afspraak');
  for (const p of problemen) logboek(doc, p, 'afspraak');
  store.set('klanten', id, doc);
  let gemaild = false;
  if (mailActief()) {
    const sjab = sjablonen(); const basis = mailBasis(doc, req, { wanneer: fmtWanneer(was), reden: reden || '-', door: door === 'klant' ? 'de klant' : 'jou' });
    if (doc.email) { const k = bouwMail(sjab.annulatieKlant, basis, { boeklink: { url: publicBase(req) + '/afspraak', label: 'Plan een nieuw moment' } }, ['boeklink']); verstuurMail({ to: doc.email, subject: `Afspraak geannuleerd: ${boekingConfig().titel} op ${fmtWanneer(was)}`, text: k.text, html: k.html }, { soort: 'afspraak geannuleerd (klant)' }); gemaild = true; }
    if (door === 'klant') meldAdmin(req, `Afspraak geannuleerd: ${doc.naam} – ${fmtWanneer(was)}`, Object.assign(basis, { bericht: `De klant annuleerde het gesprek van ${fmtWanneer(was)}.` + (reden ? `\nReden: ${reden}` : '') }), 'afspraak geannuleerd (melding)');
  }
  return { ok: true, problemen, gemaild };
}

// Reactie van de klant op een offerte (zonder login via dossier, of via het portaal). actie: goedkeuren | afwijzen | vraag.
function offerteReactie(id, k, o, actie, bericht, req, via) {
  const vandaag = vandaagBE(), tot = euro(offerteTotalen(o).tot), titel = o.titel || 'Offerte';
  let reactie, soort;
  if (actie === 'goedkeuren') {
    if (o.status === 'Goedgekeurd') return { ok: true, al: true, status: o.status };
    if (o.status !== 'Verstuurd') return { error: 'Deze offerte kan niet (meer) goedgekeurd worden.', status: 400 };
    o.status = 'Goedgekeurd'; o.goedgekeurdOp = vandaag; o.goedgekeurdVia = via; delete o.afgewezenOp; reactie = 'Goedgekeurd'; soort = 'offerte goedgekeurd';
    logboek(k, `Offerte "${titel}" (${tot}) goedgekeurd door de klant` + (bericht ? ': ' + bericht : ''), 'offerte');
    if (['gehad', 'offerte', 'opvolging'].includes(k.fase)) { k.fase = 'goedgekeurd'; k.faseDatums = Object.assign({}, k.faseDatums, { goedgekeurd: vandaag }); logboek(k, 'Fase → Goedgekeurd · wacht op vragenlijst', 'fase'); }
  } else if (actie === 'afwijzen') {
    if (!bericht) return { error: 'Laat even weten waarom, of wat er anders mag — dan kan ik een aangepast voorstel maken.', status: 400 };
    if (o.status !== 'Verstuurd') return { error: 'Deze offerte kan niet (meer) afgekeurd worden.', status: 400 };
    o.status = 'Afgewezen'; o.afgewezenOp = vandaag; o.klantReactie = bericht; o.klantReactieOp = vandaag; reactie = 'Afgekeurd'; soort = 'offerte afgekeurd';
    logboek(k, `Offerte "${titel}" afgekeurd door de klant: ${bericht}`, 'offerte');
  } else {
    if (!bericht) return { error: 'Schrijf even wat je wil vragen of aanpassen.', status: 400 };
    o.klantReactie = bericht; o.klantReactieOp = vandaag; reactie = 'Vraag / aanpassing gevraagd'; soort = 'offerte vraag';
    logboek(k, `Vraag bij offerte "${titel}": ${bericht}`, 'offerte');
  }
  o.klantTs = new Date().toISOString(); k.offerteTs = o.klantTs; store.set('klanten', id, k);
  if (mailActief()) {
    const admin = adminAdres(), sjab = sjablonen();
    const basis = mailBasis(k, req, { offerte: titel, totaal: tot, reactie, bericht: bericht || '(geen bericht)' });
    if (admin) { const a = bouwMail(sjab.offerteReactie, basis, {}); verstuurMail({ to: admin, replyTo: k.email || undefined, subject: `${reactie}: ${k.naam} – ${titel}`, text: a.text, html: a.html }, { soort }); }
    if (actie === 'goedkeuren' && k.email) { const c = bouwMail(sjab.offerteGoedgekeurdKlant, basis, { dossierlink: dossierKnop(req, k, 'Open mijn dossier') }, ['dossierlink']); verstuurMail({ to: k.email, subject: 'Bevestiging: offerte goedgekeurd – justPIXIT', text: c.text, html: c.html }, { soort: 'offerte goedgekeurd (bevestiging klant)' }); }
  }
  return { ok: true, status: o.status };
}

// Offerte (geüploade PDF's) per mail versturen met de bestanden als bijlage en een dossierlink om te reageren.
async function verstuurOfferte(id, oid, req, opts = {}) {
  const k = store.get('klanten', id); if (!k) throw Object.assign(new Error('Klant niet gevonden'), { status: 404 });
  const o = (k.offertes || []).find(x => x.id === oid); if (!o) throw Object.assign(new Error('Offerte niet gevonden'), { status: 404 });
  if (!k.email) throw Object.assign(new Error('Deze klant heeft geen e-mailadres op de fiche.'), { status: 400 });
  if (!mailActief()) throw Object.assign(new Error('E-mail is niet ingesteld (zie Koppelingen).'), { status: 400 });
  const bijlagen = (o.bestanden || []).map(f => bijlageVan(f.id)).filter(Boolean);
  if (!bijlagen.length) throw Object.assign(new Error('Upload eerst de offerte als PDF bij deze offerte.'), { status: 400 });
  if (!k.wijzigCode) k.wijzigCode = crypto.randomBytes(9).toString('base64url');
  const vandaag = vandaagBE();
  const basis = mailBasis(k, req, { offerte: o.titel || 'Offerte', totaal: euro(offerteTotalen(o).tot), geldigTot: o.geldigTot || '-', bericht: String(opts.bericht || '').trim() });
  const mm = bouwMail(sjablonen().offerteVerstuurd, basis, { dossierlink: dossierKnop(req, k, 'Bekijk en bevestig de offerte') });
  const r = await verstuurMail({ to: k.email, subject: `Offerte ${o.titel && o.titel !== 'Offerte' ? '"' + o.titel + '" ' : ''}van justPIXIT`, text: mm.text, html: mm.html, attachments: bijlagen }, { soort: 'offerte verstuurd' });
  if (!r.ok) throw Object.assign(new Error('Mail versturen mislukt: ' + r.error), { status: 502 });
  o.status = 'Verstuurd'; o.datum = o.datum || vandaag; o.verstuurdOp = vandaag; delete o.klantReactie; delete o.afgewezenOp;
  logboek(k, `Offerte "${o.titel || 'Offerte'}" gemaild naar ${k.email} (${bijlagen.length} bijlage${bijlagen.length === 1 ? '' : 'n'})`, 'offerte');
  if (['gehad', 'ingepland'].includes(k.fase)) { k.fase = 'offerte'; k.faseDatums = Object.assign({}, k.faseDatums, { offerte: vandaag }); logboek(k, 'Fase → Offerte verstuurd', 'fase'); }
  k.offerteTs = new Date().toISOString(); store.set('klanten', id, k);
  return { ok: true, bijlagen: bijlagen.length };
}

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
// Elke schrijfactie op een klant krijgt een oplopend revisienummer; de app gebruikt dat om een open fiche te verversen
// wanneer er intussen iets veranderde (klant via dossier, agenda-sync, …) zonder eigen wijzigingen te verliezen.
{ const _set = store.set.bind(store); store.set = (col, id, doc) => { if (col === 'klanten' && doc && typeof doc === 'object') { const oud = store.get('klanten', id); doc.rev = ((oud && oud.rev) || 0) + 1; } return _set(col, id, doc); }; }
seedIfEmpty();

// Gebruikers met een rol ('admin' of 'klant') en een PBKDF2-wachtwoord in de database — nooit in klare tekst of in de code.
// Een klant-gebruiker is gekoppeld aan een fiche via klantId. Wie enkel een afspraak boekt, krijgt een fiche maar GEEN gebruiker.
function hashPw(pw, salt) { return crypto.pbkdf2Sync(String(pw), salt, 120000, 32, 'sha256').toString('hex'); }
const normEmail = e => String(e || '').trim().toLowerCase();
function gebruikers() { return store.list('gebruikers'); }
function gebruikerViaEmail(email) { const e = normEmail(email); return gebruikers().find(u => u.email === e) || null; }
function gebruikerViaKlant(klantId) { return gebruikers().find(u => u.klantId === klantId) || null; }
function maakGebruiker(email, role, klantId, extra = {}) {
  const uid = crypto.randomBytes(8).toString('hex');
  store.set('gebruikers', uid, { email: normEmail(email), role, klantId: klantId || '', voornaam: extra.voornaam || '', naam: extra.naam || '', hash: '', salt: '', aangemaakt: new Date().toISOString() });
  return uid;
}
// Rollen: elke rol zegt tot welk deel ze toegang geeft (beheer = Studio, portaal = Mijn pagina).
// moduleGroepen bevat groep-IDs (bv. ['klantbeheer','beheer']); rolModules() vertaalt dat naar individuele tab-IDs.
const STANDAARD_ROLLEN = {
  admin: { label: 'Beheerder', beheer: true, portaal: false, ingebouwd: true, moduleGroepen: ['klantbeheer', 'beheer'] },
  klantbeheerder: { label: 'Klantbeheerder', beheer: true, portaal: false, ingebouwd: true, moduleGroepen: ['klantbeheer'] },
  klant: { label: 'Klant', beheer: false, portaal: true, ingebouwd: true, moduleGroepen: [] },
};
// Opgeslagen rollen overschrijven de standaard; bij ingebouwde rollen enkel label + moduleGroepen (toegang blijft vast).
function rollen() {
  const d = store.get('instellingen', 'rollen'); const opgeslagen = (d && d.rollen) || {}; const out = {};
  for (const k in STANDAARD_ROLLEN) {
    const s = STANDAARD_ROLLEN[k], o = opgeslagen[k] || {};
    out[k] = Object.assign({}, s, { label: o.label || s.label,
      moduleGroepen: Array.isArray(o.moduleGroepen) ? o.moduleGroepen.filter(x => GROEP_IDS.has(x)) : s.moduleGroepen.slice() });
  }
  for (const k in opgeslagen) if (!STANDAARD_ROLLEN[k]) {
    const o = opgeslagen[k];
    out[k] = { label: o.label || k, beheer: !!o.beheer, portaal: !!o.portaal, ingebouwd: false,
      moduleGroepen: Array.isArray(o.moduleGroepen) ? o.moduleGroepen.filter(x => GROEP_IDS.has(x)) : [] };
  }
  return out;
}
function rolDef(key) { return rollen()[key] || null; }
function rolHeeft(key, deel) { const r = rolDef(key); return !!(r && r[deel]); }
function rolModules(key) {
  const r = rolDef(key); if (!r) return [];
  // Beheer-rollen: vertaal moduleGroepen naar tab-IDs; klant-rollen: portaalmodules
  if (r.portaal) return PORTAAL_MODULES.map(m => m.id);
  return groepNaarTabs(r.moduleGroepen || []);
}
function bewaarRollen(map) { store.set('instellingen', 'rollen', { rollen: map }); }
const gestopt = k => GESTOPT.has(k.fase);
function zetWachtwoord(uid, pw) {
  const u = store.get('gebruikers', uid); if (!u) return;
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt; u.hash = hashPw(pw, salt); delete u.invite; u.gewijzigd = new Date().toISOString();
  store.set('gebruikers', uid, u);
}
function checkLogin(email, pw) { const u = gebruikerViaEmail(email); if (!u || !u.hash) return null; return safeEq(hashPw(String(pw), u.salt), u.hash) ? u : null; }

// Eerste start: zet het adminaccount klaar (migreer van instellingen/admin, anders uit .env) en een test-klantaccount.
function seedGebruikers() {
  const adminEmail = (store.get('instellingen', 'admin') || {}).email || process.env.ADMIN_LOGIN_EMAIL || 'liesbeth@justpixit.be';
  if (!gebruikers().some(u => u.role === 'admin')) {
    const uid = maakGebruiker(adminEmail, 'admin', '');
    const oud = store.get('instellingen', 'admin');
    if (oud && oud.hash && oud.salt) { const u = store.get('gebruikers', uid); u.hash = oud.hash; u.salt = oud.salt; store.set('gebruikers', uid, u); }
    else if (ADMIN_PASSWORD && ADMIN_PASSWORD.length >= 8) zetWachtwoord(uid, ADMIN_PASSWORD);
  }
  // Test-klant (demo) gekoppeld aan een voorbeeldfiche. Zet SEED_TEST_KLANT=false om dit over te slaan/uit te schakelen in productie.
  if (process.env.SEED_TEST_KLANT !== 'false' && !gebruikerViaEmail('klant@justpixit.be')) {
    let demoId = store.get('klanten', 'vb-emma-jules') ? 'vb-emma-jules' : ((store.list('klanten')[0] || {}).id || '');
    if (demoId) {
      const demo = store.get('klanten', demoId); if (demo && !demo.email) { demo.email = 'klant@justpixit.be'; store.set('klanten', demoId, demo); }
      const uid = maakGebruiker('klant@justpixit.be', 'klant', demoId);
      zetWachtwoord(uid, process.env.TEST_KLANT_PASSWORD || 'klantpixit');
    }
  }
}
seedGebruikers();

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
// Eén sessiecookie 'sid' = <uid>.<exp>.<sig>, voor zowel admin als klant; de rol zit in de gebruiker.
function makeSession(uid) { const payload = `${uid}.${Date.now() + 30 * 864e5}`; return `${payload}.${sign('ses:' + payload)}`; }
function sessieUid(req) {
  const t = cookies(req).sid || ''; const i = t.lastIndexOf('.'); if (i < 0) return null;
  const payload = t.slice(0, i), sig = t.slice(i + 1), exp = sign('ses:' + payload);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const [uid, expAt] = payload.split('.'); if (Number(expAt) < Date.now()) return null; return uid;
}
function huidigeGebruiker(req) { const uid = sessieUid(req); return uid ? store.get('gebruikers', uid) : null; }
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || !!req.socket.encrypted;
const authedAdmin = req => { const u = huidigeGebruiker(req); return u && rolHeeft(u.role, 'beheer') ? u : null; };
const sidCookie = (req, val, maxAge) => `sid=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// Uitnodiging / wachtwoord-reset: token = <uid>.<exp>.<nonce>.<sig>; de nonce staat op de gebruiker (eenmalig).
function maakInvite(uid, uren = 72) {
  const u = store.get('gebruikers', uid); if (!u) return null;
  const nonce = crypto.randomBytes(9).toString('hex'); u.invite = { nonce, exp: Date.now() + uren * 3600e3 }; store.set('gebruikers', uid, u);
  const payload = `${uid}.${u.invite.exp}.${nonce}`; return `${payload}.${sign('inv:' + payload)}`;
}
function leesInvite(t) {
  const i = String(t || '').lastIndexOf('.'); if (i < 0) return null;
  const payload = t.slice(0, i), sig = t.slice(i + 1), exp = sign('inv:' + payload);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const [uid, expAt, nonce] = payload.split('.'); if (Number(expAt) < Date.now()) return null;
  const u = store.get('gebruikers', uid); if (!u || !u.invite || !safeEq(u.invite.nonce, nonce)) return null; return uid;
}
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
    const u = checkLogin(body.email, body.wachtwoord || '');
    if (!u) return json(res, 401, { error: 'Verkeerd e-mailadres of wachtwoord' });
    u.laatstIngelogd = new Date().toISOString(); store.set('gebruikers', u.id, u);
    res.setHeader('Set-Cookie', sidCookie(req, makeSession(u.id), 30 * 86400));
    return json(res, 200, { ok: true, role: u.role, redirect: u.role === 'admin' ? '/app' : '/mijn' });
  }
  if (p === '/api/logout' && m === 'POST') { res.setHeader('Set-Cookie', sidCookie(req, '', 0)); return json(res, 200, { ok: true }); }
  if (p === '/api/wachtwoord-vergeten' && m === 'POST') {
    const ip = clientIp(req);
    if (limited('vergeten:' + ip, 8, 15 * 60e3)) return json(res, 429, { error: 'Te veel pogingen. Probeer later opnieuw.' });
    const b = await readJson(req, 10e3).catch(() => ({}));
    const u = gebruikerViaEmail(b.email);
    if (u && mailActief() && !limited('vergeten:' + u.email, 3, 15 * 60e3)) {
      try {
        const token = maakInvite(u.id, 2); const link = publicBase(req) + '/wachtwoord?t=' + encodeURIComponent(token);
        const naam = u.role === 'klant' && u.klantId ? (store.get('klanten', u.klantId) || {}).naam : '';
        const basis = Object.assign({ voornaam: (String(naam || '').split(/\s|&/)[0] || '').trim(), afzender: instellingen().afzender || 'justPIXIT' });
        const m2 = bouwMail(sjablonen().wachtwoordReset, basis, { loginlink: { url: link, label: 'Nieuw wachtwoord instellen' } });
        await verstuurMail({ to: u.email, subject: 'Nieuw wachtwoord instellen · justPIXIT', text: m2.text, html: m2.html }, { soort: 'wachtwoord reset' });
      } catch (e) { console.error('[reset]', e.message); }
    }
    return json(res, 200, { ok: true }); // zelfde antwoord, of het adres nu bestaat of niet
  }
  if (p === '/api/invite' && (m === 'GET' || m === 'POST')) {
    const b = m === 'POST' ? await readJson(req, 10e3).catch(() => ({})) : {};
    const t = m === 'GET' ? url.searchParams.get('t') : b.t;
    const uid = leesInvite(t);
    if (!uid) return json(res, 400, { error: 'Deze link is verlopen of al gebruikt. Vraag een nieuwe aan via "Wachtwoord vergeten".' });
    const u = store.get('gebruikers', uid);
    if (m === 'GET') return json(res, 200, { email: u.email, nieuw: !u.hash });
    const pw = String(b.wachtwoord || '');
    if (pw.length < 8) return json(res, 400, { error: 'Kies een wachtwoord van minstens 8 tekens.' });
    zetWachtwoord(uid, pw);
    const u2 = store.get('gebruikers', uid); u2.laatstIngelogd = new Date().toISOString(); store.set('gebruikers', uid, u2);
    res.setHeader('Set-Cookie', sidCookie(req, makeSession(uid), 30 * 86400));
    return json(res, 200, { ok: true, role: u.role, redirect: u.role === 'admin' ? '/app' : '/mijn' });
  }

  if (p === '/api/boeking/slots' && m === 'GET') {
    const cfg = boekingConfig();
    if (!cfg.actief) return json(res, 200, { actief: false });
    const bezet = bezetteSlots('');
    const slots = slotsVoorPeriode(cfg, bezet);
    return json(res, 200, { actief: true, titel: cfg.titel, intro: cfg.intro, locatie: cfg.locatie, duur: cfg.duur, bevestiging: cfg.bevestiging, types: cfg.types, vragen: cfg.vragen, video: videoBeschikbaar(), dagen: slots });
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
    const bezet = bezetteSlots('');
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
    // Videocall aanmaken indien gekozen en beschikbaar.
    const videoKeuze = String(b.video || '');
    const videoOpties = videoBeschikbaar().map(v => v.id);
    let videolink = '', videoprovider = '', teamsEvent = null;
    if (videoKeuze && videoOpties.includes(videoKeuze)) {
      try {
        if (videoKeuze === 'teams') {
          const r = await graph.zetAfspraak(msDoc(), { naam, kennismaking: slot, locatie: 'Microsoft Teams', email, telefoon, type: doc.type }, cfg.duur || 60, { teams: true });
          teamsEvent = r.id; videolink = r.joinUrl || ''; videoprovider = 'Teams';
          const nw = graph.nieuwRefreshToken(); if (nw) { const mm = msDoc(); mm.refreshToken = nw; store.set('instellingen', 'ms', mm); }
          if (!videolink) throw new Error('Microsoft gaf geen Teams-link terug (controleer Calendars.ReadWrite-rechten)');
        } else if (videoKeuze === 'zoom') {
          const r = await zoom.maakMeeting(zoomDoc(), { topic: 'Kennismaking · ' + naam, start: slot, duur: cfg.duur || 60 });
          videolink = r.joinUrl || ''; videoprovider = 'Zoom'; if (r.id) doc.zoomMeetingId = String(r.id);
        }
      } catch (e) { console.error('[video]', e.message); doc.logboek.push({ d: vandaag, t: 'Videocall (' + videoKeuze + ') aanmaken mislukt: ' + e.message, s: 'afspraak', ts: new Date().toISOString() }); }
    }
    if (videolink) { doc.videolink = videolink; doc.videoprovider = videoprovider; doc.locatie = videoprovider; if (teamsEvent) doc.msEventId = teamsEvent; doc.logboek.push({ d: vandaag, t: videoprovider + '-link aangemaakt: ' + videolink, s: 'afspraak', ts: new Date().toISOString() }); }
    doc.wijzigCode = crypto.randomBytes(9).toString('base64url'); // persoonlijke verzetlink voor deze lead
    store.set('klanten', id, doc);
    if (!teamsEvent) msZet(Object.assign({ id }, doc));  // Teams maakte het agenda-item al
    const when = `${slot.slice(8, 10)}/${slot.slice(5, 7)}/${slot.slice(0, 4)} om ${slot.slice(11, 16)}`;
    // Mails zijn best-effort.
    if (mailActief()) {
      const admin = adminAdres(), sjab = sjablonen();
      const basis = mailBasis(doc, req, { locatie: doc.locatie || cfg.locatie, bericht: notitie || '(geen bericht)' });
      // Knop-plaatshouders mogen vrij in het sjabloon staan; ontbreekt {videolink} in een opgeslagen sjabloon, dan komt de knop achteraan.
      const kMail = bouwMail(sjab.boekingKlant, basis, { videolink: videoKnop(doc), wijziglink: wijzigKnop(req, doc) });
      const aMail = bouwMail(sjab.boekingAdmin, basis, { videolink: videoKnop(doc) });
      if (admin) verstuurMail({ to: admin, replyTo: email, subject: `Nieuwe afspraak: ${naam} – ${when}`, text: aMail.text, html: aMail.html }, { soort: 'melding nieuwe afspraak' });
      verstuurMail({ to: email, subject: `Bevestiging: ${cfg.titel} op ${when}`, text: kMail.text, html: kMail.html }, { soort: 'bevestiging afspraak' });
    }
    return json(res, 200, { ok: true, slot, duur: cfg.duur, titel: cfg.titel, locatie: doc.locatie || cfg.locatie, bevestiging: cfg.bevestiging, videolink: doc.videolink || '', videoprovider: doc.videoprovider || '', mail: mailActief() });
  }

  // --- dossier met persoonlijke code (klantflow zonder login): afspraak, offerte, vragenlijst, contract ---
  const wzMatch = p.match(/^\/api\/(?:wijzig|dossier)\/([A-Za-z0-9_-]{8,64})(?:\/(.+))?$/);
  if (wzMatch) {
    const ip = clientIp(req);
    if (limited('dossier:' + ip, 120, 15 * 60e3)) return json(res, 429, { error: 'Te veel aanvragen. Probeer later opnieuw.' });
    const k = klantViaWijzigCode(wzMatch[1]);
    if (!k) return json(res, 404, { error: 'Deze link is niet (meer) geldig. Stuur me gerust een berichtje, dan help ik je verder.' });
    const kid = k.id, sub = wzMatch[2] || '', cfg = boekingConfig();
    const zichtbaar = (k.offertes || []).filter(o => o.status && o.status !== 'Concept');
    const bijlagesVan = () => { const uit = []; for (const o of zichtbaar) for (const f of (o.bestanden || [])) uit.push({ id: f.id, naam: f.naam || 'bestand', type: f.type || '', soort: 'offerte', bron: o.titel || 'Offerte', d: f.d || '' }); for (const f of (k.bijlages || [])) uit.push({ id: f.id, naam: f.naam || 'bestand', type: f.type || '', soort: f.soort || 'ander', bron: '', d: f.d || '' }); return uit; };
    if (!sub && m === 'GET') {
      const vl = vragenlijstVoor(k);
      return json(res, 200, { naam: k.naam, voornaam: (String(k.naam || '').replace(/^Voorbeeld\s*·\s*/, '').split(/\s|&/)[0] || '').trim(), type: k.type || '', email: k.email || '', telefoon: k.telefoon || '',
        kennismaking: k.kennismaking || '', geannuleerdeAfspraak: k.geannuleerdeAfspraak || '', duur: cfg.duur, titel: cfg.titel, locatie: k.videoprovider || cfg.locatie || '', videolink: k.videolink || '', videoprovider: k.videoprovider || '',
        fase: k.fase, fasen: fasenVoor(k), gestopt: GESTOPT.has(k.fase), verplaatsbaar: !GESTOPT.has(k.fase) && !!k.kennismaking && k.kennismaking >= nuBrussel(), nu: nuBrussel(), actief: !!cfg.actief,
        offertes: zichtbaar.map(o => ({ id: o.id, titel: o.titel || 'Offerte', status: o.status, datum: o.datum || '', geldigTot: o.geldigTot || '', notitie: o.notitie || '', totaal: offerteTotalen(o).tot, bestanden: (o.bestanden || []).map(f => ({ id: f.id, naam: f.naam || 'bestand', type: f.type || '' })), reactie: o.klantReactie || '', goedgekeurdOp: o.goedgekeurdOp || '', afgewezenOp: o.afgewezenOp || '' })),
        vragenlijst: { vragen: vl, antwoorden: (k.vragenlijst && k.vragenlijst.antwoorden) || {}, ingevuldOp: (k.vragenlijst && k.vragenlijst.ingevuldOp) || '', nodig: FI_SERVER[k.fase] >= FI_SERVER.goedgekeurd && !GESTOPT.has(k.fase) },
        contract: contractInfo(k), voorschot: k.voorschot || { betaald: false }, bijlages: bijlagesVan(), naGoedkeuringVerstuurdOp: k.naGoedkeuringVerstuurdOp || '' });
    }
    if (sub === 'slots' && m === 'GET') return json(res, 200, { actief: !!cfg.actief, duur: cfg.duur, dagen: cfg.actief ? slotsVoorPeriode(cfg, bezetteSlots(kid)) : [] });
    if (sub === 'verplaats' && m === 'POST') {
      if (limited('wverplaats:' + kid, 5, 60 * 60e3)) return json(res, 429, { error: 'Te vaak verplaatst. Stuur me een berichtje, dan regelen we het samen.' });
      const b = await readJson(req, 10e3).catch(() => ({}));
      try { const r = await verplaatsAfspraak(kid, String(b.slot || ''), 'klant', req); return json(res, 200, r); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (sub === 'annuleer' && m === 'POST') {
      const b = await readJson(req, 10e3).catch(() => ({}));
      try { const r = await annuleerAfspraak(kid, 'klant', req, String(b.reden || '').trim().slice(0, 500)); return json(res, 200, r); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    const bm = sub.match(/^bestand\/([a-f0-9]{32})$/);
    if (bm && m === 'GET') {
      if (!bijlagesVan().some(f => f.id === bm[1])) return text(res, 404, 'Niet gevonden');
      const b = bestandOpSchijf(bm[1]); if (!b) return text(res, 404, 'Niet gevonden');
      return serveFile(res, b.pad, { 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
    }
    const om = sub.match(/^offerte\/([A-Za-z0-9_-]{1,40})\/(goedkeuren|afwijzen|vraag)$/);
    if (om && m === 'POST') {
      const o = zichtbaar.find(x => x.id === om[1]); if (!o) return json(res, 404, { error: 'Offerte niet gevonden' });
      const b = await readJson(req, 10e3).catch(() => ({}));
      const r = offerteReactie(kid, k, o, om[2], String(b.bericht || '').trim().slice(0, 2000), req, 'dossier');
      return r.error ? json(res, r.status || 400, { error: r.error }) : json(res, 200, r);
    }
    if (sub === 'vragenlijst' && m === 'POST') {
      const b = await readJson(req, 50e3).catch(() => ({}));
      const vragen = vragenlijstVoor(k); const ant = {};
      for (const v of vragen) { const a = b.antwoorden && b.antwoorden[v]; if (a !== undefined) ant[v] = String(a).trim().slice(0, 2000); }
      const al = !!(k.vragenlijst && k.vragenlijst.ingevuldOp);
      k.vragenlijst = { type: k.type || '', antwoorden: ant, ingevuldOp: vandaagBE(), ts: new Date().toISOString() };
      logboek(k, al ? 'Klant werkte de vragenlijst bij via het dossier' : 'Vragenlijst ingevuld door de klant via het dossier', 'vragenlijst');
      store.set('klanten', kid, k);
      if (!al) meldAdmin(req, `Vragenlijst ontvangen: ${k.naam}`, mailBasis(k, req, { bericht: `De klant vulde de vragenlijst (${k.type || 'algemeen'}) in. Bekijk ze in de fiche onder Vragenlijst.` }), 'vragenlijst ontvangen');
      return json(res, 200, { ok: true });
    }
    if (sub === 'contract/teken' && m === 'POST') {
      const b = await readJson(req, 400e3).catch(() => ({}));
      const c = k.contract || {}; if (!c.bestandId) return json(res, 400, { error: 'Er staat nog geen contract klaar om te tekenen.' });
      if (c.getekend) return json(res, 200, { ok: true, al: true });
      const naam = String(b.naam || '').trim().slice(0, 120); const handtekening = String(b.handtekening || '');
      if (naam.length < 3) return json(res, 400, { error: 'Vul je volledige naam in.' });
      if (!b.akkoord) return json(res, 400, { error: 'Vink aan dat je akkoord gaat met het contract.' });
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/.test(handtekening)) return json(res, 400, { error: 'Zet je handtekening in het vak.' });
      let hid = ''; try { const buf = Buffer.from(handtekening.split(',')[1], 'base64'); hid = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(UPLOAD_DIR, hid + '.png'), buf); fs.writeFileSync(path.join(UPLOAD_DIR, hid + '.json'), JSON.stringify({ naam: 'handtekening-' + naam.replace(/[^A-Za-z0-9]+/g, '-') + '.png', type: 'image/png', size: buf.length, d: new Date().toISOString() })); } catch (e) {}
      const op = new Date().toISOString();
      c.getekend = { naam, op, ip: clientIp(req), handtekeningId: hid }; k.contract = c;
      k.bijlages = (k.bijlages || []).concat(hid ? [{ id: hid, naam: 'Handtekening ' + naam + '.png', type: 'image/png', soort: 'contract_getekend', d: vandaagBE() }] : []);
      logboek(k, `Contract getekend door ${naam} via het dossier`, 'contract');
      store.set('klanten', kid, k);
      meldAdmin(req, `Contract getekend: ${k.naam}`, mailBasis(k, req, { bericht: `${naam} tekende het contract op ${op.slice(0, 16).replace('T', ' ')} (IP ${clientIp(req)}). De handtekening staat bij de bijlages.` }), 'contract getekend');
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Onbekende route' });
  }

  // --- klantenportaal (klant-sessie) ---
  if (p.startsWith('/api/portaal/')) {
    const gu = huidigeGebruiker(req);
    if (!gu || !rolHeeft(gu.role, 'portaal')) return json(res, 401, { error: 'Niet aangemeld' });
    const kid = gu.klantId;
    const k = kid && store.get('klanten', kid);
    if (!k) return json(res, 404, { error: 'Geen dossier gekoppeld aan dit account.' });
    const cfg = boekingConfig();
    const zichtbareOffertes = () => (k.offertes || []).filter(o => o.status && o.status !== 'Concept');
    if (p === '/api/portaal/me' && m === 'GET') {
      const offertes = zichtbareOffertes().map(o => { const t = offerteTotalen(o); return { id: o.id, titel: o.titel || 'Offerte', status: o.status, datum: o.datum || '', geldigTot: o.geldigTot || '', notitie: o.notitie || '', btw: num(o.btw),
        regels: (o.regels || []).filter(r => r.oms || r.aantal || r.prijs).map(r => ({ oms: r.oms || '', aantal: num(r.aantal), prijs: num(r.prijs), totaal: num(r.aantal) * num(r.prijs) })),
        totalen: t, bestanden: (o.bestanden || []).map(f => ({ id: f.id, naam: f.naam || 'bestand', type: f.type || '' })), goedgekeurdOp: o.goedgekeurdOp || '', reactie: o.klantReactie || '' }; });
      const voornaam = gu.voornaam || (String(k.naam || '').replace(/^Voorbeeld\s*·\s*/, '').split(/\s|&/)[0] || '').trim();
      return json(res, 200, { naam: k.naam, voornaam, email: k.email || '', telefoon: k.telefoon || '', type: k.type || '', datumEvent: k.datumEvent || '', gasten: k.gasten || '',
        kennismaking: k.kennismaking || '', duur: cfg.duur, locatie: k.videoprovider || cfg.locatie || '', titel: cfg.titel, videolink: k.videolink || '', videoprovider: k.videoprovider || '',
        fase: k.fase, fasen: fasenVoor(k), offertes, modules: rolModules(gu.role), gestopt: GESTOPT.has(k.fase), verplaatsbaar: !GESTOPT.has(k.fase) && !!k.kennismaking && k.kennismaking >= nuBrussel(), nu: nuBrussel() });
    }
    const bestandM = p.match(/^\/api\/portaal\/bestand\/([a-f0-9]{32})$/);
    if (bestandM && m === 'GET') {
      if (!zichtbareOffertes().some(o => (o.bestanden || []).some(f => f.id === bestandM[1]))) return text(res, 404, 'Niet gevonden');
      const f = fs.readdirSync(UPLOAD_DIR).find(x => x.startsWith(bestandM[1]) && !x.endsWith('.json'));
      if (!f) return text(res, 404, 'Niet gevonden');
      return serveFile(res, path.join(UPLOAD_DIR, f), { 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' });
    }
    const ofM = p.match(/^\/api\/portaal\/offerte\/([A-Za-z0-9_-]{1,40})\/(goedkeuren|afwijzen|reactie|vraag)$/);
    if (ofM && m === 'POST') {
      const o = zichtbareOffertes().find(x => x.id === ofM[1]);
      if (!o) return json(res, 404, { error: 'Offerte niet gevonden' });
      const b = await readJson(req, 10e3).catch(() => ({}));
      const r = offerteReactie(kid, k, o, ofM[2] === 'reactie' ? 'vraag' : ofM[2], String(b.bericht || '').trim().slice(0, 2000), req, 'portaal');
      return r.error ? json(res, r.status || 400, { error: r.error }) : json(res, 200, r);
    }
    if (p === '/api/portaal/slots' && m === 'GET') {
      if (!cfg.actief) return json(res, 200, { actief: false, dagen: [] });
      return json(res, 200, { actief: true, duur: cfg.duur, dagen: slotsVoorPeriode(cfg, bezetteSlots(kid)) });
    }
    if (p === '/api/portaal/verplaats' && m === 'POST') {
      if (limited('pverplaats:' + kid, 5, 60 * 60e3)) return json(res, 429, { error: 'Te vaak verplaatst. Stuur me een berichtje, dan regelen we het samen.' });
      const b = await readJson(req, 10e3).catch(() => ({}));
      try { const r = await verplaatsAfspraak(kid, String(b.slot || ''), 'klant', req); return json(res, 200, r); }
      catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/portaal/gegevens' && m === 'POST') {
      const b = await readJson(req, 10e3).catch(() => ({}));
      const wijz = [];
      if ('telefoon' in b) { const v = String(b.telefoon || '').trim().slice(0, 40); if (v !== (k.telefoon || '')) { k.telefoon = v; wijz.push('telefoon'); } }
      if ('datumEvent' in b) { const v = String(b.datumEvent || '').slice(0, 10); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return json(res, 400, { error: 'Ongeldige datum' }); if (v !== (k.datumEvent || '')) { k.datumEvent = v; wijz.push('datum feest'); } }
      if ('gasten' in b) { const v = String(b.gasten || '').trim().slice(0, 40); if (v !== (k.gasten || '')) { k.gasten = v; wijz.push('aantal gasten'); } }
      if (wijz.length) { k.bijgewerkt = new Date().toISOString(); k.logboek = (k.logboek || []).concat([{ d: vandaagBE(), t: 'Klant paste via het portaal aan: ' + wijz.join(', '), s: 'afspraak', ts: k.bijgewerkt }]); store.set('klanten', kid, k); }
      return json(res, 200, { ok: true, gewijzigd: wijz });
    }
    return json(res, 404, { error: 'Onbekende route' });
  }

  // --- vanaf hier: beheer (admin) vereist ---
  const admingu = authedAdmin(req);
  if (!admingu) return json(res, 401, { error: 'Niet aangemeld' });

  if (p === '/api/me') return json(res, 200, { ok: true, base: publicBase(req), mail: mailActief(), whatsapp: !!twilioConfig(effEnv()), facturen: verkoperKlaar(), office365: msVerbonden(), zoom: zoomActief(), versie: VERSION.version, account: admingu.email, rol: admingu.role, modules: rolModules(admingu.role) });
  if (p === '/api/account' && m === 'GET') return json(res, 200, { email: admingu.email });
  if (p === '/api/account' && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    if (!safeEq(hashPw(String(b.huidig || ''), admingu.salt || ''), admingu.hash || '')) return json(res, 401, { error: 'Je huidige wachtwoord klopt niet.' });
    const email = ('email' in b) ? normEmail(b.email) : admingu.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Vul een geldig e-mailadres in.' });
    const bestaat = gebruikerViaEmail(email); if (bestaat && bestaat.id !== admingu.id) return json(res, 409, { error: 'Dit e-mailadres is al in gebruik.' });
    const nieuw = String(b.nieuw || '');
    if (nieuw && nieuw.length < 8) return json(res, 400, { error: 'Kies een wachtwoord van minstens 8 tekens.' });
    admingu.email = email; store.set('gebruikers', admingu.id, admingu);
    if (nieuw) zetWachtwoord(admingu.id, nieuw);
    return json(res, 200, { ok: true, email });
  }
  // --- Gebruikersbeheer ---
  const aantalBeheer = () => gebruikers().filter(u => rolHeeft(u.role, 'beheer')).length;
  if (p === '/api/gebruikers' && m === 'GET') {
    return json(res, 200, {
      gebruikers: gebruikers().map(u => ({ id: u.id, email: u.email, voornaam: u.voornaam || '', naam: u.naam || '', role: u.role, klantId: u.klantId || '', klant: u.klantId ? (store.get('klanten', u.klantId) || {}).naam || '' : '', actief: !!u.hash, laatstIngelogd: u.laatstIngelogd || '' })),
      rollen: rollen(), moduleGroepen: MODULE_GROEPEN.map(g => ({ ...g, tabLabels: g.tabs.map(t => (TAB_MAP.get(t) || {}).label || t) })),
    });
  }
  if (p === '/api/gebruikers' && m === 'POST') { // nieuwe gebruiker + uitnodiging om wachtwoord in te stellen
    const b = await readJson(req, 10e3).catch(() => ({}));
    const email = normEmail(b.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Vul een geldig e-mailadres in.' });
    if (gebruikerViaEmail(email)) return json(res, 409, { error: 'Er bestaat al een gebruiker met dit e-mailadres.' });
    const role = rolDef(b.role) ? b.role : 'klant';
    const uid = maakGebruiker(email, role, b.klantId || '', { voornaam: String(b.voornaam || '').trim().slice(0, 80), naam: String(b.naam || '').trim().slice(0, 120) });
    let link = '', gemaild = false;
    try { link = publicBase(req) + '/wachtwoord?t=' + encodeURIComponent(maakInvite(uid, b.mail ? 72 : 24 * 7));
      if (b.mail && mailActief()) { const u = store.get('gebruikers', uid); const basis = { voornaam: u.voornaam || '', naam: u.naam || '', afzender: instellingen().afzender || 'justPIXIT', app: publicBase(req) + '/' };
        const mm = bouwMail(sjablonen().portaalLogin, basis, { loginlink: { url: link, label: 'Stel mijn wachtwoord in' } });
        const r = await verstuurMail({ to: email, subject: 'Toegang tot justPIXIT', text: mm.text, html: mm.html }, { soort: 'uitnodiging gebruiker' }); gemaild = r.ok; }
    } catch (e) { console.error('[gebruiker]', e.message); }
    return json(res, 200, { ok: true, id: uid, link, gemaild });
  }
  const gebrMatch = p.match(/^\/api\/gebruikers\/([a-f0-9]{8,32})$/);
  if (gebrMatch && (m === 'POST' || m === 'PUT')) { // naam/voornaam/e-mail/rol wijzigen
    const u = store.get('gebruikers', gebrMatch[1]); if (!u) return json(res, 404, { error: 'Niet gevonden' });
    u.id = gebrMatch[1];
    const b = await readJson(req, 10e3).catch(() => ({}));
    if ('email' in b) { const e = normEmail(b.email); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return json(res, 400, { error: 'Vul een geldig e-mailadres in.' }); const bestaat = gebruikerViaEmail(e); if (bestaat && bestaat.id !== u.id) return json(res, 409, { error: 'Dit e-mailadres is al in gebruik.' }); u.email = e; }
    if ('voornaam' in b) u.voornaam = String(b.voornaam || '').trim().slice(0, 80);
    if ('naam' in b) u.naam = String(b.naam || '').trim().slice(0, 120);
    if ('role' in b && b.role !== u.role) {
      if (!rolDef(b.role)) return json(res, 400, { error: 'Onbekende rol.' });
      if (rolHeeft(u.role, 'beheer') && !rolHeeft(b.role, 'beheer') && aantalBeheer() <= 1) return json(res, 400, { error: 'Dit is het laatste account met beheerrechten; wijzig de rol niet.' });
      u.role = b.role;
    }
    store.set('gebruikers', u.id, u);
    return json(res, 200, { ok: true });
  }
  if (gebrMatch && m === 'DELETE') {
    const u = store.get('gebruikers', gebrMatch[1]);
    if (!u) return json(res, 404, { error: 'Niet gevonden' });
    if (rolHeeft(u.role, 'beheer') && aantalBeheer() <= 1) return json(res, 400, { error: 'Je kan het laatste account met beheerrechten niet verwijderen.' });
    store.delete('gebruikers', gebrMatch[1]);
    return json(res, 200, { ok: true });
  }
  if (p.match(/^\/api\/gebruikers\/([a-f0-9]{8,32})\/uitnodiging$/) && m === 'POST') {
    const id = p.split('/')[3]; const u = store.get('gebruikers', id); if (!u) return json(res, 404, { error: 'Niet gevonden' });
    const b = await readJson(req, 10e3).catch(() => ({}));
    const link = publicBase(req) + '/wachtwoord?t=' + encodeURIComponent(maakInvite(id, b.mail ? 72 : 24 * 7));
    let gemaild = false;
    if (b.mail) { if (!mailActief()) return json(res, 400, { error: 'E-mail is niet ingesteld (zie Koppelingen).' });
      const basis = { voornaam: u.voornaam || '', naam: u.naam || '', afzender: instellingen().afzender || 'justPIXIT', app: publicBase(req) + '/' };
      const mm = bouwMail(sjablonen().portaalLogin, basis, { loginlink: { url: link, label: 'Stel mijn wachtwoord in' } });
      const r = await verstuurMail({ to: u.email, subject: 'Toegang tot justPIXIT', text: mm.text, html: mm.html }, { soort: 'uitnodiging gebruiker' }); if (!r.ok) return json(res, 502, { error: 'Mail versturen mislukt: ' + r.error }); gemaild = true;
    }
    return json(res, 200, { ok: true, link, gemaild });
  }
  // Rollen beheren
  if (p === '/api/rollen' && m === 'GET') return json(res, 200, { rollen: rollen() });
  if (p === '/api/rollen' && m === 'POST') { // toevoegen of wijzigen
    const b = await readJson(req, 10e3).catch(() => ({}));
    const key = String(b.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    if (!key) return json(res, 400, { error: 'Geef de rol een korte sleutel (letters/cijfers).' });
    if (STANDAARD_ROLLEN[key] && b.nieuw) return json(res, 409, { error: 'Deze rol bestaat al.' });
    const map = (store.get('instellingen', 'rollen') || {}).rollen || {};
    const moduleGroepen = Array.isArray(b.moduleGroepen) ? b.moduleGroepen.map(String).filter(x => GROEP_IDS.has(x)) : null;
    if (STANDAARD_ROLLEN[key]) { // ingebouwd: toegang ligt vast, label en moduleGroepen mag je aanpassen
      const s0 = STANDAARD_ROLLEN[key];
      map[key] = { label: String(b.label || s0.label).trim().slice(0, 40) || s0.label, moduleGroepen: moduleGroepen || (map[key] && map[key].moduleGroepen) || s0.moduleGroepen };
    } else {
      const beheer = !!b.beheer, portaal = !!b.portaal;
      map[key] = { label: String(b.label || key).trim().slice(0, 40) || key, beheer, portaal, ingebouwd: false, moduleGroepen: moduleGroepen || (map[key] && map[key].moduleGroepen) || [] };
    }
    bewaarRollen(map);
    return json(res, 200, { ok: true, key });
  }
  const rolMatch = p.match(/^\/api\/rollen\/([a-z0-9_]{1,24})$/);
  if (rolMatch && m === 'DELETE') {
    const key = rolMatch[1];
    if (STANDAARD_ROLLEN[key]) return json(res, 400, { error: 'Ingebouwde rollen kan je niet verwijderen.' });
    if (gebruikers().some(u => u.role === key)) return json(res, 400, { error: 'Er zijn nog gebruikers met deze rol. Wijzig hun rol eerst.' });
    const map = (store.get('instellingen', 'rollen') || {}).rollen || {}; delete map[key]; bewaarRollen(map);
    return json(res, 200, { ok: true });
  }
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
  const verplaatsMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/verplaats$/);
  if (verplaatsMatch && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    try { const r = await verplaatsAfspraak(verplaatsMatch[1], String(b.slot || ''), 'jou', req, { vrijKiezen: true, mail: b.mail !== false }); return json(res, 200, r); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const wijzigLinkMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/(wijziglink|dossierlink)$/);
  if (wijzigLinkMatch && m === 'POST') {
    const code = zorgWijzigCode(wijzigLinkMatch[1]);
    return code ? json(res, 200, { link: dossierUrl(req, code) }) : json(res, 404, { error: 'Klant niet gevonden' });
  }
  const annuleerMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/annuleer$/);
  if (annuleerMatch && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    try { const r = await annuleerAfspraak(annuleerMatch[1], 'jou', req, String(b.reden || '').trim().slice(0, 500)); return json(res, 200, r); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  const ofVerstuurMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/offerte\/([A-Za-z0-9_-]{1,40})\/verstuur$/);
  if (ofVerstuurMatch && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    try { const r = await verstuurOfferte(ofVerstuurMatch[1], ofVerstuurMatch[2], req, { bericht: b.bericht }); return json(res, 200, r); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }
  // Bijlages op de fiche (factuur, contract, ander) — het bestand zelf komt binnen via /api/upload.
  const bijlageMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/bijlage(?:\/([a-f0-9]{32}))?$/);
  if (bijlageMatch && m === 'POST' && !bijlageMatch[2]) {
    const k = store.get('klanten', bijlageMatch[1]); if (!k) return json(res, 404, { error: 'Klant niet gevonden' });
    const b = await readJson(req, 10e3).catch(() => ({}));
    const best = bestandOpSchijf(String(b.id || '')); if (!best) return json(res, 400, { error: 'Bestand niet gevonden' });
    const soort = ['factuur', 'contract', 'offerte', 'ander'].includes(b.soort) ? b.soort : 'ander';
    k.bijlages = (k.bijlages || []).filter(f => f.id !== b.id).concat([{ id: b.id, naam: String(b.naam || best.naam).slice(0, 200), type: best.type, soort, d: vandaagBE() }]);
    if (soort === 'contract') { k.contract = Object.assign({}, k.contract, { bestandId: b.id }); delete k.contract.getekend; }
    logboek(k, `Bijlage toegevoegd (${soort}): ${b.naam || best.naam}`, 'bijlage'); store.set('klanten', bijlageMatch[1], k);
    return json(res, 200, { ok: true });
  }
  if (bijlageMatch && m === 'DELETE' && bijlageMatch[2]) {
    const k = store.get('klanten', bijlageMatch[1]); if (!k) return json(res, 404, { error: 'Klant niet gevonden' });
    const f = (k.bijlages || []).find(x => x.id === bijlageMatch[2]);
    if (k.contract && k.contract.bestandId === bijlageMatch[2]) { if (k.contract.getekend) return json(res, 400, { error: 'Dit contract is al getekend en kan niet verwijderd worden.' }); delete k.contract.bestandId; }
    k.bijlages = (k.bijlages || []).filter(x => x.id !== bijlageMatch[2]);
    if (f && f.soort !== 'contract_getekend') { for (const x of fs.readdirSync(UPLOAD_DIR)) if (x.startsWith(bijlageMatch[2])) try { fs.unlinkSync(path.join(UPLOAD_DIR, x)); } catch (e) {} }
    store.set('klanten', bijlageMatch[1], k);
    return json(res, 200, { ok: true });
  }
  const voorschotMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/voorschot$/);
  if (voorschotMatch && m === 'POST') {
    const k = store.get('klanten', voorschotMatch[1]); if (!k) return json(res, 404, { error: 'Klant niet gevonden' });
    const b = await readJson(req, 10e3).catch(() => ({}));
    k.voorschot = { betaald: !!b.betaald, op: b.betaald ? (String(b.op || '').slice(0, 10) || vandaagBE()) : '', bedrag: String(b.bedrag || '').slice(0, 20) };
    logboek(k, b.betaald ? `Voorschot betaald${k.voorschot.bedrag ? ' (' + k.voorschot.bedrag + ')' : ''}` : 'Voorschot op "niet betaald" gezet', 'betaling'); store.set('klanten', voorschotMatch[1], k);
    return json(res, 200, { ok: true, voorschot: k.voorschot });
  }
  // Na goedkeuring: voorschotfactuur + contract als bijlage, met dossierlink voor vragenlijst en handtekening.
  const naMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/na-goedkeuring$/);
  if (naMatch && m === 'POST') {
    const k = store.get('klanten', naMatch[1]); if (!k) return json(res, 404, { error: 'Klant niet gevonden' });
    if (!k.email) return json(res, 400, { error: 'Deze klant heeft geen e-mailadres op de fiche.' });
    if (!mailActief()) return json(res, 400, { error: 'E-mail is niet ingesteld (zie Koppelingen).' });
    const b = await readJson(req, 10e3).catch(() => ({}));
    const factuur = (k.bijlages || []).filter(f => f.soort === 'factuur'), contract = k.contract && k.contract.bestandId ? [{ id: k.contract.bestandId }] : [];
    const bijlagen = factuur.concat(contract).map(f => bijlageVan(f.id)).filter(Boolean);
    if (!k.wijzigCode) k.wijzigCode = crypto.randomBytes(9).toString('base64url');
    const basis = mailBasis(k, req, { bericht: String(b.bericht || '').trim(), heeftFactuur: factuur.length ? 'ja' : 'nee', heeftContract: contract.length ? 'ja' : 'nee' });
    const mm = bouwMail(sjablonen().naGoedkeuringKlant, basis, { dossierlink: dossierKnop(req, k, 'Vragenlijst invullen & contract tekenen') });
    const r = await verstuurMail({ to: k.email, subject: 'Volgende stap: voorschot, contract en vragenlijst – justPIXIT', text: mm.text, html: mm.html, attachments: bijlagen }, { soort: 'na goedkeuring (voorschot/contract/vragenlijst)' });
    if (!r.ok) return json(res, 502, { error: 'Mail versturen mislukt: ' + r.error });
    k.naGoedkeuringVerstuurdOp = vandaagBE(); if (contract.length) k.contract.verstuurdOp = vandaagBE();
    logboek(k, `Voorschotfactuur, contract en vragenlijst gemaild naar ${k.email} (${bijlagen.length} bijlage${bijlagen.length === 1 ? '' : 'n'})`, 'offerte');
    store.set('klanten', naMatch[1], k);
    return json(res, 200, { ok: true, bijlagen: bijlagen.length });
  }
  const portaalMatch = p.match(/^\/api\/klant\/([A-Za-z0-9_\-.~:@+]{1,200})\/portaaltoegang$/);
  if (portaalMatch && m === 'GET') {
    const u = gebruikerViaKlant(portaalMatch[1]);
    return json(res, 200, { heeftToegang: !!u, actief: !!(u && u.hash), email: u ? u.email : '', laatstIngelogd: (u && u.laatstIngelogd) || '' });
  }
  if (portaalMatch && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    try { const r = await geefPortaaltoegang(portaalMatch[1], req, { mail: !!b.mail }); return json(res, 200, r); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
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
      if (GESTOPT.has(k.fase) || !k.kennismaking || k.kennismaking.slice(0, 10) < vd) continue;
      try { const id = (await graph.zetAfspraak(msDoc(), k, boekingConfig().duur || 60)).id; const kk = store.get('klanten', k.id); if (kk) { kk.msEventId = id; store.set('klanten', k.id, kk); } n++; } catch (e) { fouten++; }
    }
    const nw = graph.nieuwRefreshToken(); if (nw) { const m2 = msDoc(); m2.refreshToken = nw; store.set('instellingen', 'ms', m2); }
    return json(res, 200, { ok: true, aantal: n, fouten });
  }
  if (p === '/api/zoom' && m === 'GET') { const z = zoomDoc(); return json(res, 200, { actief: zoomActief(), accountId: z.accountId || '', clientIdSet: !!z.clientId, secretSet: !!z.clientSecret }); }
  if (p === '/api/zoom' && m === 'POST') { const b = await readJson(req, 10e3).catch(() => ({})); const z = zoomDoc(); if ('accountId' in b) z.accountId = String(b.accountId || '').trim(); if ('clientId' in b) z.clientId = String(b.clientId || '').trim(); if (b.clientSecret) z.clientSecret = String(b.clientSecret).trim(); store.set('instellingen', 'zoom', z); return json(res, 200, { ok: true }); }
  if (p === '/api/zoom/ontkoppel' && m === 'POST') { store.set('instellingen', 'zoom', {}); return json(res, 200, { ok: true }); }
  if (p === '/api/zoom/test' && m === 'POST') { if (!zoomActief()) return json(res, 400, { error: 'Vul eerst de Zoom-gegevens in.' }); try { await zoom.test(zoomDoc()); return json(res, 200, { ok: true, detail: 'Zoom-verbinding werkt.' }); } catch (e) { return json(res, 502, { error: e.message }); } }
  if (p === '/api/facturatie' && m === 'GET') return json(res, 200, { verkoper: verkoperDoc(), klaar: verkoperKlaar() });
  if (p === '/api/maillog' && m === 'GET') { const d = store.get('instellingen', 'maillog') || { items: [] }; return json(res, 200, { items: d.items || [], actief: mailActief() }); }
  if (p === '/api/mailtest' && m === 'POST') {
    const b = await readJson(req, 10e3).catch(() => ({}));
    const naar = String(b.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(naar)) return json(res, 400, { error: 'Vul een geldig e-mailadres in.' });
    const alg = instellingen();
    const r = await verstuurMail({ to: naar, subject: 'Testmail van justPIXIT Studio', text: 'Dit is een testmail van justPIXIT Studio.\n\nAls je dit ontvangt, werkt je e-mailkoppeling.\n\n' + (alg.afzender || 'justPIXIT') }, { soort: 'test' });
    return r.ok ? json(res, 200, { ok: true }) : json(res, 502, { error: r.error || 'Versturen mislukt' });
  }
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
    if (m === 'PUT' || m === 'PATCH') {
      const body = await readJson(req).catch(() => null); if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Ongeldig document' });
      const oud = store.get(col, id);
      let nieuw = body;
      if (col === 'klanten' && oud) nieuw = mergeKlantSchrijf(oud, body, m === 'PATCH');
      else if (m === 'PATCH') nieuw = Object.assign({}, oud || {}, body);
      store.set(col, id, nieuw);
      const rev = nieuw.rev;
      // Kennismaking manueel aangepast in de fiche → Outlook/Teams en Zoom laten volgen (achtergrond, resultaat in logboek).
      if (col === 'klanten' && oud && (oud.kennismaking || '') !== (nieuw.kennismaking || '') && nieuw.kennismaking && !GESTOPT.has(nieuw.fase)) {
        syncAgenda(id).then(problemen => { if (!problemen.length) return; const k2 = store.get('klanten', id); if (!k2) return; const ts = new Date().toISOString(); k2.logboek = (k2.logboek || []).concat(problemen.map(t => ({ d: vandaagBE(), t, s: 'afspraak', ts }))); store.set('klanten', id, k2); }).catch(e => console.error('[agenda]', e.message));
      }
      return json(res, 200, { ok: true, rev });
    }
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
    if (p === '/app' || p === '/app/') return serveFile(res, path.join(PUBLIC_DIR, 'app.html'), { 'Cache-Control': 'no-store' });
    if (p === '/afspraak' || p === '/afspraak/' || p === '/boek') return serveFile(res, path.join(PUBLIC_DIR, 'afspraak.html'), { 'Cache-Control': 'no-store' });
    if (p === '/dossier' || p === '/dossier/' || p === '/afspraak/wijzig' || p === '/afspraak/wijzig/') return serveFile(res, path.join(PUBLIC_DIR, 'dossier.html'), { 'Cache-Control': 'no-store' }); // klantflow met persoonlijke code (zonder login)
    if (p === '/' || p === '/login' || p === '/login/') return serveFile(res, path.join(PUBLIC_DIR, 'login.html'), { 'Cache-Control': 'no-store' }); // één inlogpagina (admin of klant)
    if (p === '/mijn' || p === '/mijn/') return serveFile(res, path.join(PUBLIC_DIR, 'portaal.html'), { 'Cache-Control': 'no-store' });
    if (p === '/wachtwoord' || p === '/wachtwoord/') return serveFile(res, path.join(PUBLIC_DIR, 'wachtwoord.html'), { 'Cache-Control': 'no-store' }); // wachtwoord instellen via uitnodigingslink
    const blob = p.match(/^\/_blob\/([a-f0-9]{32})$/);
    if (blob) {
      if (!authedAdmin(req)) return text(res, 401, 'Niet aangemeld');
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
