// Modules van de applicatie. Elke rol krijgt een lijst van modules die ze mag zien; zo kan je later pakketten
// (basis / complete / all-in) samenstellen door rollen met een andere moduleset te maken.
const BEHEER_MODULES = [
  { id: 'vandaag', label: 'Vandaag', uitleg: 'Dashboard met wat er vandaag moet gebeuren' },
  { id: 'pipeline', label: 'Pipeline', uitleg: 'Overzicht van alle klanten per fase' },
  { id: 'klanten', label: 'Klanten', uitleg: 'Klantenlijst en klantfiches' },
  { id: 'gebruikers', label: 'Gebruikersbeheer', uitleg: 'Gebruikers en rollen beheren' },
  { id: 'beheer', label: 'Beheer', uitleg: 'Instellingen, mailteksten, afspraken' },
  { id: 'koppelingen', label: 'Koppelingen', uitleg: 'E-mail, WhatsApp, Office 365, Zoom, facturatie' },
];
const PORTAAL_MODULES = [
  { id: 'p_afspraak', label: 'Afspraak', uitleg: 'Kennismaking bekijken en verplaatsen' },
  { id: 'p_offertes', label: 'Offertes', uitleg: 'Offertes bekijken en goedkeuren' },
  { id: 'p_traject', label: 'Traject', uitleg: 'Fase van het project volgen' },
  { id: 'p_vragenlijst', label: 'Vragenlijst', uitleg: 'Vragenlijst invullen en nalezen' },
  { id: 'p_contract', label: 'Contract', uitleg: 'Contract bekijken en tekenen' },
  { id: 'p_bijlages', label: 'Bijlages', uitleg: 'Offerte, factuur, contract downloaden' },
  { id: 'p_gegevens', label: 'Gegevens', uitleg: 'Eigen gegevens aanpassen' },
];
const ALLE_MODULES = BEHEER_MODULES.concat(PORTAAL_MODULES);
const MODULE_IDS = new Set(ALLE_MODULES.map(m => m.id));
const standaardModules = (beheer, portaal) => (beheer ? BEHEER_MODULES.map(m => m.id) : []).concat(portaal ? PORTAAL_MODULES.map(m => m.id) : []);

module.exports = { BEHEER_MODULES, PORTAAL_MODULES, ALLE_MODULES, MODULE_IDS, standaardModules };
