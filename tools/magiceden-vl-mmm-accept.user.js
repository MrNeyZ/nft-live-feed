// ==UserScript==
// @name         VL MMM Bid Accept Bridge
// @namespace    https://vl.nikki.gg
// @version      0.5.3
// @description  VictoryLabs MMM bridge — v0.5.3 removes hardcoded RPC key; signed-but-unsent txs are submitted by VL's backend instead
// @author       VictoryLabs
// @match        https://magiceden.io/*
// @match        https://www.magiceden.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const ME_IXS = 'https://api-mainnet.magiceden.io/v2/instructions/mmm/sol-fulfill-buy';
  const TAG         = '[VL-userscript]';

  // Both known VL origins -- strict allowlist, not a wildcard
  const VL_ORIGINS = new Set([
    'https://vl.nikki.gg',
    'https://victorylabs.app',
  ]);

  // Version + allowlist confirmation -- check this in the ME console first
  console.log(TAG, 'VERSION=0.5.3 loaded - origin=' + location.origin + ' opener=' + (window.opener ? 'present' : 'null'));
  console.log(TAG, 'VL_ORIGINS allowlist:', Array.from(VL_ORIGINS));

  // Core fetch
  async function vlMmmFulfillBuy(params) {
    const { pool, seller, assetMint, assetTokenAccount, assetAmount = 1, minPaymentAmount, isMip1 } = params ?? {};

    if (!pool || !seller || !assetMint || !assetTokenAccount || minPaymentAmount == null) {
      return {
        ok: false, status: null, elapsedMs: 0, url: null,
        data: null, rawBody: null,
        error: 'Missing required param(s): pool, seller, assetMint, assetTokenAccount, minPaymentAmount',
      };
    }

    const baseUrl = ME_IXS;
    // tokenStandard=4 = ProgrammableNonFungible; tells ME to use versioned tx with ALTs for pNFT
    const tokenStandard = isMip1 ? 4 : 0;
    console.log(TAG, 'isMip1=' + !!isMip1 + ' tokenStandard=' + tokenStandard + ' -> endpoint=sol-fulfill-buy');

    const url = baseUrl
      + '?pool='                + encodeURIComponent(pool)
      + '&seller='              + encodeURIComponent(seller)
      + '&assetMint='           + encodeURIComponent(assetMint)
      + '&assetTokenAccount='   + encodeURIComponent(assetTokenAccount)
      + '&assetAmount='         + encodeURIComponent(assetAmount)
      + '&minPaymentAmount='    + encodeURIComponent(minPaymentAmount)
      + '&tokenStandard='       + tokenStandard;

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

  // Minimal compact-u16 decoder (no library needed)
  function decodeCompactU16(bytes) {
    let val = 0, shift = 0;
    while (true) {
      const b = bytes.shift();
      val |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return val;
  }

  // Parse raw tx bytes to count Address Lookup Tables (no @solana/web3.js needed).
  // Returns altCount, or -1 if not a versioned tx.
  function parseALTCount(txData) {
    try {
      const bytes = Array.from(txData);
      const numSigs = decodeCompactU16(bytes);
      bytes.splice(0, numSigs * 64);           // skip signatures
      const versionByte = bytes.shift();
      if ((versionByte & 0x80) === 0) return -1; // legacy tx — no ALTs
      // v0 message header: 3 bytes
      bytes.splice(0, 3);
      // static account keys
      const numKeys = decodeCompactU16(bytes);
      bytes.splice(0, numKeys * 32);
      bytes.splice(0, 32); // recent blockhash
      // instructions
      const numIxs = decodeCompactU16(bytes);
      for (let i = 0; i < numIxs; i++) {
        bytes.shift(); // program index
        const nAccts = decodeCompactU16(bytes);
        bytes.splice(0, nAccts);
        const dLen = decodeCompactU16(bytes);
        bytes.splice(0, dLen);
      }
      return decodeCompactU16(bytes); // ALT count
    } catch (_) { return -1; }
  }

  // Try to sign + send the versioned tx from within the ME popup context.
  // No @solana/web3.js needed — passes a duck-typed object with serialize().
  // Solflare (present on ME) accepts duck-typed objects; Phantom may vary.
  async function trySignInPopup(txData) {
    const altCount = parseALTCount(txData);
    if (altCount <= 0) {
      console.log(TAG, 'trySignInPopup — legacy tx or no ALTs (' + altCount + ') — VL frontend handles');
      return null;
    }
    console.log(TAG, 'trySignInPopup — ' + altCount + ' ALT(s), attempting in-popup sign');

    // Prefer Solflare (more lenient duck-typing); fall back to window.solana
    const sol = window.solflare ?? window.solana ?? window.phantom?.solana;
    if (!sol) { console.warn(TAG, 'no wallet in ME popup'); return null; }
    const pubkey = sol.publicKey?.toBase58?.() ?? sol.publicKey;
    if (!pubkey) { console.warn(TAG, 'wallet not connected in ME popup'); return null; }
    console.log(TAG, 'trySignInPopup — wallet=' + pubkey);

    try { window.focus(); } catch (_) {}

    const bytes = new Uint8Array(txData);
    // Duck-typed vtx — wallets that call .serialize() without instanceof check will work
    const fakeTx = {
      serialize: () => bytes,
      version: 0,
      signatures: [],
    };

    // Try signAndSendTransaction
    for (const [label, provider] of [
      ['solflare', window.solflare],
      ['solana', window.solana],
      ['phantom', window.phantom?.solana],
    ]) {
      if (!provider?.signAndSendTransaction) continue;
      try {
        console.log(TAG, 'trySignInPopup — trying ' + label + '.signAndSendTransaction');
        const resp = await provider.signAndSendTransaction(fakeTx, { skipPreflight: true });
        const sig = resp?.signature ?? resp;
        if (typeof sig === 'string' && sig.length > 20) {
          console.log(TAG, 'trySignInPopup — ' + label + ' OK sig=' + sig);
          return { signature: sig };
        }
      } catch (e) {
        console.warn(TAG, 'trySignInPopup — ' + label + ' failed:', e.message);
      }
    }

    // Try signTransaction only — do NOT send from here. Sending requires an
    // RPC endpoint/API key; the popup has no safe way to hold one (a userscript
    // is plaintext, readable by anyone who installs it — see Audit #8 M1 in
    // research_backlog.md). Return the signed bytes so VL can submit them
    // through its own backend proxy (/tools/mmm-pools/send-tx), same as every
    // other signed-but-unsent path in this bridge already does.
    for (const [label, provider] of [
      ['solflare', window.solflare],
      ['solana', window.solana],
    ]) {
      if (!provider?.signTransaction) continue;
      try {
        console.log(TAG, 'trySignInPopup — trying ' + label + '.signTransaction');
        const signed = await provider.signTransaction(fakeTx);
        const serialized = signed?.serialize?.() ?? bytes;
        const signedTxBase64 = btoa(String.fromCharCode(...serialized));
        console.log(TAG, 'trySignInPopup — ' + label + ' signed — returning bytes for VL to submit');
        return { signedTxBase64 };
      } catch (e) {
        console.warn(TAG, 'trySignInPopup — ' + label + ' signTransaction failed:', e.message);
      }
    }

    console.warn(TAG, 'trySignInPopup — all providers failed');
    return null;
  }

  // postMessage bridge
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
    // Log EVERY message before any filtering
    console.log(TAG, '[RAW] message received - origin=' + event.origin + ' type=' + (event.data?.type ?? 'none') + ' inAllowlist=' + VL_ORIGINS.has(event.origin), event.data);

    if (!VL_ORIGINS.has(event.origin)) {
      console.warn(TAG, 'REJECTED - origin not in allowlist:', event.origin, '(allowlist=' + Array.from(VL_ORIGINS).join(',') + ')');
      return;
    }
    console.log(TAG, 'ACCEPTED - origin=' + event.origin);

    const { type, id, payload } = event.data ?? {};

    if (type === 'VL_MMM_PING') {
      console.log(TAG, 'PING received - sending READY');
      postToVl(event.source, { type: 'VL_MMM_READY' }, event.origin);
      return;
    }

    if (type === 'VL_MMM_REQUEST') {
      console.log(TAG, 'REQUEST received id=' + id, payload);
      const result = await vlMmmFulfillBuy(payload);

      // If we got tx bytes, try to sign+send inside this ME popup
      // (avoids Phantom ALT-resolution failure on the VL origin)
      if (result.ok && result.data?.tx?.data) {
        const signResult = await trySignInPopup(result.data.tx.data);
        if (signResult?.signature) {
          console.log(TAG, 'in-popup signing succeeded — returning presigned response');
          postToVl(event.source, {
            type:    'VL_MMM_RESPONSE',
            id,
            ok:      true,
            status:  200,
            body:    { presigned: true, signature: signResult.signature },
            rawBody: JSON.stringify({ presigned: true, signature: signResult.signature }),
            error:   null,
          }, event.origin);
          return;
        }
        if (signResult?.signedTxBase64) {
          console.log(TAG, 'in-popup signing succeeded (unsent) — returning signed tx for VL to submit');
          postToVl(event.source, {
            type:    'VL_MMM_RESPONSE',
            id,
            ok:      true,
            status:  200,
            body:    { presignedUnsent: true, signedTxBase64: signResult.signedTxBase64 },
            rawBody: JSON.stringify({ presignedUnsent: true }),
            error:   null,
          }, event.origin);
          return;
        }
        console.warn(TAG, 'in-popup signing failed — falling back to tx-bytes response');
      }

      // Fallback: return tx bytes for VL frontend to sign (original behaviour)
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
  console.log(TAG, 'MMM bridge v0.5.3 ready - postMessage listener active - waiting for PING from VL');
})();
