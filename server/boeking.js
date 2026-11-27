// Beschikbaarheid en vrije tijdsloten voor de publieke boekingspagina('s).
// Alle datums/tijden zijn Belgische lokale tijd als tekst ('YYYY-MM-DD', 'HH:MM'); de server mag in UTC draaien.
//
// Een "event" is een type afspraak met een eigen link (/afspraak/<id>). Elk event heeft:
//  - regels: terugkerende beschikbaarheid, bv. { dag:3, interval:2, vanafDatum:'2026-01-07', van:'09:30', tot:'12:00' }
//            dag 0=zondag..6=zaterdag; interval = om de hoeveel weken (1 = elke week); vanafDatum = ankerweek voor het interval.
//  - uitzonderingen: per datum, { datum:'2026-12-24', modus:'dicht' } sluit die dag,
//                    of { datum:'2026-12-20', modus:'open', van:'10:00', tot:'14:00' } opent die dag extra.

function eventDefaults() {
  return {
    id: 'kennismaking',
    actief: true,
    titel: 'Kennismakingsgesprek',
    intro: 'In een vrijblijvend gesprek van een uurtje bekijken we jullie wensen voor de uitnodigingen of het geboortekaartje, en hoe ik daar iets unieks van maak.',
    locatie: 'Online via videocall, of bij mij thuis',
    duur: 60,          // minuten
    buffer: 15,        // minuten pauze tussen twee gesprekken
    kantoor: true,     // afspraak op kantoor / in persoon aanbieden
    kantoorNaam: 'Kantoor justPIXIT',
    videoTeams: false,
    videoZoom: false,
    minUren: 48,       // minimaal zoveel uur op voorhand
    maxWeken: 8,
    regels: [
      { dag: 1, interval: 1, vanafDatum: '', van: '09:30', tot: '12:00' },
      { dag: 2, interval: 1, vanafDatum: '', van: '09:30', tot: '12:00' },
      { dag: 3, interval: 1, vanafDatum: '', van: '09:30', tot: '12:00' },
      { dag: 4, interval: 1, vanafDatum: '', van: '09:30', tot: '12:00' },
      { dag: 2, interval: 1, vanafDatum: '', van: '19:00', tot: '21:30' },
    ],
    uitzonderingen: [], // [{datum, modus:'dicht'} | {datum, modus:'open', van, tot}]
    types: ['Huwelijk', 'Geboorte', 'Ander'],
    vragen: ['Hoe hebben jullie justPIXIT gevonden?'],
    bevestiging: 'Bedankt voor jullie aanvraag! Jullie afspraak staat vast. Ik kijk ernaar uit om jullie te leren kennen.',
    afzender: 'Liesbeth · justPIXIT',
  };
}

// Oude losse config (één boekingspagina) — enkel nog voor migratie.
function boekingDefaults() {
  return {
    actief: true, titel: 'Kennismakingsgesprek',
    intro: eventDefaults().intro, locatie: 'Online via videocall, of bij mij thuis',
    duur: 60, buffer: 15, videoTeams: false, videoZoom: false,
    dagen: { 1: true, 2: true, 3: true, 4: true, 5: false, 6: false, 0: false },
    blokken: [{ van: '09:30', tot: '12:00' }, { van: '19:00', tot: '21:30' }],
    minUren: 48, maxWeken: 8, geblokkeerd: [],
    types: ['Huwelijk', 'Geboorte', 'Ander'], vragen: ['Hoe hebben jullie justPIXIT gevonden?'],
    bevestiging: eventDefaults().bevestiging, afzender: 'Liesbeth · justPIXIT',
  };
}

const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const toHM = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
function dagenTussen(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function abs(dt) { return Math.round(Date.parse(dt.slice(0, 10) + 'T' + dt.slice(11, 16) + ':00Z') / 60000); }

function nuBrussel() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Brussels', hour12: false });
  return s.slice(0, 16).replace(' ', 'T');
}

// Migreer één oude boeking-config naar een event.
function migreerBoekingNaarEvent(b) {
  const regels = [];
  for (const d of [1, 2, 3, 4, 5, 6, 0]) if (b.dagen && b.dagen[d]) for (const blk of b.blokken || []) if (blk && blk.van && blk.tot) regels.push({ dag: d, interval: 1, vanafDatum: '', van: blk.van, tot: blk.tot });
  const uitzonderingen = [];
  for (const g of b.geblokkeerd || []) {
    const s = String(g).trim(); if (!s) continue;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*|\s*-\s*|\s+tot\s+)(\d{4}-\d{2}-\d{2})$/);
    if (m) { let d = m[1], guard = 0; while (d <= m[2] && guard++ < 400) { uitzonderingen.push({ datum: d, modus: 'dicht' }); d = addDays(d, 1); } }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) uitzonderingen.push({ datum: s, modus: 'dicht' });
  }
  return Object.assign(eventDefaults(), {
    id: 'kennismaking', actief: b.actief !== false, titel: b.titel, intro: b.intro, locatie: b.locatie,
    duur: b.duur, buffer: b.buffer, minUren: b.minUren, maxWeken: b.maxWeken, videoTeams: b.videoTeams, videoZoom: b.videoZoom,
    types: b.types, vragen: b.vragen, bevestiging: b.bevestiging, afzender: b.afzender, regels, uitzonderingen,
  });
}

// Alle events (met defaults aangevuld). Migreert de oude losse config als er nog geen events zijn.
function eventsVan(instellingen) {
  const evs = instellingen && Array.isArray(instellingen.events) ? instellingen.events : null;
  if (evs && evs.length) return evs.map(e => Object.assign(eventDefaults(), e));
  const b = Object.assign({}, boekingDefaults(), (instellingen && instellingen.boeking) || {});
  return [migreerBoekingNaarEvent(b)];
}

// Geldt deze regel op dag d (rekening houdend met het interval en de ankerdatum)?
function regelGeldt(regel, d) {
  if (weekday(d) !== Number(regel.dag)) return false;
  const interval = Math.max(1, Number(regel.interval) || 1);
  if (interval === 1) return true;
  let anker = /^\d{4}-\d{2}-\d{2}$/.test(regel.vanafDatum || '') ? regel.vanafDatum : d;
  let guard = 0; while (weekday(anker) !== Number(regel.dag) && guard++ < 7) anker = addDays(anker, 1);
  if (d < anker) return false;
  const weken = Math.round(dagenTussen(anker, d) / 7);
  return weken >= 0 && weken % interval === 0;
}

// Beschikbare tijdsblokken ([{van,tot}]) op dag d voor dit event.
function dagBlokken(ev, d) {
  let ranges = [];
  for (const r of ev.regels || []) if (r && r.van && r.tot && regelGeldt(r, d)) ranges.push({ van: r.van, tot: r.tot });
  let gesloten = false;
  for (const u of ev.uitzonderingen || []) {
    if (!u || u.datum !== d) continue;
    if (u.modus === 'dicht') gesloten = true;
    else if (u.modus === 'open' && u.van && u.tot) ranges.push({ van: u.van, tot: u.tot });
  }
  if (gesloten) return [];
  return ranges;
}

// Geeft [{datum, slots:['YYYY-MM-DDTHH:MM', ...]}] voor de komende ev.maxWeken weken.
// Werkt met het nieuwe event-model (ev.regels); valt terug op het oude model (ev.dagen/blokken) voor compat.
function slotsVoorPeriode(ev, bezet = [], nu = nuBrussel()) {
  const duur = Math.max(15, Number(ev.duur) || 60), buffer = Math.max(0, Number(ev.buffer) || 0);
  const stap = duur + buffer;
  const vroegst = abs(nu) + (Number(ev.minUren) || 0) * 60;
  const vandaag = nu.slice(0, 10);
  const laatste = addDays(vandaag, 7 * (Number(ev.maxWeken) || 8));
  const bezetAbs = bezet.filter(b => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b)).map(b => abs(b));
  const botst = start => bezetAbs.some(b => start < b + duur + buffer && b < start + duur + buffer);
  const nieuwModel = Array.isArray(ev.regels);
  const out = [];
  for (let d = vandaag; d <= laatste; d = addDays(d, 1)) {
    const blokken = nieuwModel ? dagBlokken(ev, d) : oudeDagBlokken(ev, d);
    if (!blokken.length) continue;
    const slots = [];
    for (const b of blokken) {
      if (!b || !b.van || !b.tot) continue;
      for (let t = toMin(b.van); t + duur <= toMin(b.tot); t += stap) {
        const dt = d + 'T' + toHM(t);
        const a = abs(dt);
        if (a < vroegst) continue;
        if (botst(a)) continue;
        if (!slots.includes(dt)) slots.push(dt);
      }
    }
    slots.sort();
    if (slots.length) out.push({ datum: d, slots });
  }
  return out;
}

// Oude model (één set dagen + blokken + geblokkeerd) — fallback.
function oudeDagBlokken(cfg, d) {
  if (!cfg.dagen || !cfg.dagen[weekday(d)]) return [];
  for (const raw of cfg.geblokkeerd || []) {
    const s = String(raw).trim(); if (!s) continue;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*|\s*-\s*|\s+tot\s+)(\d{4}-\d{2}-\d{2})$/);
    if (m) { if (d >= m[1] && d <= m[2]) return []; }
    else if (s === d) return [];
  }
  return (cfg.blokken || []).filter(b => b && b.van && b.tot);
}

module.exports = { eventDefaults, boekingDefaults, eventsVan, migreerBoekingNaarEvent, slotsVoorPeriode, regelGeldt, dagBlokken, nuBrussel };
