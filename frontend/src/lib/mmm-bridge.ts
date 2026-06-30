const ME_ORIGIN          = 'https://magiceden.io';
const ME_URL             = 'https://magiceden.io';
const READY_TIMEOUT_MS   = 25_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS   = 500;
const TAG = '[VL-bridge]';

let _meWindow: Window | null = null;

function activeWindow(): Window | null {
  if (_meWindow && !_meWindow.closed) return _meWindow;
  _meWindow = null;
  return null;
}

// ── Raw global listener ──────────────────────────────────────────────────────
// Logs EVERY message that arrives at the VL window, before any predicate
// filtering.  Installed once, never removed.  This reveals messages that
// arrive while no waitForMessage handler is active, or that fail the predicate
// for reasons we haven't logged clearly yet.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const srcIsMe = _meWindow ? e.source === _meWindow : 'no-window';
    let popupUrl = 'unknown';
    try { popupUrl = _meWindow ? (_meWindow as Window & { location: Location }).location.href : 'no-window'; }
    catch (_) { popupUrl = 'cross-origin (blocked)'; }
    console.log(
      TAG,
      '[RAW]',
      'origin=' + e.origin,
      'type=' + ((e.data as { type?: string })?.type ?? '(none)'),
      'source===meWindow=' + String(srcIsMe),
      'popupUrl=' + popupUrl,
      e.data,
    );
  });
  console.log(TAG, 'raw global message listener installed');
}

// ── waitForMessage ───────────────────────────────────────────────────────────
function waitForMessage(
  predicate: (e: MessageEvent) => boolean,
  timeoutMs: number,
  label: string,
  w?: Window,          // pass meWindow for richer rejection diagnostics
): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      console.error(TAG, `timeout fired (${label}) after ${timeoutMs}ms`);
      reject(new Error(`bridge timeout (${label}) after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(e: MessageEvent) {
      // Detailed rejection breakdown
      const originOk  = e.origin === ME_ORIGIN;
      const sourceOk  = w ? e.source === w : true;
      const typeOk    = (e.data as { type?: string })?.type;
      if (!predicate(e)) {
        console.log(
          TAG,
          `predicate REJECTED (${label})`,
          'origin=' + e.origin + ' originOk=' + originOk,
          'source===meWindow=' + (w ? String(e.source === w) : 'n/a'),
          'type=' + typeOk,
        );
        return;
      }
      console.log(TAG, `predicate ACCEPTED (${label}) -> resolving`);
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(e);
    }

    window.addEventListener('message', handler);
    console.log(TAG, `waitForMessage listening (${label}, timeout=${timeoutMs}ms)`);
  });
}

function fromMe(w: Window) {
  return (e: MessageEvent) => e.source === w && e.origin === ME_ORIGIN;
}

// ── pingUntilReady ───────────────────────────────────────────────────────────
async function pingUntilReady(w: Window, totalTimeoutMs: number): Promise<void> {
  console.log(TAG, `pingUntilReady — '*' targetOrigin, every ${PING_INTERVAL_MS}ms, up to ${totalTimeoutMs}ms`);

  const readyP = waitForMessage(
    e => fromMe(w)(e) && e.data?.type === 'VL_MMM_READY',
    totalTimeoutMs,
    'open',
    w,
  );

  let pings = 0;
  let lastPingError = '';
  const interval = setInterval(() => {
    if (w.closed) { clearInterval(interval); return; }
    pings++;
    // Try to read popup URL for diagnostics (will throw cross-origin after nav)
    let popupOrigin = 'unknown';
    try { popupOrigin = w.location.origin; } catch (_) { popupOrigin = 'cross-origin'; }
    console.log(TAG, `PING #${pings} — popup origin currently: ${popupOrigin}`);
    try {
      w.postMessage({ type: 'VL_MMM_PING' }, '*');
      console.log(TAG, `PING #${pings} postMessage sent OK`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg !== lastPingError) {
        lastPingError = msg;
        console.error(TAG, `PING #${pings} postMessage threw:`, msg);
      }
    }
  }, PING_INTERVAL_MS);

  try {
    await readyP;
  } finally {
    clearInterval(interval);
  }

  console.log(TAG, `READY received after ${pings} ping(s) — window confirmed at ${ME_ORIGIN}`);
}

// ── ensureReady ──────────────────────────────────────────────────────────────
async function ensureReady(): Promise<Window> {
  const existing = activeWindow();

  if (existing) {
    console.log(TAG, 'reusing existing ME window — pinging');
    await pingUntilReady(existing, 5_000);
    return existing;
  }

  console.log(TAG, 'no existing window — opening magiceden.io popup');
  const w = window.open(ME_URL, '_blank', 'width=960,height=680');
  if (!w) throw new Error('Popup blocked — allow popups for this site and retry');
  _meWindow = w;
  console.log(TAG, 'popup opened (_meWindow set), pinging until userscript is ready');

  await pingUntilReady(w, READY_TIMEOUT_MS);
  return w;
}

// ── Public API ───────────────────────────────────────────────────────────────
export interface BridgeParams {
  pool: string;
  seller: string;
  assetMint: string;
  assetTokenAccount: string;
  assetAmount: number;
  minPaymentAmount: number;
  isMip1?: boolean;
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
  console.log(TAG, 'requestMmmInstruction called', params);
  const t0 = performance.now();
  const hadWindow = !!activeWindow();

  const w = await ensureReady();
  const id = crypto.randomUUID();

  console.log(TAG, `sending VL_MMM_REQUEST id=${id} to popup`);
  const responseP = waitForMessage(
    e => fromMe(w)(e) && e.data?.type === 'VL_MMM_RESPONSE' && e.data?.id === id,
    REQUEST_TIMEOUT_MS,
    'response',
    w,
  );

  w.postMessage({ type: 'VL_MMM_REQUEST', id, payload: params }, ME_ORIGIN);
  console.log(TAG, 'VL_MMM_REQUEST sent');

  const e = await responseP;
  console.log(TAG, 'VL_MMM_RESPONSE received', e.data);
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
