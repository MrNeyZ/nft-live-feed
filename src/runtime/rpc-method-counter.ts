/**
 * Process-wide Helius RPC request counter, by JSON-RPC method.
 *
 * helius-credit-metrics only sees call sites that report themselves; this
 * wraps global fetch (undici) and http(s).request (node-fetch / web3.js) so
 * every outgoing request to *.helius-rpc.com is counted — batch bodies count
 * once per inner call, as Helius bills them. Logs `[rpc/methods]` every 5 min.
 */

import type * as httpT from 'http';
// Real module objects: `import * as` compiles to a getter-only namespace
// wrapper under esModuleInterop, and assigning `.request` on it throws.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('http') as typeof httpT;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https') as typeof import('https');

import { noteRpcMethod } from './rpc-usage-daily';

const LOG_MS = 5 * 60_000;
const counts = new Map<string, number>();

function isHeliusRpc(host: string | null | undefined): boolean {
  return !!host && host.includes('helius-rpc.com');
}

function countBody(body: unknown): void {
  let text: string;
  if (typeof body === 'string') text = body;
  else if (Buffer.isBuffer(body)) text = body.toString('utf8');
  else if (body instanceof Uint8Array) text = Buffer.from(body).toString('utf8');
  else { counts.set('(stream)', (counts.get('(stream)') ?? 0) + 1); noteRpcMethod('(stream)'); return; }
  try {
    const parsed = JSON.parse(text) as { method?: string } | Array<{ method?: string }>;
    for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
      const m = c?.method ?? '(none)';
      counts.set(m, (counts.get(m) ?? 0) + 1);
      noteRpcMethod(m);
    }
  } catch {
    counts.set('(non-json)', (counts.get('(non-json)') ?? 0) + 1);
  }
}

let installed = false;
export function installRpcMethodCounter(): void {
  if (installed) return;
  installed = true;

  const origFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isHeliusRpc(new URL(url).host)) countBody(init?.body);
    } catch { /* never break the request */ }
    return origFetch(input, init);
  }) as typeof fetch;

  for (const mod of [http, https]) {
    const origRequest = mod.request;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mod as any).request = function patchedRequest(this: unknown, ...args: any[]) {
      const req = (origRequest as (...a: unknown[]) => httpT.ClientRequest).apply(this, args);
      try {
        const opts = args.find(a => a && typeof a === 'object' && !(a instanceof URL)) as httpT.RequestOptions | undefined;
        const urlArg = args.find(a => typeof a === 'string' || a instanceof URL) as string | URL | undefined;
        const host = opts?.hostname ?? opts?.host ?? (urlArg ? new URL(urlArg.toString()).host : null);
        if (isHeliusRpc(host)) {
          const chunks: Buffer[] = [];
          const origWrite = req.write.bind(req);
          const origEnd = req.end.bind(req);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).write = (chunk: any, ...rest: any[]) => {
            if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
            return origWrite(chunk, ...rest);
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req as any).end = (chunk?: any, ...rest: any[]) => {
            if (chunk && typeof chunk !== 'function') chunks.push(Buffer.from(chunk));
            if (chunks.length) countBody(Buffer.concat(chunks));
            return origEnd(chunk, ...rest);
          };
        }
      } catch { /* never break the request */ }
      return req;
    };
  }

  setInterval(() => {
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, n]) => s + n, 0);
    console.log(`[rpc/methods] total=${total} ${sorted.map(([m, n]) => `${m}=${n}`).join(' ')}`);
    counts.clear();
  }, LOG_MS).unref();
}
