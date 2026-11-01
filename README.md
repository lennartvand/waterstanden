# Waterstanden

Openbare waterstanden voor de **Reizenregistratie** (binnenvaart), elke nacht automatisch bijgewerkt.

| Peilschaal | Bron | Meetpunt | Nul |
|---|---|---|---|
| Lith beneden sluis | Rijkswaterstaat | `lith.sluis` | cm NAP |
| Nijmegen Waal | Rijkswaterstaat | `nijmegen.waal` | cm NAP |
| Maxau, Kaub, Köln, Duisburg-Ruhrort, Wesel | Pegelonline (WSV) | station-uuid | cm t.o.v. pegelnul |

## Waarom deze repository?

Rijkswaterstaat beantwoordt geen verzoeken vanuit een webbrowser (er wordt geen
`Access-Control-Allow-Origin` meegestuurd, zie
[Rijkswaterstaat/WaterWebservices#30](https://github.com/Rijkswaterstaat/WaterWebservices/issues/30)).
De Reizenregistratie is een losse webpagina zonder server, dus die kan de gegevens
niet zelf ophalen. Deze repository haalt ze daarom één keer per nacht op
(GitHub Actions) en publiceert ze via GitHub Pages, dat browsers wél toelaat.

Er gaan geen reisgegevens naar deze repository: alleen openbare
waterstanden komen hier binnen en gaan van hier naar de app.

## Bestanden

- `docs/data/index.json` — overzicht: wanneer bijgewerkt, per peilschaal de beschikbare jaren en het laatste uur.
- `docs/data/<peilschaal>/<jaar>.json` — `{ "JJJJ-MM-DDTHH": cm }`, uurgemiddelde, uur in **UTC**.

Webadres: `https://<gebruiker>.github.io/waterstanden/data/index.json`

## Bijwerken

- Automatisch: elke nacht om 03:23 UTC (`.github/workflows/bijwerken.yml`).
- Handmatig: tabblad **Actions** → **Waterstanden bijwerken** → **Run workflow**.
- De eerste keer wordt alles vanaf 1 januari 2024 opgehaald; daarna alleen het laatste stuk.

## Bronnen en voorwaarden

- Rijkswaterstaat, WaterWebservices (`ddapi20-waterwebservices.rijkswaterstaat.nl`) — open data.
- Pegelonline, Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV) — ruwe, ongecontroleerde meetwaarden;
  zie de [gebruiksvoorwaarden](https://pegelonline.wsv.de/gast/nutzungsbedingungen).

Gebruik op eigen verantwoordelijkheid; dit zijn geen officiële of gecontroleerde reeksen.
