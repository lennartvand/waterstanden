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
  // lith.beneden ("Lith dorp") en lith.sluis geven dezelfde metingen; lith.beneden heeft ook de historie van vóór okt. 2025
  { code: 'LITH', sleutel: 'lith', naam: 'Lith beneden sluis', bron: 'rws', rws: 'lith.beneden', nul: 'NAP' },
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
  // Ontbreekt het begin van de reeks (bijv. na een wissel van meetpunt)? Dan eerst dat stuk ophalen.
  const eersteJaar = (await jarenVan(p))[0];
  const eerste = eersteJaar ? Date.parse(Object.keys(await leesJaar(p, eersteJaar)).sort()[0] + ':00:00Z') : null;
  const vakken = [];
  if (p.bron === 'rws' && eerste && eerste - Date.parse(VANAF) > 2 * DAG) vakken.push([Date.parse(VANAF), eerste]);
  vakken.push([start, nu]);
  for (const [van, tot] of vakken) {
  start = van;
  if (van !== vakken.at(-1)[0]) log(`  begin aanvullen: ${new Date(van).toISOString().slice(0, 10)} t/m ${new Date(tot).toISOString().slice(0, 10)}`);
  while (start < tot) {
    // Rijkswaterstaat: per 30 dagen. Pegelonline: REST voor de laatste 30 dagen, anders historie per 90 dagen.
    const recent = p.bron === 'pegelonline';
    const stap = p.bron === 'rws' ? 30 * DAG : (recent ? 30 * DAG : 90 * DAG);
    const eind = Math.min(start + stap, tot);
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
  }
  fouten += foutenHier;
  if (nieuw || !foutenHier) gelukt++;
  const jaren = await jarenVan(p);
  const laatsteNu = await laatsteUur(p);
  index.peilschalen[p.code] = { sleutel: p.sleutel, naam: p.naam, bron: p.bron, nul: p.nul, jaren, laatste: laatsteNu ? uurSleutel(laatsteNu) : null };
  log(`  ${p.naam}: ${nieuw} nieuwe uren, laatste ${index.peilschalen[p.code].laatste}`);
}

// ---------- Teletekst 720: minst gepeilde dieptes, Westsluis Weurt, verwachtingen ----------
// Dagelijkse momentopname (de pagina toont alleen actuele waarden; RWS werkt
// de dieptes dagelijks rond 09:30 bij). Opslag: docs/data/dieptes/<jaar>.json
//   { "JJJJ-MM-DD": { tijd, vakken: { rivier: { vak: cm } }, westsluis, verwachtingen: { peilschaal: { "DD-MM": cm } } } }
const tekstVan = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&#x[0-9a-f]+;/gi, ' ');
async function teletekst720() {
  const paginas = [];
  for (let i = 1; i <= 12; i++) {
    const r = await fetch(`https://teletekst-data.nos.nl/json/${i === 1 ? '720' : '720-' + i}`);
    if (!r.ok) break;
    const j = await r.json();
    paginas.push(tekstVan(j.content));
    if (!j.nextSubPage) break;
  }
  return paginas;
}
function rivierVanVak(naam) {
  if (/spijk|maas-waalkanaal|woudrichem|waal/i.test(naam)) return 'Waal';
  if (/pannerdens|driel|heteren|hagestein|nederrijn|\blek\b/i.test(naam)) return 'Nederrijn-Lek';
  if (/twenthekanaal|zwolle|ketelmeer|deventer|ijssel/i.test(naam)) return 'IJssel';
  return 'Overig';
}
function leesDieptes(paginas) {
  const uit = { vakken: {}, westsluis: null, verwachtingen: {}, tijd: null };
  for (const p of paginas) {
    const regels = p.split('\n');
    if (/Minst gepeilde diepten/i.test(p)) {
      const t = p.match(/\b(\d{1,2}:\d{2})\b/);
      if (t) uit.tijd = t[1];
      // De pagina heeft geen kopjes per rivier: indelen op de namen van de vakken.
      let begonnen = false;
      for (const r of regels) {
        if (/Minst gepeilde diepten/i.test(r)) { begonnen = true; continue; }
        if (!begonnen) continue;
        const m = r.match(/^\s*(.+?)\.+\s*(-?\d+)\s*$/);
        if (!m) continue;
        const naam = m[1].trim(), cm = +m[2];
        if (/westsluis/i.test(naam)) uit.westsluis = cm;
        else { const rv = rivierVanVak(naam); (uit.vakken[rv] = uit.vakken[rv] || {})[naam] = cm; }
      }
    }
    if (/verwachte waterhoogten/i.test(p)) {
      const kop = regels.find(r => /\d{2}-\d{2}\s+\d{2}-\d{2}/.test(r));
      const data = kop ? kop.trim().split(/\s+/) : [];
      for (const r of regels) {
        const m = r.match(/^\s*([A-Za-zÀ-ÿ' ]+?)\.{2,}\s+((?:-?\d+\s*)+)$/);
        if (!m || !data.length) continue;
        const w = m[2].trim().split(/\s+/).map(Number);
        uit.verwachtingen[m[1].trim()] = Object.fromEntries(data.map((d, i) => [d, w[i]]).filter(([, v]) => isFinite(v)));
      }
    }
  }
  return uit;
}
try {
  const d = leesDieptes(await teletekst720());
  if (Object.keys(d.vakken).length || d.westsluis !== null) {
    const nuLokaal = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
    const dag = `${nuLokaal.getFullYear()}-${String(nuLokaal.getMonth() + 1).padStart(2, '0')}-${String(nuLokaal.getDate()).padStart(2, '0')}`;
    const bestand = join(DATA, 'dieptes', `${dag.slice(0, 4)}.json`);
    let jaar = {};
    try { jaar = JSON.parse(await readFile(bestand, 'utf8')); } catch {}
    jaar[dag] = d;
    await mkdir(join(DATA, 'dieptes'), { recursive: true });
    await writeFile(bestand, JSON.stringify(jaar));
    log(`\nTeletekst 720 (${dag} ${d.tijd || ''}): Westsluis ${d.westsluis} cm\n  vakken ${JSON.stringify(d.vakken)}\n  verwachtingen ${JSON.stringify(d.verwachtingen)}`);
  } else log('\nTeletekst 720: geen dieptes gevonden');
} catch (e) { log('\nTeletekst 720: FOUT ' + e.message); }

// Overzicht dieptes in de index
const dieptesJaren = (await readdir(join(DATA, 'dieptes')).catch(() => [])).map(f => +f.slice(0, 4)).filter(Boolean).sort();
let laatsteDieptes = null;
if (dieptesJaren.length) {
  const jaar = JSON.parse(await readFile(join(DATA, 'dieptes', `${dieptesJaren.at(-1)}.json`), 'utf8'));
  const dag = Object.keys(jaar).sort().at(-1);
  laatsteDieptes = { dag, ...jaar[dag] };
}
index.dieptes = { jaren: dieptesJaren, laatste: laatsteDieptes };

// ---------- Westsluis Weurt: uitvaartdiepte afgeleid uit Nijmegen Waal ----------
// diepte = stand Nijmegen − vast verschil. Het verschil volgt uit de dagen
// waarop Teletekst de diepte gaf (stand Nijmegen op dat moment − diepte); mediaan.
try {
  const nijm = PEILSCHALEN.find(p => p.code === 'NIJMEGEN');
  const verschillen = [];
  for (const j of dieptesJaren) {
    const jaar = JSON.parse(await readFile(join(DATA, 'dieptes', `${j}.json`), 'utf8'));
    for (const [dag, d] of Object.entries(jaar)) {
      if (d.westsluis === null || d.westsluis === undefined) continue;
      const [hh, mm] = String(d.tijd || '09:30').split(':').map(Number);
      // lokale tijd (Amsterdam) → UTC-uur
      const lokaal = Date.UTC(+dag.slice(0, 4), +dag.slice(5, 7) - 1, +dag.slice(8, 10), hh, mm);
      const ofs = berlijnOffset(+dag.slice(0, 4), +dag.slice(5, 7), +dag.slice(8, 10), hh) * 60000;
      const uur = uurSleutel(lokaal - ofs);
      const stand = (await leesJaar(nijm, uur.slice(0, 4)))[uur];
      if (stand !== undefined) verschillen.push(stand - d.westsluis);
    }
  }
  if (verschillen.length) {
    const s = [...verschillen].sort((a, b) => a - b);
    const verschil = s[Math.floor(s.length / 2)];
    const ws = { code: 'WESTSLUIS', sleutel: 'westsluis', naam: 'Westsluis Weurt (uitvaartdiepte)', bron: 'afgeleid', nul: 'diepte' };
    for (const j of await jarenVan(nijm)) {
      const uren = await leesJaar(nijm, j);
      const afgeleid = Object.fromEntries(Object.entries(uren).map(([k, v]) => [k, v - verschil]));
      await mkdir(join(DATA, ws.sleutel), { recursive: true });
      await writeFile(join(DATA, ws.sleutel, `${j}.json`), JSON.stringify(afgeleid));
    }
    index.peilschalen.WESTSLUIS = { sleutel: ws.sleutel, naam: ws.naam, bron: 'afgeleid uit Nijmegen Waal', nul: 'diepte (cm)',
      verschil, kalibratiedagen: verschillen.length, spreiding: s.at(-1) - s[0], jaren: await jarenVan(ws), laatste: index.peilschalen.NIJMEGEN.laatste };
    log(`Westsluis Weurt: afgeleid uit Nijmegen − ${verschil} cm (${verschillen.length} kalibratiedag(en), spreiding ${s.at(-1) - s[0]} cm)`);
  }
} catch (e) { log('Westsluis: FOUT ' + e.message); }

await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, 'index.json'), JSON.stringify(index, null, 2));
log(`\nKlaar: ${gelukt} van ${PEILSCHALEN.length} peilschalen bijgewerkt, ${fouten} mislukte perioden.`);
if (!gelukt) process.exit(1);
