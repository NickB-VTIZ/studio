// iCalendar-feed (.ics) van de kennismakingsgesprekken, zodat Office 365 / Outlook de afspraken
// kan binnenhalen via "Agenda toevoegen → Van internet". Alle tijden in Europe/Brussels.
const crypto = require('crypto');

function nieuwToken() { return crypto.randomBytes(18).toString('hex'); }

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const pad = n => String(n).padStart(2, '0');
function wall(dt) { // 'YYYY-MM-DDTHH:MM' → 'YYYYMMDDTHHMMSS'
  const d = dt.slice(0, 10).replace(/-/g, ''); const t = (dt.slice(11, 16) || '00:00').replace(':', '') + '00'; return d + 'T' + t;
}
function plusMin(dt, min) {
  const [y, mo, d] = dt.slice(0, 10).split('-').map(Number);
  const [h, mi] = (dt.slice(11, 16) || '00:00').split(':').map(Number);
  const base = Date.UTC(y, mo - 1, d, h, mi) + min * 60000; const x = new Date(base);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`;
}
const stamp = () => { const x = new Date(); return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`; };

const VTZ = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Brussels',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

// klanten: lijst met {id,naam,kennismaking,fase,email,telefoon,type,locatie}. duur in minuten.
function bouwFeed(klanten, duur = 60) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//justPIXIT//Studio//NL', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:justPIXIT afspraken', 'X-WR-TIMEZONE:Europe/Brussels', ...VTZ];
  for (const k of klanten) {
    if (!k.kennismaking || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(k.kennismaking)) continue;
    if (k.fase === 'geen_deal') continue;
    const desc = [k.type ? 'Type: ' + k.type : '', k.email ? 'E-mail: ' + k.email : '', k.telefoon ? 'Tel: ' + k.telefoon : ''].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',
      'UID:' + k.id + '@justpixit',
      'DTSTAMP:' + stamp(),
      'DTSTART;TZID=Europe/Brussels:' + wall(k.kennismaking),
      'DTEND;TZID=Europe/Brussels:' + plusMin(k.kennismaking, duur),
      'SUMMARY:' + esc('Kennismaking · ' + (k.naam || 'Klant')),
      k.locatie ? 'LOCATION:' + esc(k.locatie) : 'LOCATION:',
      'DESCRIPTION:' + esc(desc),
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { bouwFeed, nieuwToken };
