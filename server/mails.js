// Standaard mailteksten + placeholder-invuller. Templates zijn bewerkbaar in Beheer (instellingen/algemeen.mails).
const STANDAARD_MAILS = {
  boekingKlant: 'Hoi {voornaam},\n\n{bevestiging}\n\nWanneer: {wanneer} ({duur} min)\nWaar: {locatie}\n\nTot dan!\n{afzender}',
  boekingAdmin: 'Nieuwe afspraak via de website.\n\nKlant: {naam}\nWanneer: {wanneer}\nE-mail: {email}\nTelefoon: {telefoon}\nType: {type}\nDatum feest: {datumEvent}\n\nBericht:\n{bericht}\n{videolink}\n\nOpen de fiche: {app}',
};

// Vervangt {sleutel} door de waarde. Gekende sleutel met lege waarde → leeg; onbekende sleutel → ongewijzigd.
function vul(tekst, waarden) {
  return String(tekst || '').replace(/\{(\w+)\}/g, (m, k) => (k in waarden ? String(waarden[k] ?? '') : m));
}

module.exports = { STANDAARD_MAILS, vul };
