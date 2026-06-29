// ==UserScript==
// @name         VL MMM Bid Accept Bridge
// @namespace    https://vl.nikki.gg
// @version      0.1.0
// @description  Exposes window.vlMmmFulfillBuy() on magiceden.io so VictoryLabs can call the ME instruction endpoint from the correct CORS origin.
// @author       VictoryLabs
// @match        https://magiceden.io/*
// @match        https://www.magiceden.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const ME_IXS = 'https://api-mainnet.magiceden.io/v2/instructions/mmm/sol-fulfill-buy';

  /**
   * window.vlMmmFulfillBuy(params) → Promise<result>
   *
   * params:
   *   pool            string  — pool public key
   *   seller          string  — seller wallet public key
   *   assetMint       string  — NFT mint address
   *   assetAmount     number  — always 1
   *   minPaymentAmount number — floor(spotPrice * 9800 / 10000) in lamports
   *
   * result:
   *   {
   *     ok:         boolean,
   *     status:     number,
   *     elapsedMs:  number,
   *     url:        string,
   *     data:       any,       // parsed JSON if Content-Type is JSON
   *     rawBody:    string,    // raw response text
   *     error:      string | null,
   *   }
   */
  async function vlMmmFulfillBuy(params) {
    const { pool, seller, assetMint, assetAmount = 1, minPaymentAmount } = params ?? {};

    if (!pool || !seller || !assetMint || minPaymentAmount == null) {
      return {
        ok: false, status: null, elapsedMs: 0,
        url: null, data: null, rawBody: null,
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
        ok:        resp.ok,
        status:    resp.status,
        elapsedMs,
        url,
        data,
        rawBody,
        error: resp.ok ? null : (data?.message ?? data?.error ?? `HTTP ${resp.status}`),
      };

      if (resp.ok) {
        console.log('[VL] vlMmmFulfillBuy OK', result);
      } else {
        console.warn('[VL] vlMmmFulfillBuy non-OK', result);
      }
      return result;

    } catch (err) {
      const elapsedMs = Math.round(performance.now() - t0);
      const result = {
        ok: false, status: null, elapsedMs, url,
        data: null, rawBody: null,
        error: err.message ?? String(err),
      };
      console.error('[VL] vlMmmFulfillBuy network error', result);
      return result;
    }
  }

  window.vlMmmFulfillBuy = vlMmmFulfillBuy;
  console.log('[VL] MMM bridge ready — window.vlMmmFulfillBuy() available');
})();
