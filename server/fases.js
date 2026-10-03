// Fasen van het traject (zelfde volgorde als in app.html) met een korte uitleg voor de klant in het portaal.
const FASES = [
  { k: 'ingepland',       l: 'Kennismaking ingepland',  klant: 'Jullie kennismakingsgesprek staat gepland. We bekijken samen jullie wensen en ideeën.' },
  { k: 'gehad',           l: 'Kennismaking gehad',      klant: 'We hebben elkaar gesproken. Ik werk nu een voorstel op maat uit.' },
  { k: 'offerte',         l: 'Offerte verstuurd',       klant: 'De offerte zit in jullie mailbox. Neem rustig de tijd om ze te bekijken.' },
  { k: 'opvolging',       l: 'Opvolging offerte',       klant: 'Ik volg de offerte even op. Vragen of aanpassingen? Laat het gerust weten.' },
  { k: 'goedgekeurd',     l: 'Goedgekeurd · vragenlijst', klant: 'Fijn dat jullie voor justPIXIT kiezen! Vul de vragenlijst in, dan kan ik het ontwerp inplannen.' },
  { k: 'ontwerp_gepland', l: 'Ontwerp ingepland',       klant: 'Jullie ontwerp staat ingepland. Ik laat weten wanneer de eerste proef klaar is.' },
  { k: 'ontwerp_bezig',   l: 'Ontwerp in progress',     klant: 'Ik ben volop aan het ontwerpen.' },
  { k: 'proef_digitaal',  l: 'Digitale proef',          klant: 'De digitale proef is onderweg of bij jullie. Bekijk ze goed en geef jullie feedback door.' },
  { k: 'proefdruk',       l: 'Proefdruk besteld',       klant: 'De proefdruk is besteld. Zo zien we het echte papier en de kleuren.' },
  { k: 'drukwerk',        l: 'Drukwerk besteld',        klant: 'Het drukwerk is besteld. Nog even geduld, dan is het bij jullie.' },
  { k: 'afgerond',        l: 'Afgerond',                klant: 'Alles is geleverd. Bedankt voor het vertrouwen!' },
  { k: 'geen_deal',       l: 'Niet doorgegaan',         klant: 'Dit traject is niet verdergezet. Jullie zijn altijd welkom voor een nieuw project.' },
];
const FI = Object.fromEntries(FASES.map((f, i) => [f.k, i]));

// Status per fase voor een klant: done / cur / todo (geen_deal wordt enkel getoond als dat de huidige fase is).
function fasenVoor(klant) {
  const cur = FI[klant.fase] ?? 0, fd = klant.faseDatums || {};
  return FASES.filter(f => f.k !== 'geen_deal' || klant.fase === 'geen_deal').map((f, i) => {
    const idx = FI[f.k];
    const st = klant.fase === 'geen_deal' ? (f.k === 'geen_deal' ? 'cur' : (fd[f.k] ? 'done' : 'todo')) : (idx < cur ? 'done' : idx === cur ? 'cur' : 'todo');
    return { k: f.k, l: f.l, uitleg: f.klant, status: st, datum: fd[f.k] || '' };
  });
}

module.exports = { FASES, FI, fasenVoor };
