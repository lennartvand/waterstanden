// Eenmalige verkenning (handmatig te starten): hoe bieden vaarweginformatie.nl
// (minst gepeilde dieptes, Westsluis Weurt) en NOS Teletekst 720 hun gegevens aan?
// Schrijft per bron de status, het type en een stuk van de inhoud naar het logboek,
// en zoekt in HTML en JavaScript naar adressen van achterliggende API's.

const BRONNEN = [
  'https://www.vaarweginformatie.nl/frp/hydro/mgd',
  'https://www.vaarweginformatie.nl/frp/main/',
  'https://teletekst-data.nos.nl/json/720',
  'https://teletekst-data.nos.nl/json/720-2',
  'https://pegelonline.wsv.de/gast/historische-zeitreihen',
  'https://www.pegelonline.wsv.de/gast/historische-zeitreihen'
];

const gezien = new Set();
async function toon(url, diepte = 0) {
  if (gezien.has(url) || gezien.size > 25) return;
  gezien.add(url);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (waterstanden-verkenning)' }, redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    const tekst = await r.text();
    console.log(`\n===== ${url}\nHTTP ${r.status} · ${type} · ${tekst.length} tekens · eindadres ${r.url}`);
    console.log(tekst.slice(0, diepte ? 1500 : 4000));
    // Mogelijke API-adressen en scripts
    const adressen = new Set();
    for (const m of tekst.matchAll(/["'`](\/?[a-z0-9_\-./]*(?:api|rest|service|hydro|mgd|diepte|json)[a-z0-9_\-./?=&]*)["'`]/gi)) adressen.add(m[1]);
    for (const m of tekst.matchAll(/https?:\/\/[^"'`\s<>]+/g)) if (/api|rest|json|hydro|mgd/i.test(m[0])) adressen.add(m[0]);
    if (adressen.size) console.log('--- mogelijke API-adressen:\n' + [...adressen].slice(0, 60).join('\n'));
    if (diepte < 1 && /html/i.test(type)) {
      const basis = new URL(r.url);
      for (const m of tekst.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) await toon(new URL(m[1], basis).href, diepte + 1);
    }
  } catch (e) {
    console.log(`\n===== ${url}\nFOUT: ${e.message}`);
  }
}

for (const b of BRONNEN) await toon(b);

// ---- Rijkswaterstaat: welke Lith-code heeft gegevens vóór oktober 2025? ----
const RWS = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
for (const code of ['lith', 'lith.beneden', 'lith.boven', 'lith.sluis', 'nijmegen.waal']) {
  for (const [van, tot] of [['2024-06-01T00:00:00.000+00:00', '2024-06-02T00:00:00.000+00:00'], ['2025-06-01T00:00:00.000+00:00', '2025-06-02T00:00:00.000+00:00']]) {
    try {
      const r = await fetch(RWS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        Locatie: { Code: code }, AquoPlusWaarnemingMetadata: { AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } } },
        Periode: { Begindatumtijd: van, Einddatumtijd: tot } }) });
      const t = await r.text();
      let info = t.slice(0, 200);
      try {
        const j = JSON.parse(t);
        info = (j.WaarnemingenLijst || []).map(w => `${(w.MetingenLijst || []).length} metingen, eerste ${JSON.stringify((w.MetingenLijst || [])[0] && w.MetingenLijst[0].Meetwaarde)}, meta ${JSON.stringify(w.AquoMetadata).slice(0, 160)}`).join(' | ') || ('geen reeksen: ' + t.slice(0, 160));
      } catch {}
      console.log(`RWS ${code} ${van.slice(0, 10)}: HTTP ${r.status} · ${info}`);
    } catch (e) { console.log(`RWS ${code} ${van.slice(0, 10)}: FOUT ${e.message}`); }
  }
}

// ---- Pegelonline-historie: wat zegt het formulier-adres op een POST? ----
for (const url of ['https://pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download', 'https://www.pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download']) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uuid: '1d26e504-7f9e-480a-b52c-5932be6549ab', parameter: 'WASSERSTAND ROHDATEN', start: '2025-06-01T00:00:00.000Z', end: '2025-06-03T00:00:00.000Z', format: 'csv' }) });
    const buf = Buffer.from(await r.arrayBuffer());
    console.log(`\nPO POST ${url}: HTTP ${r.status} · ${r.headers.get('content-type')} · ${buf.length} bytes · ${buf.slice(0, 300).toString('latin1').replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`PO POST ${url}: FOUT ${e.message}`); }
}
