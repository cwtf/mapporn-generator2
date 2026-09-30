import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';

const PORT = Number(process.env.PORT ?? 8787);
// Bound to loopback by default: the LLM relay forwards to user-supplied base URLs, so
// exposing it on a network interface would make it an open proxy (see app.ts).
const HOST = process.env.HOST ?? '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`MapPorn Generator server on http://${HOST}:${PORT}`);
});
