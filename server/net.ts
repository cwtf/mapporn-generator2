import dns from 'node:dns/promises';
import net from 'node:net';

export const USER_AGENT =
  process.env.MAPGEN_USER_AGENT ??
  'MapPornGenerator/0.1 (self-hosted map generation tool; https://www.reddit.com/r/MapPorn)';

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * Throws unless `url` is an http(s) URL on a public address. Agent-driven fetches go
 * through this so a prompt-injected page can't make the server probe the local network.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Refusing to fetch a local/internal host');
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Refusing to fetch a private network address');
  }
}

export interface FetchedDoc {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

const MAX_BYTES = 8 * 1024 * 1024;

/** GET a public URL, following redirects manually so every hop is checked. */
export async function safeGet(rawUrl: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<FetchedDoc> {
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,text/csv,text/plain,*/*;q=0.5', ...init.headers },
      signal: AbortSignal.timeout(init.timeoutMs ?? 20000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    const body = await readLimited(res);
    return { url: url.toString(), status: res.status, contentType: res.headers.get('content-type') ?? '', body };
  }
  throw new Error('Too many redirects');
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
