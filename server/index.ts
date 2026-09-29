import express from 'express';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { researchTools } from './research.js';

const PORT = Number(process.env.PORT ?? 8787);
// Bound to loopback by default: the LLM relay forwards to user-supplied base URLs, so
// exposing it on a network interface would make it an open proxy.
const HOST = process.env.HOST ?? '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    const upstream = await fetch(endpoint(target, 'chat'), {
      method: 'POST',
      headers: providerHeaders(target),
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
    res.setHeader('cache-control', 'no-cache');
    if (!upstream.body) return void res.end();
    Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (abort.signal.aborted) return;
    res.status(502).json({ error: { message: `Could not reach provider: ${(e as Error).message}` } });
  }
});

app.post('/api/llm/models', async (req, res) => {
  const target = req.body as ProviderTarget;
  try {
    const headers = providerHeaders(target);
    delete headers['content-type'];
    const upstream = await fetch(endpoint(target, 'models'), { headers, signal: AbortSignal.timeout(15000) });
    const text = await upstream.text();
    if (!upstream.ok) return void res.status(upstream.status).json({ error: { message: text.slice(0, 500) } });
    const data = JSON.parse(text);
    const list: { id: string }[] = data.data ?? data.models ?? [];
    res.json({ models: list.map((m) => m.id).filter(Boolean).sort() });
  } catch (e) {
    res.status(502).json({ error: { message: (e as Error).message } });
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

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`MapPorn Generator server on http://${HOST}:${PORT}`);
});
