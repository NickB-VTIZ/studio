// Beschikbaarheid en vrije tijdsloten voor de publieke boekingspagina.
// Alle datums/tijden zijn Belgische lokale tijd als tekst ('YYYY-MM-DD', 'HH:MM'); de server mag in UTC draaien.

function boekingDefaults() {
  return {
    actief: true,
    titel: 'Kennismakingsgesprek',
    intro: 'In een vrijblijvend gesprek van een uurtje bekijken we jullie wensen voor de uitnodigingen of het geboortekaartje, en hoe ik daar iets unieks van maak.',
    locatie: 'Online via videocall, of bij mij thuis',
    duur: 60,          // minuten
    buffer: 15,        // minuten pauze tussen twee gesprekken
    dagen: { 1: true, 2: true, 3: true, 4: true, 5: false, 6: false, 0: false }, // 0 = zondag
    blokken: [{ van: '09:30', tot: '12:00' }, { van: '19:00', tot: '21:30' }],
    minUren: 48,       // minimaal zoveel uur op voorhand
    maxWeken: 8,
    geblokkeerd: [],   // 'YYYY-MM-DD' of 'YYYY-MM-DD..YYYY-MM-DD'
    types: ['Huwelijk', 'Geboorte', 'Ander'],
    vragen: ['Hoe hebben jullie justPIXIT gevonden?'],
    bevestiging: 'Bedankt voor jullie aanvraag! Jullie afspraak staat vast. Ik kijk ernaar uit om jullie te leren kennen.',
    afzender: 'Liesbeth · justPIXIT',
  };
}

// 'YYYY-MM-DD HH:MM' in Brussel, ongeacht de tijdzone van de server.
function nuBrussel() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Brussels', hour12: false });
  return s.slice(0, 16).replace(' ', 'T'); // 'YYYY-MM-DDTHH:MM'
}
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const toHM = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
// Minuten sinds een vast nulpunt, zodat 'YYYY-MM-DDTHH:MM' vergelijkbaar is over dagen heen.
function abs(dt) { return Math.round(Date.parse(dt.slice(0, 10) + 'T' + dt.slice(11, 16) + ':00Z') / 60000); }

function geblokkeerdeDagen(cfg) {
  const set = new Set();
  for (const raw of cfg.geblokkeerd || []) {
    const s = String(raw).trim(); if (!s) continue;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*|\s*-\s*|\s+tot\s+)(\d{4}-\d{2}-\d{2})$/);
    if (m) { let d = m[1]; let guard = 0; while (d <= m[2] && guard++ < 400) { set.add(d); d = addDays(d, 1); } }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) set.add(s);
  }
  return set;
}

// Geeft [{datum, slots:['YYYY-MM-DDTHH:MM', ...]}] voor de komende cfg.maxWeken weken.
function slotsVoorPeriode(cfg, bezet = [], nu = nuBrussel()) {
  const duur = Math.max(15, Number(cfg.duur) || 60), buffer = Math.max(0, Number(cfg.buffer) || 0);
  const stap = duur + buffer;
  const vroegst = abs(nu) + (Number(cfg.minUren) || 0) * 60;
  const vandaag = nu.slice(0, 10);
  const laatste = addDays(vandaag, 7 * (Number(cfg.maxWeken) || 8));
  const blok = geblokkeerdeDagen(cfg);
  const bezetAbs = bezet.filter(b => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b)).map(b => abs(b));
  const botst = start => bezetAbs.some(b => start < b + duur + buffer && b < start + duur + buffer);
  const out = [];
  for (let d = vandaag; d <= laatste; d = addDays(d, 1)) {
    if (!cfg.dagen || !cfg.dagen[weekday(d)]) continue;
    if (blok.has(d)) continue;
    const slots = [];
    for (const b of cfg.blokken || []) {
      if (!b || !b.van || !b.tot) continue;
      for (let t = toMin(b.van); t + duur <= toMin(b.tot); t += stap) {
        const dt = d + 'T' + toHM(t);
        const a = abs(dt);
        if (a < vroegst) continue;
        if (botst(a)) continue;
        slots.push(dt);
      }
    }
    if (slots.length) out.push({ datum: d, slots });
  }
  return out;
}

module.exports = { boekingDefaults, slotsVoorPeriode, nuBrussel };
