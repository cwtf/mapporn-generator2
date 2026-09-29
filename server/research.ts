// Research tools the agent can call. All of them hit openly available endpoints that need
// no API key: DuckDuckGo's HTML page, the MediaWiki API, the Wikidata Query Service,
// OpenStreetMap Nominatim and arbitrary public web pages.

import { convert } from 'html-to-text';
import { safeGet, USER_AGENT } from './net.js';

const DEFAULT_MAX = 12000;

type Args = Record<string, unknown>;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required`);
  return v.trim();
};
const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** Slice long text and tell the model how to continue reading. */
function paginate(text: string, start: number, max: number): string {
  const s = Math.max(0, Math.floor(start));
  const m = Math.min(Math.max(1000, Math.floor(max)), 40000);
  const slice = text.slice(s, s + m);
  const end = s + slice.length;
  let out = slice;
  if (s > 0) out = `[...showing chars ${s}-${end} of ${text.length}]\n` + out;
  if (end < text.length) out += `\n\n[truncated: ${text.length - end} more chars; call again with start=${end} to continue]`;
  return out;
}

// ---- HTML -> text ------------------------------------------------------------

/** Turn table cells into " | " separated rows so tabular data survives the conversion. */
function flattenTables(html: string): string {
  return html
    .replace(/<\/t[dh]>/gi, ' | </td>')
    .replace(/<t[dh]\b[^>]*>/gi, '<td>')
    .replace(/<\/tr>/gi, '</tr>\n');
}

export function htmlToText(html: string): string {
  const text = convert(flattenTables(html), {
    wordwrap: false,
    baseElements: { selectors: ['main', 'article', '#content', 'body'], returnDomByDefault: true },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
      { selector: 'svg', format: 'skip' },
      { selector: 'sup.reference', format: 'skip' },
      { selector: '.mw-editsection', format: 'skip' },
      { selector: '.navbox', format: 'skip' },
      { selector: '.reflist', format: 'skip' },
      { selector: '.references', format: 'skip' },
      { selector: '.metadata', format: 'skip' },
      { selector: 'table', format: 'block' },
      { selector: 'tbody', format: 'block' },
      { selector: 'thead', format: 'block' },
      { selector: 'tr', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
      { selector: 'td', format: 'inline' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
    ],
  });
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- simple caches / rate limits --------------------------------------------

const cache = new Map<string, { at: number; text: string }>();
const CACHE_TTL = 10 * 60 * 1000;

async function cached(key: string, fn: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.text;
  const text = await fn();
  cache.set(key, { at: Date.now(), text });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return text;
}

let nominatimNext = 0;
async function nominatimSlot() {
  // Nominatim usage policy: max 1 request per second.
  const wait = nominatimNext - Date.now();
  nominatimNext = Math.max(Date.now(), nominatimNext) + 1100;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ---- tools -------------------------------------------------------------------

async function webSearch(args: Args): Promise<string> {
  const query = str(args.query, 'query');
  const limit = Math.min(num(args.limit, 8), 15);
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const results: { title: string; url: string; snippet: string }[] = [];
    const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
    for (const b of blocks) {
      const a = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      let url = decodeEntities(a[1]);
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (url.startsWith('//')) url = 'https:' + url;
      if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
      const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      results.push({ title: stripTags(a[2]), url, snippet: snip ? stripTags(snip[1]) : '' });
      if (results.length >= limit) break;
    }
    if (results.length > 0) {
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
    }
  } catch {
    // fall through to Wikipedia
  }
  const wiki = await wikipediaSearch({ query, limit });
  return `(Web search unavailable right now; showing Wikipedia results instead)\n${wiki}`;
}

async function fetchUrl(args: Args): Promise<string> {
  const url = str(args.url, 'url');
  const start = num(args.start, 0);
  const max = num(args.max_chars, DEFAULT_MAX);
  const text = await cached(`url:${url}`, async () => {
    const doc = await safeGet(url);
    if (doc.status >= 400) throw new Error(`HTTP ${doc.status} fetching ${doc.url}`);
    const ct = doc.contentType.toLowerCase();
    let body: string;
    if (ct.includes('html') || /^\s*<(!doctype|html)/i.test(doc.body)) {
      const title = doc.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      body = (title ? `# ${stripTags(title)}\n\n` : '') + htmlToText(doc.body);
    } else if (ct.includes('json')) {
      try {
        body = JSON.stringify(JSON.parse(doc.body));
      } catch {
        body = doc.body;
      }
    } else {
      body = doc.body;
    }
    return `URL: ${doc.url}\nContent-Type: ${doc.contentType}\n\n${body}`;
  });
  return paginate(text, start, max);
}

async function wikipediaSearch(args: Args): Promise<string> {
  const query = str(args.query, 'query');
  const lang = typeof args.lang === 'string' ? args.lang : 'en';
  const limit = Math.min(num(args.limit, 8), 20);
  const url = `https://${lang}.wikipedia.org/w/api.php?` +
    new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), format: 'json', formatversion: '2' });
  const res = await safeGet(url);
  const data = JSON.parse(res.body);
  const hits = data?.query?.search ?? [];
  if (!hits.length) return 'No results.';
  return hits
    .map((h: { title: string; snippet: string; wordcount: number }, i: number) =>
      `${i + 1}. ${h.title} (${h.wordcount} words)\n   ${stripTags(h.snippet)}`)
    .join('\n');
}

async function wikipediaPage(args: Args): Promise<string> {
  const title = str(args.title, 'title');
  const lang = typeof args.lang === 'string' ? args.lang : 'en';
  const start = num(args.start, 0);
  const max = num(args.max_chars, DEFAULT_MAX);
  const text = await cached(`wp:${lang}:${title}`, async () => {
    const url = `https://${lang}.wikipedia.org/w/api.php?` +
      new URLSearchParams({ action: 'parse', page: title, prop: 'text|sections', redirects: '1', format: 'json', formatversion: '2', disableeditsection: '1' });
    const res = await safeGet(url);
    const data = JSON.parse(res.body);
    if (data.error) throw new Error(data.error.info ?? 'Wikipedia error');
    const sections = (data.parse.sections ?? []).map((s: { number: string; line: string }) => `${s.number} ${stripTags(s.line)}`);
    return `# ${data.parse.title}\nhttps://${lang}.wikipedia.org/wiki/${encodeURIComponent(data.parse.title.replace(/ /g, '_'))}\n` +
      (sections.length ? `Sections: ${sections.join(' · ')}\n` : '') + '\n' + htmlToText(data.parse.text);
  });
  return paginate(text, start, max);
}

async function wikidataSparql(args: Args): Promise<string> {
  const query = str(args.query, 'query');
  const max = num(args.max_chars, 20000);
  const url = 'https://query.wikidata.org/sparql?' + new URLSearchParams({ query, format: 'json' });
  const res = await safeGet(url, { headers: { Accept: 'application/sparql-results+json' }, timeoutMs: 65000 });
  if (res.status >= 400) throw new Error(`SPARQL error ${res.status}: ${res.body.slice(0, 1500)}`);
  const data = JSON.parse(res.body);
  const vars: string[] = data.head.vars;
  const rows: Record<string, { value: string }>[] = data.results.bindings;
  const short = (v?: { value: string }) => (v ? v.value.replace('http://www.wikidata.org/entity/', '') : '');
  const lines = [vars.join('\t'), ...rows.map((r) => vars.map((v) => short(r[v])).join('\t'))];
  return `${rows.length} rows\n` + paginate(lines.join('\n'), 0, max);
}

async function geocode(args: Args): Promise<string> {
  const query = str(args.query, 'query');
  const limit = Math.min(num(args.limit, 3), 10);
  await nominatimSlot();
  const url = 'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ q: query, format: 'jsonv2', limit: String(limit), 'accept-language': 'en' });
  const res = await safeGet(url, { headers: { 'User-Agent': USER_AGENT } });
  const data = JSON.parse(res.body) as { display_name: string; lat: string; lon: string; type: string; category: string }[];
  if (!data.length) return 'No results.';
  return data
    .map((d) => `${d.display_name}\n   lat=${Number(d.lat).toFixed(4)} lon=${Number(d.lon).toFixed(4)} (${d.category}/${d.type})`)
    .join('\n');
}

export const researchTools: Record<string, (args: Args) => Promise<string>> = {
  web_search: webSearch,
  fetch_url: fetchUrl,
  wikipedia_search: wikipediaSearch,
  wikipedia_page: wikipediaPage,
  wikidata_sparql: wikidataSparql,
  geocode,
};

// ---- helpers -----------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
