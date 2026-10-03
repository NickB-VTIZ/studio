// Eenvoudige, robuuste opslag in één JSON-bestand met atomische schrijfacties en dagelijkse back-ups.
// Voor een eenmanszaak met honderden klanten is dit ruim voldoende en makkelijk te back-uppen (kopieer de map data/).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'studio.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.data = { klanten: {}, instellingen: {}, meta: { aangemaakt: new Date().toISOString() } };
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = Object.assign(this.data, parsed);
        this.data.klanten = this.data.klanten || {};
        this.data.instellingen = this.data.instellingen || {};
      } catch (e) {
        // Kapot bestand: bewaar het en start met een lege opslag, zodat er nooit stilletjes data verdwijnt.
        const broken = this.file + '.kapot-' + Date.now();
        fs.copyFileSync(this.file, broken);
        console.error('[store] studio.json kon niet gelezen worden; kopie bewaard als', broken, e.message);
      }
    }
    this._saveTimer = null;
  }

  get(col, id) { return (this.data[col] || {})[id]; }
  list(col) { return Object.entries(this.data[col] || {}).map(([id, d]) => Object.assign({ id }, d)); }

  set(col, id, doc) {
    if (!this.data[col]) this.data[col] = {};
    const copy = JSON.parse(JSON.stringify(doc));
    delete copy.id;
    this.data[col][id] = copy;
    this.save();
    return copy;
  }

  delete(col, id) {
    if (this.data[col] && this.data[col][id]) { delete this.data[col][id]; this.save(); return true; }
    return false;
  }

  // Schrijft via een tijdelijk bestand en rename: het bestand is nooit half geschreven op schijf.
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
    this.backupDaily();
  }

  backupDaily() {
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `studio-${day}.json`);
    if (fs.existsSync(target)) return;
    try {
      fs.copyFileSync(this.file, target);
      // Hou de laatste 30 dagelijkse back-ups bij.
      const files = fs.readdirSync(this.backupDir).filter(f => /^studio-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      while (files.length > 30) fs.unlinkSync(path.join(this.backupDir, files.shift()));
    } catch (e) { console.error('[store] back-up mislukt:', e.message); }
  }
}

module.exports = { Store };
