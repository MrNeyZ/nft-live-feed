/**
 * Shared local HTTP fixture server for Stage 3 bundle tests. NOT a test
 * file itself. Binds to 127.0.0.1 only — every test that talks to it must
 * pass an `isDestinationAllowedOverride` permitting 127.0.0.1 (the real
 * SSRF allowlist would otherwise correctly reject loopback, by design; see
 * ssrf-guard.ts's doc comment on the override).
 *
 * No live internet calls anywhere in these tests — every "remote" host in
 * the Stage 3 test suite IS this server.
 */
import * as http from 'http';
import sharp from 'sharp';

export interface TestServerHandle {
  baseUrl: string;
  counters: Record<string, number>;
  close(): Promise<void>;
}

let cachedPngBuffer: Buffer | null = null;
async function tinyPng(): Promise<Buffer> {
  if (cachedPngBuffer) return cachedPngBuffer;
  cachedPngBuffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  return cachedPngBuffer;
}

export async function startTestServer(): Promise<TestServerHandle> {
  const counters: Record<string, number> = {};
  const png = await tinyPng();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    counters[url] = (counters[url] ?? 0) + 1;
    const hit = counters[url];

    if (url === '/ok-png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    if (url === '/ok-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'Test NFT #1', attributes: [{ trait_type: 'Background', value: 'Blue' }] }));
      return;
    }
    if (url === '/malformed-json') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('{ this is not valid json ');
      return;
    }
    if (url === '/not-an-image') {
      res.writeHead(200, { 'Content-Type': 'image/png' }); // lying header — content is HTML
      res.end('<html><body>not an image</body></html>');
      return;
    }
    if (url === '/oversized-image') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      // Stream ~9MB of junk — exceeds BUNDLE_MAX_IMAGE_BYTES's 8MB default,
      // so the byte cap fires before content-sniffing ever gets a chance
      // to run. Tests that want to trigger the cap at a SMALLER threshold
      // pass an explicit small `maxBytes` to downloadToFile directly
      // instead (see ssrf-guard.test.ts).
      const chunk = Buffer.alloc(256 * 1024, 1);
      for (let i = 0; i < 36; i++) res.write(chunk);
      res.end();
      return;
    }
    if (url === '/oversized-metadata') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }));
      return;
    }
    if (url === '/retry-429-then-ok') {
      if (hit <= 2) { res.writeHead(429); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    if (url === '/retry-503-then-ok') {
      if (hit <= 2) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    if (url === '/permanent-404') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url === '/always-429') {
      res.writeHead(429);
      res.end();
      return;
    }
    if (url === '/slow') {
      await new Promise((r) => setTimeout(r, 5_000));
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    if (url === '/redirect-to-private') {
      res.writeHead(302, { Location: 'http://10.0.0.5/blocked' });
      res.end();
      return;
    }
    if (url === '/redirect-to-ok') {
      res.writeHead(302, { Location: '/ok-png' });
      res.end();
      return;
    }
    if (url.startsWith('/redirect-loop')) {
      res.writeHead(302, { Location: '/redirect-loop' });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counters,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Standard override for these tests: allow ONLY the loopback address the
 *  fixture server binds to. A redirect to any other address (e.g. the
 *  deliberately-private 10.0.0.5 fixture) is still rejected by the SAME
 *  logic real traffic uses — proving per-hop revalidation actually works,
 *  not just bypassing it wholesale. */
export const allowOnlyLoopback = (ip: string): boolean => ip === '127.0.0.1';
