// ==UserScript==
// @name         VL MMM Bid Accept Bridge
// @namespace    https://vl.nikki.gg
// @version      0.3.2
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
  const TAG       = '[VL-userscript]';

  // Both known VL origins -- strict allowlist, not a wildcard
  const VL_ORIGINS = new Set([
    'https://vl.nikki.gg',
    'https://victorylabs.app',
  ]);

  console.log(TAG, 'userscript loaded - origin=' + location.origin + ' opener=' + (window.opener ? 'present' : 'null'));

  // Core fetch
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

    console.log(TAG, 'calling fetch() ->', url);
    const t0 = performance.now();

    try {
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });

      const elapsedMs = Math.round(performance.now() - t0);
      console.log(TAG, 'fetch finished - status=' + resp.status + ' elapsed=' + elapsedMs + 'ms');

      const rawBody = await resp.text();
      let data = null;
      try { data = JSON.parse(rawBody); } catch (_) { /* not JSON */ }

      const result = {
        ok: resp.ok, status: resp.status, elapsedMs, url, data, rawBody,
        error: resp.ok ? null : (data?.message ?? data?.error ?? ('HTTP ' + resp.status)),
      };

      if (resp.ok) console.log(TAG, 'fetch OK', result);
      else         console.warn(TAG, 'fetch non-OK', result);
      return result;

    } catch (err) {
      const elapsedMs = Math.round(performance.now() - t0);
      console.error(TAG, 'fetch threw', err.message, 'elapsed=' + elapsedMs + 'ms');
      return {
        ok: false, status: null, elapsedMs, url,
        data: null, rawBody: null, error: err.message ?? String(err),
      };
    }
  }

  // postMessage bridge
  // targetOrigin is event.origin of the incoming message -- whatever VL domain
  // actually sent this request (vl.nikki.gg or victorylabs.app)
  function postToVl(target, msg, targetOrigin) {
    console.log(TAG, 'postToVl -> type=' + msg.type + ' id=' + (msg.id ?? '-') + ' to=' + targetOrigin);
    try {
      target.postMessage(msg, targetOrigin);
      console.log(TAG, 'postToVl sent OK');
    } catch (e) {
      console.warn(TAG, 'postToVl failed', e);
    }
  }

  window.addEventListener('message', async (event) => {
    console.log(TAG, 'message event received - origin=' + event.origin + ' type=' + (event.data?.type ?? 'none'));

    if (!VL_ORIGINS.has(event.origin)) {
      console.log(TAG, '  ignored - origin not in allowlist (' + event.origin + ')');
      return;
    }

    const { type, id, payload } = event.data ?? {};

    if (type === 'VL_MMM_PING') {
      console.log(TAG, 'PING received - sending READY');
      postToVl(event.source, { type: 'VL_MMM_READY' }, event.origin);
      return;
    }

    if (type === 'VL_MMM_REQUEST') {
      console.log(TAG, 'REQUEST received id=' + id, payload);
      const result = await vlMmmFulfillBuy(payload);
      console.log(TAG, 'sending RESPONSE id=' + id + ' ok=' + result.ok + ' status=' + result.status);
      postToVl(event.source, {
        type:    'VL_MMM_RESPONSE',
        id,
        ok:      result.ok,
        status:  result.status,
        body:    result.data,
        rawBody: result.rawBody,
        error:   result.error,
      }, event.origin);
    }
  });

  // Announce ready to opener if present (not relied upon -- ping handshake is primary)
  if (window.opener) {
    console.log(TAG, 'window.opener present - sending VL_MMM_READY to opener');
    try {
      window.opener.postMessage({ type: 'VL_MMM_READY' }, '*');
      console.log(TAG, 'VL_MMM_READY sent to opener');
    } catch (e) {
      console.warn(TAG, 'failed to post to opener', e);
    }
  } else {
    console.log(TAG, 'window.opener is null - relying on ping handshake');
  }

  window.vlMmmFulfillBuy = vlMmmFulfillBuy;
  console.log(TAG, 'MMM bridge v0.3.2 ready - postMessage listener active');
})();
