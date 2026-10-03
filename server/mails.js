// Standaard mailteksten + placeholder-invuller. Templates zijn bewerkbaar in Beheer (instellingen/algemeen.mails).
// Knop-plaatshouders ({videolink}, {loginlink}, {portaallink}) worden in de HTML-mail een knop en mogen overal in het sjabloon staan.
const STANDAARD_MAILS = {
  boekingKlant: 'Hoi {voornaam},\n\n{bevestiging}\n\nWanneer: {wanneer} ({duur} min)\nWaar: {locatie}\n{videolink}\n\nMoet je de afspraak verplaatsen, of wil je volgen hoe ver we staan? Dat kan op jullie persoonlijke pagina:\n{portaallink}\n\nTot dan!\n{afzender}',
  boekingAdmin: 'Nieuwe afspraak via de website.\n\nKlant: {naam}\nWanneer: {wanneer}\nE-mail: {email}\nTelefoon: {telefoon}\nType: {type}\nDatum feest: {datumEvent}\n\nBericht:\n{bericht}\n{videolink}\n\nOpen de fiche: {app}',
  verplaatstKlant: 'Hoi {voornaam},\n\nJullie afspraak is verplaatst.\n\nNieuw moment: {wanneer} ({duur} min)\nVorig moment: {vorig}\nWaar: {locatie}\n{videolink}\n\nTot dan!\n{afzender}',
  verplaatstAdmin: 'Afspraak verplaatst door {door}.\n\nKlant: {naam}\nNieuw moment: {wanneer}\nVorig moment: {vorig}\nE-mail: {email}\n\nOpen de fiche: {app}',
  portaalLogin: 'Hoi {voornaam},\n\nMet de knop hieronder log je in op jullie persoonlijke pagina bij justPIXIT. Daar zien jullie de afspraak, kunnen jullie ze verplaatsen en volgen jullie hoe ver we staan.\n\n{loginlink}\n\nDe link werkt 30 minuten en is enkel voor jullie bedoeld.\n\n{afzender}',
};

// Vervangt {sleutel} door de waarde. Gekende sleutel met lege waarde → leeg; onbekende sleutel → ongewijzigd.
function vul(tekst, waarden) {
  return String(tekst || '').replace(/\{(\w+)\}/g, (m, k) => (k in waarden ? String(waarden[k] ?? '') : m));
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function knopHtml(url, label) {
  return '<a href="' + escHtml(url) + '" style="display:inline-block;background:#2C6A4C;color:#ffffff;text-decoration:none;'
    + 'padding:13px 24px;border-radius:10px;font-weight:600;font-size:15px;line-height:1;margin:4px 0">' + escHtml(label || 'Openen') + '</a>';
}

// Bouwt een HTML-mail uit hetzelfde tekstsjabloon. knoppen = { plaatshouder: {url,label} }; een plaatshouder zonder knop valt weg.
// Statische tekst en waarden worden ge-escaped; regeleindes worden <br>.
function vulHtml(tekst, waarden, knoppen = {}) {
  let s = escHtml(tekst).replace(/\{(\w+)\}/g, (m, k) => {
    if (k in knoppen) { const b = knoppen[k]; return b && b.url ? knopHtml(b.url, b.label) : ''; }
    if (!(k in waarden)) return m;
    return escHtml(waarden[k]).replace(/\n/g, '<br>');
  });
  s = s.replace(/\n/g, '<br>');
  return wrapMail(s);
}

function wrapMail(inner) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;background:#F7FAF6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1C2A24;line-height:1.55">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #DDE7E0;border-radius:14px;padding:28px 30px">'
    + '<div style="font-size:15px">' + inner + '</div></div></body></html>';
}

// Maakt tekst + HTML uit een sjabloon. Knoppen zonder plaatshouder in het sjabloon worden achteraan toegevoegd (behalve als `optioneel`).
function bouwMail(sjabloon, waarden, knoppen = {}, optioneel = []) {
  let t = String(sjabloon || '');
  for (const k in knoppen) if (knoppen[k] && knoppen[k].url && !t.includes('{' + k + '}') && !optioneel.includes(k)) t += '\n\n{' + k + '}';
  const w = Object.assign({}, waarden);
  for (const k in knoppen) w[k] = knoppen[k] && knoppen[k].url ? (knoppen[k].label + ': ' + knoppen[k].url) : '';
  return { text: vul(t, w), html: vulHtml(t, w, knoppen) };
}

module.exports = { STANDAARD_MAILS, vul, vulHtml, escHtml, bouwMail };
