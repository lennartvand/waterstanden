// =============================================================
// Waterstanden bijwerken — draait dagelijks als GitHub Action
// =============================================================
// Haalt waterstanden op bij Rijkswaterstaat (Lith beneden sluis, Nijmegen
// Waal) en Pegelonline (Maxau, Kaub, Köln, Duisburg-Ruhrort, Wesel) en
// bewaart ze als uurgemiddelden in docs/data/<peilschaal>/<jaar>.json.
// GitHub Pages publiceert die map; browsers mogen dat ophalen (CORS), wat
// bij Rijkswaterstaat zelf niet kan.
//
// Bestanden:
//   docs/data/index.json            overzicht: bijgewerkt, per peilschaal naam, bron, jaren, laatste uur
//   docs/data/<sleutel>/<jaar>.json { "JJJJ-MM-DDTHH": cm, ... }  (uur in UTC, cm)
//
// Eerste keer: alles vanaf VANAF. Daarna alleen vanaf het laatste uur − 1 dag.
// Geen afhankelijkheden: alleen Node 20 (fetch, DecompressionStream).

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const VANAF = '2024-01-01T00:00:00Z';
const DATA = join(process.cwd(), 'docs', 'data');
const RWS_URL = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
const PO_REST = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/';
const PO_HISTORIE = 'https://pegelonline.wsv.de/gast/historische-zeitreihen/prepare-download';
const DAG = 86400000;

// code = zoals in de app (PEILSCHALEN in vaarwegen.js); sleutel = mapnaam
const PEILSCHALEN = [
  { code: 'LITH', sleutel: 'lith', naam: 'Lith beneden sluis', bron: 'rws', rws: 'lith.sluis', nul: 'NAP' },
  { code: 'NIJMEGEN', sleutel: 'nijmegen', naam: 'Nijmegen Waal', bron: 'rws', rws: 'nijmegen.waal', nul: 'NAP' },
  { code: 'MAXAU', sleutel: 'maxau', naam: 'Maxau', bron: 'pegelonline', uuid: 'b6c6d5c8-e2d5-4469-8dd8-fa972ef7eaea', nul: 'PNP' },
  { code: 'KAUB', sleutel: 'kaub', naam: 'Kaub', bron: 'pegelonline', uuid: '1d26e504-7f9e-480a-b52c-5932be6549ab', nul: 'PNP' },
  { code: 'KÖLN', sleutel: 'koeln', naam: 'Köln', bron: 'pegelonline', uuid: 'a6ee8177-107b-47dd-bcfd-30960ccc6e9c', nul: 'PNP' },
  { code: 'DUISBURG-RUHRORT', sleutel: 'duisburg-ruhrort', naam: 'Duisburg-Ruhrort', bron: 'pegelonline', uuid: 'c0f51e35-d0e8-4318-afaf-c5fcbc29f4c1', nul: 'PNP' },
  { code: 'WESEL', sleutel: 'wesel', naam: 'Wesel', bron: 'pegelonline', uuid: 'f33c3cc9-dc4b-4b77-baa9-5a5f10704398', nul: 'PNP' }
];

const uurSleutel = (ms) => new Date(ms).toISOString().slice(0, 13);
const log = (...a) => console.log(...a);

// ---------- Opslag ----------
async function leesJaar(p, jaar) {
  try { return JSON.parse(await readFile(join(DATA, p.sleutel, `${jaar}.json`), 'utf8')); } catch { return {}; }
}
async function jarenVan(p) {
  try { return (await readdir(join(DATA, p.sleutel))).map(f => f.match(/^(\d{4})\.json$/)).filter(Boolean).map(m => +m[1]).sort(); }
  catch { return []; }
}

// Metingen [{ms, cm}] → uurgemiddelden, samenvoegen met de jaarbestanden
async function bewaar(p, metingen) {
  const perUur = {};
  for (const { ms, cm } of metingen) {
    if (!isFinite(ms) || !isFinite(cm) || Math.abs(cm) >= 9999) continue;   // 999999999 = geen meting
    const k = uurSleutel(ms);
    (perUur[k] = perUur[k] || []).push(cm);
  }
  const perJaar = {};
  for (const [k, w] of Object.entries(perUur)) (perJaar[k.slice(0, 4)] = perJaar[k.slice(0, 4)] || {})[k] = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
  let nieuw = 0;
  for (const [jaar, uren] of Object.entries(perJaar)) {
    const bestaand = await leesJaar(p, jaar);
    for (const [k, v] of Object.entries(uren)) if (bestaand[k] !== v) { bestaand[k] = v; nieuw++; }
    const gesorteerd = Object.fromEntries(Object.entries(bestaand).sort(([a], [b]) => a.localeCompare(b)));
    await mkdir(join(DATA, p.sleutel), { recursive: true });
    await writeFile(join(DATA, p.sleutel, `${jaar}.json`), JSON.stringify(gesorteerd));
  }
  return nieuw;
}

async function laatsteUur(p) {
  const jaren = await jarenVan(p);
  if (!jaren.length) return null;
  const sleutels = Object.keys(await leesJaar(p, jaren[jaren.length - 1])).sort();
  return sleutels.length ? Date.parse(sleutels[sleutels.length - 1] + ':00:00Z') : null;
}

// ---------- Rijkswaterstaat ----------
const rwsTijd = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
async function rwsPeriode(p, van, tot) {
  const r = await fetch(RWS_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Locatie: { Code: p.rws },
      AquoPlusWaarnemingMetadata: { AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } } },
      Periode: { Begindatumtijd: rwsTijd(van), Einddatumtijd: rwsTijd(tot) }
    })
  });
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  let reeksen = data.WaarnemingenLijst || [];
  const metingen = reeksen.filter(w => !w.AquoMetadata || !w.AquoMetadata.ProcesType || w.AquoMetadata.ProcesType === 'meting');
  if (metingen.length) reeksen = metingen;
  return reeksen.flatMap(w => (w.MetingenLijst || []).map(m => ({ ms: Date.parse(m.Tijdstip), cm: Number(m.Meetwaarde && m.Meetwaarde.Waarde_Numeriek) })));
}

// ---------- Pegelonline ----------
async function poRecent(p, van, tot) {
  const url = `${PO_REST}${p.uuid}/W/measurements.json?start=${encodeURIComponent(new Date(van).toISOString())}&end=${encodeURIComponent(new Date(tot).toISOString())}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).map(m => ({ ms: Date.parse(m.timestamp), cm: Number(m.value) }));
}

// Historie (ouder dan ~30 dagen): zelfde formulier als op de Pegelonline-site, antwoord is een zip met CSV
async function poHistorie(p, van, tot) {
  const r = await fetch(PO_HISTORIE, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uuid: p.uuid, parameter: 'WASSERSTAND ROHDATEN', start: new Date(van).toISOString(), end: new Date(tot).toISOString(), format: 'csv' })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bestanden = await pakZipUit(await r.arrayBuffer());
  const csv = Object.entries(bestanden).find(([n]) => /\.csv$/i.test(n));
  if (!csv) throw new Error('geen CSV in zip (' + Object.keys(bestanden).join(', ') + ')');
  return leesPegelonlineCSV(csv[1]);
}

// Offset van Europe/Berlin (MEZ/MESZ) op een lokaal tijdstip, in minuten
function berlijnOffset(jaar, maand, dag, uur) {
  const benadering = Date.UTC(jaar, maand - 1, dag, uur);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' });
  const deel = f.formatToParts(new Date(benadering)).find(x => x.type === 'timeZoneName').value;   // "GMT+1"
  const m = deel.match(/GMT([+-]\d+)/);
  return m ? +m[1] * 60 : 60;
}

// CSV "timestamp;value" — tijd met offset (ISO) of lokale Duitse tijd
function leesPegelonlineCSV(tekst) {
  const regels = tekst.replace(/^﻿/, '').split(/\r?\n/).filter(r => r.trim());
  const uit = [];
  for (const regel of regels) {
    const [ts, waarde] = regel.split(/[;,\t]/).map(x => (x || '').trim().replace(/^"|"$/g, ''));
    const cm = Number(String(waarde).replace(',', '.'));
    if (!isFinite(cm)) continue;   // kopregel e.d.
    let ms = Date.parse(ts);
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)) {
      const m = ts.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/) || ts.match(/(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
      if (!m) continue;
      const [j, mo, d] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
      const h = +m[4], mi = +m[5];
      ms = Date.UTC(j, mo - 1, d, h, mi) - berlijnOffset(j, mo, d, h) * 60000;
    }
    if (isFinite(ms)) uit.push({ ms, cm });
  }
  return uit;
}

// Minimale zip-uitpakker (stored + deflate)
async function pakZipUit(buffer) {
  const data = new DataView(buffer), bytes = new Uint8Array(buffer), dec = new TextDecoder('utf-8');
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) if (data.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('geen zip (begint met: ' + dec.decode(bytes.subarray(0, 120)).replace(/\s+/g, ' ') + ')');
  const aantal = data.getUint16(eocd + 10, true);
  let pos = data.getUint32(eocd + 16, true);
  const uit = {};
  for (let n = 0; n < aantal; n++) {
    const methode = data.getUint16(pos + 10, true), grootte = data.getUint32(pos + 20, true);
    const nl = data.getUint16(pos + 28, true), el = data.getUint16(pos + 30, true), cl = data.getUint16(pos + 32, true);
    const lokaal = data.getUint32(pos + 42, true);
    const naam = dec.decode(bytes.subarray(pos + 46, pos + 46 + nl));
    const start = lokaal + 30 + data.getUint16(lokaal + 26, true) + data.getUint16(lokaal + 28, true);
    const ruw = bytes.subarray(start, start + grootte);
    if (methode === 0) uit[naam] = dec.decode(ruw);
    else if (methode === 8) uit[naam] = await new Response(new Blob([ruw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    pos += 46 + nl + el + cl;
  }
  return uit;
}

// ---------- Hoofdprogramma ----------
async function metHerkansing(fn) {
  try { return await fn(); }
  catch (e) { await new Promise(r => setTimeout(r, 5000)); return await fn(); }
}

const nu = Date.now();
let fouten = 0, gelukt = 0;
const index = { bijgewerkt: new Date().toISOString(), eenheid: 'cm', uur: 'UTC', peilschalen: {} };

for (const p of PEILSCHALEN) {
  const laatste = await laatsteUur(p);
  let start = laatste ? laatste - DAG : Date.parse(VANAF);
  // Pegelonline bewaart via de webservice maar ~30 dagen (de historie-download
  // op de site bestaat niet meer): verder terug heeft geen zin.
  if (p.bron === 'pegelonline') start = Math.max(start, nu - 30 * DAG);
  log(`\n${p.naam}: vanaf ${new Date(start).toISOString().slice(0, 10)}`);
  let nieuw = 0, foutenHier = 0;
  while (start < nu) {
    // Rijkswaterstaat: per 30 dagen. Pegelonline: REST voor de laatste 30 dagen, anders historie per 90 dagen.
    const recent = p.bron === 'pegelonline';
    const stap = p.bron === 'rws' ? 30 * DAG : (recent ? 30 * DAG : 90 * DAG);
    const eind = Math.min(start + stap, nu);
    try {
      const m = await metHerkansing(() =>
        p.bron === 'rws' ? rwsPeriode(p, start, eind) : (recent ? poRecent(p, start, eind) : poHistorie(p, start, eind)));
      const n = await bewaar(p, m);
      nieuw += n;
      log(`  ${new Date(start).toISOString().slice(0, 10)} t/m ${new Date(eind).toISOString().slice(0, 10)}: ${m.length} metingen, ${n} nieuwe uren`);
    } catch (e) {
      foutenHier++;
      log(`  FOUT ${new Date(start).toISOString().slice(0, 10)}: ${e.message}`);
    }
    start = eind;
  }
  fouten += foutenHier;
  if (nieuw || !foutenHier) gelukt++;
  const jaren = await jarenVan(p);
  const laatsteNu = await laatsteUur(p);
  index.peilschalen[p.code] = { sleutel: p.sleutel, naam: p.naam, bron: p.bron, nul: p.nul, jaren, laatste: laatsteNu ? uurSleutel(laatsteNu) : null };
  log(`  ${p.naam}: ${nieuw} nieuwe uren, laatste ${index.peilschalen[p.code].laatste}`);
}

await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, 'index.json'), JSON.stringify(index, null, 2));
log(`\nKlaar: ${gelukt} van ${PEILSCHALEN.length} peilschalen bijgewerkt, ${fouten} mislukte perioden.`);
if (!gelukt) process.exit(1);
