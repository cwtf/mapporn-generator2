import express from 'express';
import { Readable } from 'node:stream';
import { dataTools } from './data.js';
import { researchTools } from './research.js';

// The LLM relay forwards to user-supplied base URLs, so a publicly reachable server would be
// an open proxy. MAPGEN_ALLOWED_PROVIDERS (comma-separated hostnames, or "*") limits where it
// may forward; when unset, local runs are unrestricted and Vercel deployments get this list.
const DEFAULT_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.x.ai',
  'api.together.xyz',
];

const allowedHosts: Set<string> | null = (() => {
  const raw = process.env.MAPGEN_ALLOWED_PROVIDERS ?? (process.env.VERCEL ? DEFAULT_PROVIDER_HOSTS.join(',') : '*');
  const hosts = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.includes('*') ? null : new Set(hosts);
})();

class BlockedTarget extends Error {}

type ApiFormat = 'anthropic' | 'openai';

interface ProviderTarget {
  format: ApiFormat;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

function endpoint(t: ProviderTarget, kind: 'chat' | 'models'): string {
  let base = t.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL must start with http:// or https://');
  if (t.format === 'anthropic') {
    base = base.replace(/\/v1\/messages$/, '').replace(/\/v1$/, '');
    return `${base}/v1/${kind === 'chat' ? 'messages' : 'models'}`;
  }
  base = base.replace(/\/chat\/completions$/, '');
  return `${base}/${kind === 'chat' ? 'chat/completions' : 'models'}`;
}

function assertAllowed(url: string): void {
  if (!allowedHosts) return;
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'https:' || !allowedHosts.has(hostname.toLowerCase())) {
    throw new BlockedTarget(
      `This server only relays to HTTPS on: ${[...allowedHosts].join(', ')}. ` +
        `Set MAPGEN_ALLOWED_PROVIDERS on the server to allow ${hostname}.`,
    );
  }
}

function providerHeaders(t: ProviderTarget): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (t.format === 'anthropic') {
    h['anthropic-version'] = '2023-06-01';
    if (t.apiKey) h['x-api-key'] = t.apiKey;
  } else if (t.apiKey) {
    h.authorization = `Bearer ${t.apiKey}`;
  }
  for (const [k, v] of Object.entries(t.headers ?? {})) {
    if (typeof v === 'string' && k.trim()) h[k.trim().toLowerCase()] = v;
  }
  return h;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// Relay a chat request to the configured provider and stream the response straight back.
app.post('/api/llm/chat', async (req, res) => {
  const { body, ...target } = req.body as ProviderTarget & { body: unknown };
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const url = endpoint(target, 'chat');
    assertAllowed(url);
    const upstream = await fetch(url, {
      method: 'POST',
      headers: providerHeaders(target),
      body: JSON.stringify(body),
      // A redirect could lead off the allowlist.
      redirect: allowedHosts ? 'error' : 'follow',
      signal: abort.signal,
    });
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.setHeader('cache-control', 'no-cache');
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (abort.signal.aborted) return;
    if (e instanceof BlockedTarget) return void res.status(403).json({ error: { message: e.message } });
    res.status(502).json({ error: { message: `Could not reach provider: ${(e as Error).message}` } });
  }
});

app.post('/api/llm/models', async (req, res) => {
  const target = req.body as ProviderTarget;
  try {
    const url = endpoint(target, 'models');
    assertAllowed(url);
    const headers = providerHeaders(target);
    delete headers['content-type'];
    const upstream = await fetch(url, {
      headers,
      redirect: allowedHosts ? 'error' : 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const text = await upstream.text();
    if (!upstream.ok) return void res.status(upstream.status).json({ error: { message: text.slice(0, 500) } });
    const data = JSON.parse(text);
    const list: { id: string }[] = data.data ?? data.models ?? [];
    res.json({ models: list.map((m) => m.id).filter(Boolean).sort() });
  } catch (e) {
    res.status(e instanceof BlockedTarget ? 403 : 502).json({ error: { message: (e as Error).message } });
  }
});

app.post('/api/tools/:name', async (req, res) => {
  const tool = researchTools[req.params.name];
  if (!tool) return void res.status(404).json({ error: `Unknown tool ${req.params.name}` });
  try {
    res.json({ result: await tool(req.body ?? {}) });
  } catch (e) {
    res.json({ error: (e as Error).message });
  }
});

// Bulk data for map tools (elevation grids, GeoJSON); JSON results that go to the map, not the model.
app.post('/api/data/:name', async (req, res) => {
  const loader = dataTools[req.params.name];
  if (!loader) return void res.status(404).json({ error: `Unknown data source ${req.params.name}` });
  try {
    res.json({ result: await loader(req.body ?? {}) });
  } catch (e) {
    res.json({ error: (e as Error).message });
  }
});

export default app;
