// Standaard mailteksten + placeholder-invuller. Templates zijn bewerkbaar in Beheer (instellingen/algemeen.mails).
// {videolink} wordt in de HTML-mail een knop ("Deelnemen aan …") en mag overal in het sjabloon staan.
const STANDAARD_MAILS = {
  boekingKlant: 'Hoi {voornaam},\n\n{bevestiging}\n\nWanneer: {wanneer} ({duur} min)\nWaar: {locatie}\n{videolink}\n\nTot dan!\n{afzender}',
  boekingAdmin: 'Nieuwe afspraak via de website.\n\nKlant: {naam}\nWanneer: {wanneer}\nE-mail: {email}\nTelefoon: {telefoon}\nType: {type}\nDatum feest: {datumEvent}\n\nBericht:\n{bericht}\n{videolink}\n\nOpen de fiche: {app}',
};

// Vervangt {sleutel} door de waarde. Gekende sleutel met lege waarde → leeg; onbekende sleutel → ongewijzigd.
function vul(tekst, waarden) {
  return String(tekst || '').replace(/\{(\w+)\}/g, (m, k) => (k in waarden ? String(waarden[k] ?? '') : m));
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Bouwt een HTML-mail uit hetzelfde tekstsjabloon. {videolink} wordt een knop als er een link (knop) is.
// knop = { url, label } of null. Statische tekst en waarden worden ge-escaped; regeleindes worden <br>.
function vulHtml(tekst, waarden, knop) {
  let s = escHtml(tekst).replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'videolink') {
      if (!knop || !knop.url) return '';
      return '<a href="' + escHtml(knop.url) + '" style="display:inline-block;background:#2C6A4C;color:#ffffff;text-decoration:none;'
        + 'padding:13px 24px;border-radius:10px;font-weight:600;font-size:15px;line-height:1">' + escHtml(knop.label || 'Deelnemen') + '</a>';
    }
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

module.exports = { STANDAARD_MAILS, vul, vulHtml, escHtml };
