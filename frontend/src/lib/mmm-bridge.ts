const ME_ORIGIN         = 'https://magiceden.io';
const READY_TIMEOUT_MS  = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

let _meWindow: Window | null = null;

function activeWindow(): Window | null {
  if (_meWindow && !_meWindow.closed) return _meWindow;
  _meWindow = null;
  return null;
}

function waitForMessage(
  predicate: (e: MessageEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`bridge timeout (${label}) after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(e: MessageEvent) {
      if (!predicate(e)) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(e);
    }
    window.addEventListener('message', handler);
  });
}

function fromMe(w: Window) {
  return (e: MessageEvent) => e.source === w && e.origin === ME_ORIGIN;
}

async function ensureReady(): Promise<Window> {
  const existing = activeWindow();

  if (existing) {
    // Ping to confirm userscript is alive
    const readyP = waitForMessage(
      e => fromMe(existing)(e) && e.data?.type === 'VL_MMM_READY',
      5_000,
      'ping',
    );
    existing.postMessage({ type: 'VL_MMM_PING' }, ME_ORIGIN);
    await readyP; // throws on timeout
    return existing;
  }

  // Open a new ME window; keep opener reference so userscript can post back
  const w = window.open('https://magiceden.io', 'vl-me-bridge', 'width=960,height=680');
  if (!w) throw new Error('Popup blocked — allow popups for this site and retry');
  _meWindow = w;

  // Wait for userscript to fire and post VL_MMM_READY to window.opener
  await waitForMessage(
    e => fromMe(w)(e) && e.data?.type === 'VL_MMM_READY',
    READY_TIMEOUT_MS,
    'open',
  );
  return w;
}

export interface BridgeParams {
  pool: string;
  seller: string;
  assetMint: string;
  assetAmount: number;
  minPaymentAmount: number;
}

export interface BridgeResult {
  ok: boolean;
  status: number | null;
  elapsedMs: number;
  body: unknown | null;
  rawBody: string | null;
  error: string | null;
  windowOpened: boolean;
}

export async function requestMmmInstruction(params: BridgeParams): Promise<BridgeResult> {
  const t0 = performance.now();
  const hadWindow = !!activeWindow();

  const w = await ensureReady();
  const id = crypto.randomUUID();

  const responseP = waitForMessage(
    e => fromMe(w)(e) && e.data?.type === 'VL_MMM_RESPONSE' && e.data?.id === id,
    REQUEST_TIMEOUT_MS,
    'response',
  );

  w.postMessage({ type: 'VL_MMM_REQUEST', id, payload: params }, ME_ORIGIN);

  const e = await responseP;
  const elapsedMs = Math.round(performance.now() - t0);
  const d = e.data as {
    ok: boolean; status?: number; body?: unknown;
    rawBody?: string; error?: string;
  };

  return {
    ok:           d.ok,
    status:       d.status ?? null,
    elapsedMs,
    body:         d.body ?? null,
    rawBody:      d.rawBody ?? null,
    error:        d.error ?? null,
    windowOpened: !hadWindow,
  };
}
