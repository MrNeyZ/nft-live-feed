const ME_ORIGIN          = 'https://magiceden.io';
const ME_URL             = 'https://magiceden.io';
const READY_TIMEOUT_MS   = 25_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS   = 500;   // re-ping while waiting for page to load
const TAG = '[VL-bridge]';

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
      console.error(TAG, `timeout fired (${label}) after ${timeoutMs}ms`);
      reject(new Error(`bridge timeout (${label}) after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(e: MessageEvent) {
      console.log(TAG, `message received — origin=${e.origin} type=${(e.data as {type?:string})?.type} label=${label}`);
      if (!predicate(e)) {
        console.log(TAG, `  predicate rejected (${label}) — origin=${e.origin} type=${(e.data as {type?:string})?.type}`);
        return;
      }
      console.log(TAG, `  predicate accepted → resolving (${label})`);
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

// Send PING repeatedly until we get READY back.
//
// Root cause of prior failure: window.open() returns a Window whose initial
// origin is the opener's origin (victorylabs.app) during the about:blank
// phase before navigation commits to magiceden.io.  postMessage(msg,
// 'https://magiceden.io') throws synchronously when the window's current
// origin doesn't match the targetOrigin — even while it's mid-navigation.
//
// Fix: use '*' as targetOrigin for PING only.  PING carries no sensitive
// data ({type:'VL_MMM_PING'}).  The userscript validates event.origin on its
// side.  Once magiceden.io finishes loading and the userscript fires, it
// receives the next PING and responds.  REQUEST keeps ME_ORIGIN because by
// then we have confirmed the window is at magiceden.io (proven by READY).
async function pingUntilReady(w: Window, totalTimeoutMs: number): Promise<void> {
  console.log(TAG, `pingUntilReady — '*' targetOrigin, every ${PING_INTERVAL_MS}ms, up to ${totalTimeoutMs}ms`);

  const readyP = waitForMessage(
    e => fromMe(w)(e) && e.data?.type === 'VL_MMM_READY',
    totalTimeoutMs,
    'open',
  );

  let pings = 0;
  let lastPingError = '';
  const interval = setInterval(() => {
    if (w.closed) { clearInterval(interval); return; }
    pings++;
    console.log(TAG, `sending PING #${pings} (targetOrigin='*')`);
    try {
      // '*' intentional — window may still be on about:blank/victorylabs.app
      // during navigation to magiceden.io; PING contains no sensitive data
      w.postMessage({ type: 'VL_MMM_PING' }, '*');
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
  console.log(TAG, 'popup opened, pinging until userscript is ready');

  await pingUntilReady(w, READY_TIMEOUT_MS);
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
  console.log(TAG, 'requestMmmInstruction called', params);
  const t0 = performance.now();
  const hadWindow = !!activeWindow();

  const w = await ensureReady();
  const id = crypto.randomUUID();

  console.log(TAG, `sending VL_MMM_REQUEST id=${id}`);
  const responseP = waitForMessage(
    e => fromMe(w)(e) && e.data?.type === 'VL_MMM_RESPONSE' && e.data?.id === id,
    REQUEST_TIMEOUT_MS,
    'response',
  );

  w.postMessage({ type: 'VL_MMM_REQUEST', id, payload: params }, ME_ORIGIN);
  console.log(TAG, 'VL_MMM_REQUEST sent, waiting for VL_MMM_RESPONSE');

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
