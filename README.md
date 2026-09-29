# MapPorn Generator

An AI-assisted map maker for [r/MapPorn](https://www.reddit.com/r/MapPorn). A large interactive map fills the page; an assistant in the right-hand sidebar researches data and draws on the map through tools — colouring countries and states, building choropleths, adding labels, markers, routes, a title, legend and source caption.

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:5173, click the gear icon, and add an API key for your provider (or pick a local one such as Ollama).

For a production build served by the Node server on one port (default `8787`):

```bash
npm run build
npm start
```

## Features

- **Map** — 77 projections in eight families, Mercator by default:
  - *Cylindrical*: Mercator, Miller, Gall stereographic, Gall–Peters, Hobo–Dyer, Behrmann…
  - *Compromise / equal-area*: Robinson, Winkel Tripel, Natural Earth, Equal Earth, Mollweide, Eckert IV/VI, Van der Grinten, Bertin 1953…
  - *Interrupted*: Goode homolosine, interrupted Mollweide/sinusoidal/Boggs…
  - *Polyhedral & folded*: **Dymaxion (Fuller AirOcean)**, Cahill–Keyes, Waterman butterfly, Imago, Lee tetrahedral, Cox, icosahedral/dodecahedral/cubic nets, HEALPix, Peirce & Gringorten quincuncial…
  - *Azimuthal & globe*: orthographic globe, tilted satellite view, stereographic, gnomonic, Lambert azimuthal equal-area…
  - *Conic & regional*: Albers, Lambert conformal conic, equidistant conic, transverse Mercator, polyconic, Bonne, Albers USA
  - *Novelty*: Werner heart, Berghaus star, Gingery, Lagrange, August, Guyou…

  Zoom with the scroll wheel or the +/− buttons; drag to pan (or to rotate globe-style projections). Hover shows region names and values.
- **Legend** — drag it anywhere on the map, drag its corner grip to resize, double-click to snap it back to its corner. The placement is saved with the chat and used in exports.
- **Regions** — ~240 countries plus first-level subdivisions (states, provinces, regions) for 213 countries, loaded on demand. Regions can be referred to by ISO codes (`FRA`, `FR`, `US-CA`), names, or groups (`continent:Africa`, `subregion:Western Europe`, `USA:*`).
- **Agent tools** — `color_regions`, `set_choropleth` (quantize / quantile / threshold / continuous, ColorBrewer & viridis schemes), `add_labels`, `add_markers`, `add_lines` (geodesic, arc or straight, with arrows), `set_title`, `set_legend`, `set_style`, `set_projection`, `zoom_to`, `show_subdivisions`, `list_regions`, `remove_elements`, `reset_map`, `get_map_state`.
- **Research without a search API** — `web_search` (DuckDuckGo HTML, falls back to Wikipedia search), `fetch_url` (any public page, JSON or CSV; HTML tables are preserved as rows), `wikipedia_search`, `wikipedia_page`, `wikidata_sparql`, and `geocode` (OpenStreetMap Nominatim).
- **Any provider** — profiles for the Anthropic Messages format and the OpenAI Chat Completions format, with configurable base URL, so Claude, OpenAI, OpenRouter, Gemini, DeepSeek, Mistral, Groq, xAI, Together, Ollama, LM Studio and other compatible servers all work. Streaming, extra headers and extra request-body JSON (e.g. `{"output_config": {"effort": "high"}}`) are configurable per profile.
- **History** — every chat is saved in the browser (IndexedDB) together with the map. Opening a chat restores its map; "Show map from here" restores the map as it was after an earlier reply. Delete chats one at a time or all at once.
- **Export** — PNG (3200×2000) or SVG, including title, legend and caption.
- **Theme** — follows the system by default; toggle light/dark in the top bar or Settings.

## How it fits together

```
browser (React + d3-geo)                         server/ (Express)
  map state (zustand) <── map tools               /api/llm/chat    relay to provider, streams back
  agent loop ── LLM calls ──────────────────────▶ /api/llm/models  list models
             └─ research tools ─────────────────▶ /api/tools/:name web search, fetch, Wikipedia, Wikidata, geocode
  IndexedDB: chats + map snapshots
```

The agent loop runs in the browser; map tools edit the map state directly. LLM requests and web research go through the small local server, which avoids browser CORS limits and adds provider auth headers.

- `src/map/` — projections, geodata loading and name resolution, colour scales, the SVG renderer and export
- `src/agent/` — provider adapters (`llm.ts`), tool definitions (`tools.ts`), system prompt and the tool-use loop
- `src/store/` — map, chat, settings and theme stores
- `server/` — LLM relay and research tools
- `scripts/build-geodata.mjs` — regenerates `public/data` from Natural Earth (`npm run geodata`)

## Notes

- API keys are stored in the browser's localStorage and sent only to the provider you configure, via the local server.
- The server listens on `127.0.0.1` by default because the LLM relay forwards to user-supplied URLs. Set `HOST`/`PORT` to change this; don't expose it publicly without adding authentication. Agent-driven web fetches refuse private and loopback addresses.
- Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain). Geocoding: © OpenStreetMap contributors via Nominatim (1 request/second).
