// Verkenning (handmatig te starten): Teletekst 720 volledig, vaarweginformatie.nl
// (achterliggende API in de scripts), en de Lith-meetpunten van Rijkswaterstaat.

const UA = { 'User-Agent': 'Mozilla/5.0 (waterstanden-verkenning)' };
const tekstVan = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

// ---- Teletekst 720: alle subpagina's als platte tekst ----
for (let i = 1; i <= 12; i++) {
  const pagina = i === 1 ? '720' : `720-${i}`;
  try {
    const r = await fetch(`https://teletekst-data.nos.nl/json/${pagina}`, { headers: UA });
    if (!r.ok) { console.log(`TT ${pagina}: HTTP ${r.status}`); break; }
    const j = await r.json();
    console.log(`\n===== TT ${pagina}\n` + tekstVan(j.content || ''));
    if (!j.nextSubPage) break;
  } catch (e) { console.log(`TT ${pagina}: FOUT ${e.message}`); break; }
}

// ---- vaarweginformatie.nl: scripts t.o.v. <base href="/frp/"> ----
try {
  const r = await fetch('https://www.vaarweginformatie.nl/frp/hydro/mgd', { headers: UA });
  const html = await r.text();
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => new URL(m[1], 'https://www.vaarweginformatie.nl/frp/').href);
  console.log('\n===== FRP scripts: ' + scripts.join(' '));
  for (const s of scripts) {
    const t = await (await fetch(s, { headers: UA })).text();
    const adressen = new Set();
    for (const m of t.matchAll(/["'`]((?:https?:\/\/[^"'`\s]+)|(?:\/?(?:api|frp|wfs|ows|hydro|rest|services?)[^"'`\s]{0,120}))["'`]/gi)) adressen.add(m[1]);
    console.log(`--- ${s} (${t.length} tekens)\n` + [...adressen].filter(a => /api|hydro|mgd|diepte|depth|wfs|ows|rest|service/i.test(a)).slice(0, 120).join('\n'));
    // stukjes rond "mgd"
    let n = 0;
    for (const m of t.matchAll(/mgd|minstGepeild|leastSounded|soundedDepth/gi)) { if (n++ > 8) break; console.log('  …' + t.slice(Math.max(0, m.index - 150), m.index + 150).replace(/\s+/g, ' ') + '…'); }
  }
} catch (e) { console.log('FRP: FOUT ' + e.message); }

// ---- Rijkswaterstaat: Lith-codes vergelijken in een periode waarin beide bestaan ----
const RWS = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
async function rws(code, van, tot) {
  const r = await fetch(RWS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    Locatie: { Code: code }, AquoPlusWaarnemingMetadata: { AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'WATHTE' } } },
    Periode: { Begindatumtijd: van, Einddatumtijd: tot } }) });
  if (r.status !== 200) return `HTTP ${r.status}`;
  const j = await r.json();
  return (j.WaarnemingenLijst || []).map(w => {
    const a = w.AquoMetadata || {};
    const m = w.MetingenLijst || [];
    const k = (x) => x && (x.Code || x) ;
    return `[hoedanigheid ${k(a.Hoedanigheid)} · procestype ${a.ProcesType} · groepering ${k(a.Groepering)} · eenheid ${k(a.Eenheid)} · ${m.length} metingen, ${m.slice(0, 3).map(x => x.Tijdstip.slice(11, 16) + '=' + x.Meetwaarde.Waarde_Numeriek).join(' ')}]`;
  }).join(' ');
}
for (const [van, tot] of [['2025-06-01T10:00:00.000+00:00', '2025-06-01T10:30:00.000+00:00'], ['2025-11-15T10:00:00.000+00:00', '2025-11-15T10:30:00.000+00:00'], ['2026-11-01T10:00:00.000+00:00', '2026-11-01T10:30:00.000+00:00']]) {
  for (const code of ['lith.beneden', 'lith.sluis', 'lith.boven']) {
    try { console.log(`RWS ${code} ${van.slice(0, 16)}: ${await rws(code, van, tot)}`); } catch (e) { console.log(`RWS ${code}: FOUT ${e.message}`); }
  }
}
