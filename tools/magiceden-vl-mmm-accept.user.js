// ==UserScript==
// @name         VL MMM Bid Accept Bridge
// @namespace    https://vl.nikki.gg
// @version      0.2.0
// @description  VictoryLabs MMM bridge
// @author       VictoryLabs
// @match        https://magiceden.io/*
// @match        https://www.magiceden.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const ME_IXS    = 'https://api-mainnet.magiceden.io/v2/instructions/mmm/sol-fulfill-buy';
  const VL_ORIGIN = 'https://vl.nikki.gg';

  // ── Core fetch ──────────────────────────────────────────────────────────────
  async function vlMmmFulfillBuy(params) {
    const { pool, seller, assetMint, assetAmount = 1, minPaymentAmount } = params ?? {};

    if (!pool || !seller || !assetMint || minPaymentAmount == null) {
      return {
        ok: false, status: null, elapsedMs: 0, url: null,
        data: null, rawBody: null,
        error: 'Missing required param(s): pool, seller, assetMint, minPaymentAmount',
      };
    }

    const url = ME_IXS
      + '?pool='             + encodeURIComponent(pool)
      + '&seller='           + encodeURIComponent(seller)
      + '&assetMint='        + encodeURIComponent(assetMint)
      + '&assetAmount='      + encodeURIComponent(assetAmount)
      + '&minPaymentAmount=' + encodeURIComponent(minPaymentAmount);

    console.log('[VL] vlMmmFulfillBuy → GET', url);
    const t0 = performance.now();

    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });

      const elapsedMs = Math.round(performance.now() - t0);
      const rawBody   = await resp.text();
      let data = null;
      try { data = JSON.parse(rawBody); } catch (_) { /* not JSON */ }

      const result = {
        ok: resp.ok, status: resp.status, elapsedMs, url, data, rawBody,
        error: resp.ok ? null : (data?.message ?? data?.error ?? `HTTP ${resp.status}`),
      };

      if (resp.ok) console.log('[VL] vlMmmFulfillBuy OK', result);
      else         console.warn('[VL] vlMmmFulfillBuy non-OK', result);
      return result;

    } catch (err) {
      const elapsedMs = Math.round(performance.now() - t0);
      const result = {
        ok: false, status: null, elapsedMs, url,
        data: null, rawBody: null, error: err.message ?? String(err),
      };
      console.error('[VL] vlMmmFulfillBuy network error', result);
      return result;
    }
  }

  // ── postMessage bridge ──────────────────────────────────────────────────────
  // Protocol:
  //   VL → ME  { type: 'VL_MMM_PING' }
  //   ME → VL  { type: 'VL_MMM_READY' }
  //
  //   VL → ME  { type: 'VL_MMM_REQUEST', id, payload: { pool, seller, assetMint, assetAmount, minPaymentAmount } }
  //   ME → VL  { type: 'VL_MMM_RESPONSE', id, ok, status, body, rawBody, error }

  function postToVl(target, msg) {
    try { target.postMessage(msg, VL_ORIGIN); } catch (e) {
      console.warn('[VL] postToVl failed', e);
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.origin !== VL_ORIGIN) return;

    const { type, id, payload } = event.data ?? {};

    if (type === 'VL_MMM_PING') {
      console.log('[VL] PING received → sending READY');
      postToVl(event.source, { type: 'VL_MMM_READY' });
      return;
    }

    if (type === 'VL_MMM_REQUEST') {
      console.log('[VL] REQUEST received', id, payload);
      const result = await vlMmmFulfillBuy(payload);
      postToVl(event.source, {
        type:    'VL_MMM_RESPONSE',
        id,
        ok:      result.ok,
        status:  result.status,
        body:    result.data,
        rawBody: result.rawBody,
        error:   result.error,
      });
    }
  });

  // Announce ready to opener (VL page that called window.open)
  if (window.opener) {
    try {
      window.opener.postMessage({ type: 'VL_MMM_READY' }, VL_ORIGIN);
      console.log('[VL] sent VL_MMM_READY to opener');
    } catch (_) {}
  }

  window.vlMmmFulfillBuy = vlMmmFulfillBuy;
  console.log('[VL] MMM bridge v0.2 ready — window.vlMmmFulfillBuy() + postMessage listener active');
})();
