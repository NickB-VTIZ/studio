// Individuele tabs (beheer-kant en portaal-kant)
const BEHEER_TABS = [
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

// Modulegroepen: pakketten van tabs die aan rollen worden toegekend
const MODULE_GROEPEN = [
  { id: 'klantbeheer', label: 'Klantbeheer', uitleg: 'Klanten opvolgen: dagelijks overzicht, pipeline, klantenlijst en gebruikersbeheer',
    tabs: ['vandaag', 'pipeline', 'klanten', 'gebruikers'] },
  { id: 'beheer', label: 'Beheer', uitleg: 'Instellingen en koppelingen configureren',
    tabs: ['beheer', 'koppelingen'] },
];
const GROEP_IDS = new Set(MODULE_GROEPEN.map(g => g.id));

// Zet een lijst van groep-IDs om naar de individuele tab-IDs
function groepNaarTabs(groepIds) {
  const tabs = new Set();
  for (const gid of groepIds) {
    const g = MODULE_GROEPEN.find(m => m.id === gid);
    if (g) g.tabs.forEach(t => tabs.add(t));
  }
  return [...tabs];
}

// Tab-labels opzoeken (voor weergave)
const TAB_MAP = new Map(BEHEER_TABS.map(t => [t.id, t]));

// Legacy exports (BEHEER_MODULES alias) + nieuwe groep-exports
const BEHEER_MODULES = BEHEER_TABS;
const ALLE_MODULES = BEHEER_TABS.concat(PORTAAL_MODULES);
const MODULE_IDS = new Set(ALLE_MODULES.map(m => m.id));

module.exports = { BEHEER_MODULES, BEHEER_TABS, PORTAAL_MODULES, ALLE_MODULES, MODULE_IDS,
  MODULE_GROEPEN, GROEP_IDS, groepNaarTabs, TAB_MAP };
