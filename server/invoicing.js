// Koppeling met EenvoudigFactureren (https://eenvoudigfactureren.be) — HTTPS-API met X-API-Key.
// Doc: https://eenvoudigfactureren.be/api-docs/index.html
const https = require('https');

const BASE = 'https://eenvoudigfactureren.be/api/v1';

function efConfig(env = process.env) {
  if (!env.EF_API_KEY) return null;
  return { key: env.EF_API_KEY, account: env.EF_ACCOUNT_ID || '' };
}

function efRequest(method, pad, body, cfg = efConfig()) {
  if (!cfg) return Promise.reject(new Error('EenvoudigFactureren niet ingesteld'));
  const data = body ? JSON.stringify(body) : null;
  const headers = { 'X-API-Key': cfg.key, 'Accept': 'application/json' };
  if (cfg.account) headers['X-AccountId'] = cfg.account;
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  return new Promise((resolve, reject) => {
    const req = https.request(BASE + pad, { method, headers, timeout: 20000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : {}; } catch (e) {}
        if (r.statusCode < 300) return resolve(j || {});
        reject(new Error((j && (j.message || j.error)) || ('EenvoudigFactureren ' + r.statusCode)));
      });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('EenvoudigFactureren timeout')); });
    if (data) req.write(data); req.end();
  });
}

const num = v => { const n = parseFloat(String(v ?? '').replace(/\s|€/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

// Zorg dat de klant bestaat in EenvoudigFactureren; geeft het client_id terug.
async function ensureClient(klant, cfg = efConfig()) {
  if (klant.efClientId) return { id: klant.efClientId, nieuw: false };
  const body = { name: (klant.naam || 'Klant').slice(0, 75) };
  if (klant.email) body.email_address = String(klant.email).slice(0, 125);
  if (klant.locatie) body.city = String(klant.locatie).slice(0, 50);
  const res = await efRequest('POST', '/clients', body, cfg);
  const id = res.client_id || res.id || (res.client && (res.client.client_id || res.client.id));
  if (!id) throw new Error('Geen client_id ontvangen van EenvoudigFactureren');
  return { id, nieuw: true };
}

// Maak een factuur op basis van een offerte uit de app.
async function maakFactuur(klant, offerte, cfg = efConfig()) {
  const { id: clientId, nieuw } = await ensureClient(klant, cfg);
  const items = (offerte.regels || [])
    .filter(r => (r.oms || '').trim() || num(r.prijs))
    .map(r => ({ description: (r.oms || 'Item').slice(0, 500), amount: num(r.prijs), quantity: num(r.aantal) || 1, tax_rate: num(offerte.btw) || 21 }));
  if (!items.length) throw new Error('De offerte heeft geen regels om te factureren');
  const note = num(offerte.korting) ? `Korting: € ${num(offerte.korting).toFixed(2)}` : undefined;
  const body = { client_id: clientId, days_due: 30, tax_calculation: 'total', tax_included: 'no', language: 'dutch', items };
  if (note) body.note = note;
  const inv = await efRequest('POST', '/invoices', body, cfg);
  return {
    clientId, clientNieuw: nieuw,
    invoiceId: inv.invoice_id || inv.id,
    number: inv.number || '',
    uri: inv.uri || inv.url || '',
    total: inv.total_with_tax,
  };
}

async function testEF(cfg = efConfig()) { await efRequest('GET', '/clients', null, cfg); return true; }
module.exports = { efConfig, efRequest, ensureClient, maakFactuur, testEF };
