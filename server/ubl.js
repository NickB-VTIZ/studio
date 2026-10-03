// E-factuur in UBL 2.1 (Peppol BIS Billing 3.0) — zodat je ze in sbbSLIM kan inlezen of via Peppol versturen.
// Zuiver tekst/XML, geen externe diensten of pakketten.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(/\s|€/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = n => (Math.round(n * 100) / 100).toFixed(2);

// Splits "BE 0123.456.789" → {scheme:'9925', id:'BE0123456789'} voor Peppol.
function btwDeel(btw) {
  const clean = String(btw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean ? { endpoint: clean } : null;
}

function partij(tag, p) {
  const ep = btwDeel(p.btw);
  return `  <cac:${tag}>
    <cac:Party>
${ep ? `      <cbc:EndpointID schemeID="9925">${esc(ep.endpoint)}</cbc:EndpointID>\n` : ''}      <cac:PartyName><cbc:Name>${esc(p.naam || '')}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(p.straat || '')}</cbc:StreetName>
        <cbc:CityName>${esc(p.stad || '')}</cbc:CityName>
        <cbc:PostalZone>${esc(p.postcode || '')}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>${esc((p.land || 'BE').toUpperCase())}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
${ep ? `      <cac:PartyTaxScheme><cbc:CompanyID>${esc(ep.endpoint)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>\n` : ''}      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.naam || '')}</cbc:RegistrationName>${ep ? `<cbc:CompanyID>${esc(ep.endpoint)}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity>
${p.email ? `      <cac:Contact><cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail></cac:Contact>\n` : ''}    </cac:Party>
  </cac:${tag}>`;
}

// verkoper: {naam,straat,postcode,stad,land,btw,iban,email}
// klant: app-klant  offerte: app-offerte  nummer: factuurnummer  opts:{datum,vervaldatum}
function maakUBL(verkoper, klant, offerte, nummer, opts = {}) {
  const datum = opts.datum || new Date().toISOString().slice(0, 10);
  const verval = opts.vervaldatum || datum;
  const btwPct = num(offerte.btw) || 21;
  const regels = (offerte.regels || []).filter(r => (r.oms || '').trim() || num(r.prijs));
  if (!regels.length) throw new Error('De offerte heeft geen regels om te factureren.');
  let subtotaal = 0;
  const lijnen = regels.map((r, i) => {
    const qty = num(r.aantal) || 1, prijs = num(r.prijs), bedrag = qty * prijs;
    subtotaal += bedrag;
    return `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${r2(qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${r2(bedrag)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc((r.oms || 'Artikel').slice(0, 200))}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${r2(btwPct)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">${r2(prijs)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`;
  }).join('\n');
  const korting = num(offerte.korting);
  const belastbaar = Math.max(0, subtotaal - korting);
  const btwBedrag = belastbaar * btwPct / 100;
  const totaal = belastbaar + btwBedrag;
  const allowance = korting ? `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Korting</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="EUR">${r2(korting)}</cbc:Amount>
    <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${r2(btwPct)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
  </cac:AllowanceCharge>\n` : '';
  const pay = verkoper.iban ? `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount><cbc:ID>${esc(verkoper.iban.replace(/\s/g, ''))}</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${esc(nummer)}</cbc:ID>
  <cbc:IssueDate>${esc(datum)}</cbc:IssueDate>
  <cbc:DueDate>${esc(verval)}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
${partij('AccountingSupplierParty', verkoper)}
${partij('AccountingCustomerParty', { naam: klant.naam, straat: klant.straat || '', postcode: klant.postcode || '', stad: klant.locatie || '', land: 'BE', btw: klant.btw || '', email: klant.email })}
${pay}${allowance}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">${r2(btwBedrag)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">${r2(belastbaar)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">${r2(btwBedrag)}</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${r2(btwPct)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">${r2(subtotaal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${r2(belastbaar)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${r2(totaal)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="EUR">${r2(korting)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="EUR">${r2(totaal)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lijnen}
</Invoice>
`;
}

module.exports = { maakUBL };
