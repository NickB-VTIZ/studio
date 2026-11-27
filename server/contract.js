// Ingebouwd contract (samenwerkingsvoorwaarden) — standaardtekst + helpers.
// De tekst is bewerkbaar in Beheer → Contract (opgeslagen in instellingen/algemeen.contract).
// Velden per klant (naam, adres, offertenummer, …) zitten in k.contract.

const CONTRACT_DEFAULTS = {
  titel: 'VOORWAARDEN',
  bedrijfNaam: 'JUSTPIXIT COMMV',
  bedrijfAdres: 'Groenhuis 17\n2440 Geel\nBelgië',
  bedrijfBtw: 'BTW 0783257776',
  verVoornaam: 'Liesbeth',
  verNaam: 'Boeckx',
  aantalOndertekenaars: 2,
  handtekeningId: '',
  logoId: '',
  voettekst: 'liesbeth@justpixit.be · 0456 03 77 97 · justpixit.be · @justpixit.be',
  introTitel: 'Bedankt voor jullie vertrouwen!',
  introTekst:
    'Wow! Ik ben heel blij dat ik mee jullie **concept voor deze bijzondere gebeurtenis** mag uitwerken. Ik kijk er alvast naar uit om iets persoonlijks en unieks te maken.\n\n' +
    '**Goede afspraken maken goede vrienden.** Open en eerlijke communicatie vind ik heel belangrijk. Daarom zet ik onze afspraken graag op papier: zo weten jullie wat je van mij kan verwachten en wat ik van jullie verwacht.\n\n' +
    'Met jullie handtekening op de offerte en op de laatste pagina gaan jullie akkoord met deze afspraken en de afgesproken prijs. Vragen? Contacteer me gerust!',
  ondertekenTekst:
    'Met jullie handtekening verklaren jullie deze samenwerkingsvoorwaarden en de bijhorende offerte gelezen te hebben en ermee akkoord te gaan.',
  fotoVinkje: "Ja, justPIXIT mag ook foto's delen waarop wij of ons kindje te zien zijn.",
  secties: [
    { titel: '1. De opdracht', tekst:
      'justPIXIT CommV ontwerpt en levert een totaalconcept voor jullie geboorte, huwelijk of feest. Wat er precies in zit, staat in detail in de offerte. De offerte is 30 dagen geldig. **De ondertekende offerte en deze voorwaarden samen gelden als opdrachtbevestiging.**' },
    { titel: '2. Voorschot en betaling', tekst:
      '- Bij de bevestiging betalen jullie **een voorschot van 25%** van het totaalbedrag. **Pas als het voorschot ontvangen is, start ik met ontwerpen** en ligt jullie plekje in mijn planning vast.\n' +
      '- Het resterende bedrag factureer ik bij de oplevering. **Alle facturen betalen jullie binnen 15 dagen na factuurdatum.**\n' +
      '- Wordt een factuur niet op tijd betaald, dan stuur ik eerst een kosteloze herinnering. Blijft de betaling daarna uit, dan kan ik de wettelijke intresten en een schadevergoeding aanrekenen, binnen de grenzen van de wet.' },
    { titel: '3. Ontwerp en revisies', tekst:
      '- Elk ontwerp start van een wit blad, volledig op maat van jullie verhaal.\n' +
      '- Jullie hebben **recht op 5 revisies** binnen de oorspronkelijke opdracht. **Extra revisies reken ik aan aan 65 euro per uur (excl. btw).** Ik laat dit altijd eerst weten.\n' +
      "- Jullie bezorgen teksten, namen, datums en foto's op tijd. Komt informatie later dan afgesproken, dan kan de planning opschuiven.\n" +
      '- Voor foto\'s of beelden die jullie aanleveren, zorgen jullie dat jullie ze mogen gebruiken.\n\n' +
      'Een revisie is een volledig nieuw ontwerp. Kleine aanpassingen aan kleur, lettertype of tekst tellen niet als revisie.' },
    { titel: '4. Proefdruk en goedkeuring', tekst:
      '- Vóór de definitieve druk krijgen jullie een proefdruk. Kijk die grondig na: namen, datums, uren, adressen, spelling en kleuren.\n' +
      '- **Na jullie goedkeuring van de proefdruk kan het ontwerp niet meer gewijzigd worden.** Fouten die op de goedgekeurde proef staan, vallen onder jullie verantwoordelijkheid. Een herdruk is dan op jullie kosten.\n' +
      '- Kleuren op een scherm zien er anders uit dan op papier, en tussen drukken onderling kunnen kleine kleurverschillen zitten. Dat is geen fout.' },
    { titel: '5. Aantallen en wijzigingen', tekst:
      'Ik druk niet zelf, maar werk samen met zorgvuldig gekozen drukkerijen en leveranciers. Daarom gelden deze uiterste termijnen om aantallen of keuzes te wijzigen:\n\n' +
      '- **Drukwerk:** tot jullie het akkoord geven om te drukken. Daarna liggen de aantallen vast.\n' +
      '- **Doopsuiker / bedankjes:** geboorte 4 weken voor de uitgerekende datum, huwelijk 4 weken voor de huwelijksdatum.\n' +
      '- **Gepersonaliseerde producten:** 2 weken voor de afgesproken leverdatum.\n\n' +
      'Later bijbestellen kan, aan de prijs van dat moment. Een kleine oplage is per stuk duurder, dus bestel liever enkele extra exemplaren.' },
    { titel: '6. Levering', tekst:
      '- De leverdatum spreken we samen af. Het is een richtdatum. Vertraging bij drukkerij, leverancier of post kan voorkomen. Dan breng ik jullie meteen op de hoogte.\n' +
      '- Komt de baby vroeger dan verwacht, dan doe ik mijn uiterste best om alles zo snel mogelijk klaar te hebben.\n' +
      '- Controleer jullie bestelling bij ontvangst. Is er iets beschadigd of anders gedrukt dan de goedgekeurde proef? Meld het **binnen 7 dagen, met een foto**. Dan zoeken we samen een oplossing.' },
    { titel: '7. Annulering', tekst:
      '- Omdat alles op maat gemaakt wordt, geldt er **geen herroepingsrecht** (bedenktijd van 14 dagen).\n' +
      '- Annuleren jullie na de bevestiging van de opdracht, dan is een annulatiebedrag verschuldigd van **25% van de totale kosten**. Het voorschot wordt hiervoor gebruikt. Dit dekt mijn tijdsinvestering.\n' +
      '- Zijn er al kosten gemaakt, zoals drukwerk, doopsuiker of materiaal voor bedankjes, dan worden die **bijkomend aangerekend**.' },
    { titel: '8. Auteursrechten', tekst:
      'Alle auteursrechten op de ontwerpen blijven **eigendom van justPIXIT CommV**. Jullie mogen de ontwerpen gebruiken voor persoonlijk gebruik, rond jullie eigen feest of geboorte. Verkopen, doorgeven of laten namaken mag niet.' },
    { titel: '9. Publicatie en privacy', tekst:
      '- justPIXIT mag concepten en definitieve ontwerpen tonen op sociale media en de website. **Namen, adressen en andere persoonlijke gegevens maak ik daarbij onherkenbaar.** Liever niet? **Laat het mij schriftelijk weten**, bijvoorbeeld per mail.\n' +
      "- Foto's waarop jullie of jullie kindje te zien zijn, deel ik alleen als jullie het vakje op de laatste pagina aankruisen.\n" +
      '- Jullie gegevens gebruik ik alleen voor deze opdracht en de facturatie. Ik geef ze enkel door aan de drukkerij of leverancier die ze nodig heeft.' },
    { titel: '10. Aansprakelijkheid, overmacht en geschillen', tekst:
      '- Ik werk met de grootste zorg. Gaat er toch iets mis door mijn fout, dan is mijn aansprakelijkheid beperkt tot het bedrag van de opdracht.\n' +
      '- justPIXIT CommV is niet aansprakelijk voor vertraging of tekortkomingen door omstandigheden buiten mijn controle, zoals ziekte, natuurrampen, pandemieën, stakingen of problemen bij een leverancier. We zoeken dan samen naar een oplossing.\n' +
      '- Bij een probleem zoeken we altijd eerst samen naar een oplossing. Op deze overeenkomst is het Belgisch recht van toepassing.' },
  ],
};

// Haalt het contract-sjabloon op: standaard, overschreven met wat in instellingen staat.
function contractTemplate(instellingen) {
  const c = JSON.parse(JSON.stringify(CONTRACT_DEFAULTS));
  const s = instellingen && instellingen.contract;
  if (s && typeof s === 'object') {
    for (const k of ['titel', 'bedrijfNaam', 'bedrijfAdres', 'bedrijfBtw', 'verVoornaam', 'verNaam', 'handtekeningId', 'logoId', 'voettekst', 'introTitel', 'introTekst', 'ondertekenTekst', 'fotoVinkje'])
      if (typeof s[k] === 'string') c[k] = s[k];
    const aO = Number(s.aantalOndertekenaars); if (aO === 1 || aO === 2) c.aantalOndertekenaars = aO;
    if (Array.isArray(s.secties)) c.secties = s.secties.filter(x => x && typeof x === 'object').map(x => ({ titel: String(x.titel || ''), tekst: String(x.tekst || '') }));
  }
  return c;
}

// Alle bestand-id's die bij het contract horen (handtekening admin, logo, handtekeningen klant),
// zodat de klantflow (zonder login) ze mag ophalen.
function contractBestandIds(instellingen, k) {
  const ids = [];
  const t = contractTemplate(instellingen);
  if (t.handtekeningId) ids.push(t.handtekeningId);
  if (t.logoId) ids.push(t.logoId);
  const g = k && k.contract && k.contract.getekend;
  if (g && Array.isArray(g.ondertekenaars)) for (const o of g.ondertekenaars) if (o && o.handtekeningId) ids.push(o.handtekeningId);
  return ids;
}

module.exports = { CONTRACT_DEFAULTS, contractTemplate, contractBestandIds };
