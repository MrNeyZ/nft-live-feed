// ==UserScript==
// @name         VL VVV Stages Bridge
// @namespace    https://vl.nikki.gg
// @version      0.1.0
// @description  Bridge for victorylabs.app/tools/vvv — when opened as a popup from VL, fetches vvv.so's own get-collection-details API (same-origin, real browser session) and posts the parsed JSON back to the opener. Server-side fetch from the VL backend is blocked by vvv.so's Vercel bot checkpoint, so this has to run in a real browser tab.
// @match        https://www.vvv.so/*
// @match        https://vvv.so/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[VL-vvv-bridge]';
  const VL_ORIGINS = ['https://victorylabs.app', 'https://vl.nikki.gg'];

  // Only act when opened as a popup FROM a VL tab — never touch a normal
  // browsing session on vvv.so.
  if (!window.opener) return;

  const slug = location.pathname.replace(/^\/+/, '').split('/')[0].split(/[?#]/)[0];
  if (!slug) return;

  function send(payload) {
    for (const origin of VL_ORIGINS) {
      try { window.opener.postMessage(payload, origin); } catch (e) { /* wrong origin, ignore */ }
    }
  }

  function banner(text, ok) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;' +
      'padding:8px 14px;border-radius:8px;font:600 13px monospace;color:#fff;' +
      'background:' + (ok ? '#16a34a' : '#dc2626') + ';box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(el);
  }

  console.log(TAG, 'slug=' + slug, 'opener present');

  fetch('/api/get-collection-details', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  })
    .then((r) => r.json())
    .then((data) => {
      send({ source: 'vl-vvv-bridge', slug, ok: true, data });
      banner('VL bridge: sent ' + slug, true);
      setTimeout(() => window.close(), 700);
    })
    .catch((err) => {
      console.error(TAG, 'fetch failed', err);
      send({ source: 'vl-vvv-bridge', slug, ok: false, error: String(err && err.message || err) });
      banner('VL bridge: fetch failed', false);
    });
})();
