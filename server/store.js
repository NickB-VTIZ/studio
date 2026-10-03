// Opslag in een echte database: SQLite (ingebouwd in Node, geen extra pakket of server).
// - Transacties en WAL: geen kans op een half-geschreven bestand bij een crash of stroomonderbreking.
// - Eén bestand (studio.db) in de data-map, dus eenvoudig te back-uppen.
// - Migreert automatisch bestaande gegevens uit het oude studio.json.
// Dezelfde methodes als voorheen (get/list/set/delete) zodat de rest van de server ongewijzigd blijft.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.dbFile = path.join(dir, 'studio.db');
    this.jsonFile = path.join(dir, 'studio.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });

    this.db = new DatabaseSync(this.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, bijgewerkt TEXT, PRIMARY KEY (collection, id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT)');

    this._get = this.db.prepare('SELECT doc FROM docs WHERE collection = ? AND id = ?');
    this._list = this.db.prepare('SELECT id, doc FROM docs WHERE collection = ? ORDER BY id');
    this._set = this.db.prepare('INSERT INTO docs (collection, id, doc, bijgewerkt) VALUES (?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc, bijgewerkt = excluded.bijgewerkt');
    this._del = this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?');
    this._getMeta = this.db.prepare('SELECT waarde FROM meta WHERE sleutel = ?');
    this._setMeta = this.db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde');

    this.migreerVanJson();
    this._lastBackupDay = null;
  }

  // Eenmalige overname van gegevens uit het oude studio.json naar de database.
  migreerVanJson() {
    const al = this.getMeta('gemigreerd');
    if (al || !fs.existsSync(this.jsonFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
      const over = this.db.prepare('BEGIN'); over.run();
      for (const col of ['klanten', 'instellingen']) {
        for (const [id, doc] of Object.entries(parsed[col] || {})) {
          this._set.run(col, id, JSON.stringify(doc), (doc && doc.bijgewerkt) || new Date().toISOString());
        }
      }
      if (parsed.meta && parsed.meta.geseed) this._setMeta.run('geseed', '1');
      this._setMeta.run('gemigreerd', new Date().toISOString());
      this.db.prepare('COMMIT').run();
      fs.renameSync(this.jsonFile, this.jsonFile + '.gemigreerd');
      console.log('[store] gegevens uit studio.json overgezet naar de database');
    } catch (e) {
      try { this.db.prepare('ROLLBACK').run(); } catch (_) {}
      const broken = this.jsonFile + '.kapot-' + Date.now();
      try { fs.copyFileSync(this.jsonFile, broken); } catch (_) {}
      console.error('[store] migratie van studio.json mislukt; kopie bewaard als', broken, e.message);
    }
  }

  get(col, id) { const r = this._get.get(col, id); return r ? JSON.parse(r.doc) : undefined; }
  list(col) { return this._list.all(col).map(r => Object.assign({ id: r.id }, JSON.parse(r.doc))); }

  set(col, id, doc) {
    const copy = JSON.parse(JSON.stringify(doc));
    delete copy.id;
    this._set.run(col, id, JSON.stringify(copy), copy.bijgewerkt || new Date().toISOString());
    this.backupDaily();
    return copy;
  }

  delete(col, id) { const info = this._del.run(col, id); this.backupDaily(); return info.changes > 0; }

  getMeta(key) { const r = this._getMeta.get(key); return r ? r.waarde : undefined; }
  setMeta(key, val) { this._setMeta.run(key, String(val)); }

  // Eén consistente kopie per dag: WAL wegschrijven en het db-bestand kopiëren. Laatste 30 bewaard.
  backupDaily() {
    const day = new Date().toISOString().slice(0, 10);
    if (this._lastBackupDay === day) return;
    const target = path.join(this.backupDir, `studio-${day}.db`);
    if (fs.existsSync(target)) { this._lastBackupDay = day; return; }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(this.dbFile, target);
      this._lastBackupDay = day;
      const files = fs.readdirSync(this.backupDir).filter(f => /^studio-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
      while (files.length > 30) fs.unlinkSync(path.join(this.backupDir, files.shift()));
    } catch (e) { console.error('[store] back-up mislukt:', e.message); }
  }
}

module.exports = { Store };
