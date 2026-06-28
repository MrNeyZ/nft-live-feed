// Gate screen CSS — kept in a plain (non-client) module so it can be
// imported by the server-side layout and injected directly into the HTML
// <head>. This bypasses the Next.js JS chunk cache (which is immutable
// and content-addressed, so small string changes inside a chunk don't
// change the chunk URL, causing browsers to serve stale CSS indefinitely).
// Injecting via the HTML means every new deploy is picked up immediately.

export const GATE_CSS = `
.gate-root, .gate-root *, .gate-root *::before, .gate-root *::after {
  box-sizing: border-box;
}
.gate-root {
  position: fixed; inset: 0;
  min-height: 100vh;
  padding: 60px 24px;
  display: flex; align-items: center; justify-content: center;
  color: #9a9ab4;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  background: #050308;
  background-image:
    radial-gradient(ellipse 140% 55% at 65% -5%, rgba(80, 50, 150, 0.10) 0%, transparent 65%),
    radial-gradient(ellipse 70%  40% at  5% 90%, rgba(50, 30, 100, 0.07) 0%, transparent 60%);
  overflow-x: hidden;
  overflow-y: auto;
}
.gate-root::before {
  content: "";
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse 55% 42% at 50% 36%, rgba(168, 144, 232, 0.08) 0%, transparent 70%),
    radial-gradient(ellipse 45% 22% at 50% 92%, rgba(124, 95, 208, 0.05) 0%, transparent 70%);
}

@keyframes gateBusyDots {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40%           { opacity: 1;    transform: translateY(-1px); }
}
.gate-dot       { animation: gateBusyDots 1.2s infinite both; display: inline-block; }
.gate-dot:nth-child(2) { animation-delay: 0.15s; }
.gate-dot:nth-child(3) { animation-delay: 0.30s; }

@keyframes gateReveal {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
.gate-reveal { animation: gateReveal 0.22s ease-out both; }

.vl-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 260px;
  height: 52px;
  padding: 0 28px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: #1a1226;
  background:
    linear-gradient(135deg, #a890e8, #7c5fd0) padding-box,
    linear-gradient(135deg, #a890e8, #7c5fd0) border-box;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 8px 30px -6px rgba(168, 144, 232, 0.55);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-cta:hover:not([disabled]) {
  transform: translateY(-1px);
  background:
    linear-gradient(135deg, #b8a2ed, #8d70d8) padding-box,
    linear-gradient(135deg, #b8a2ed, #8d70d8) border-box;
  box-shadow: 0 12px 36px -6px rgba(168, 144, 232, 0.70);
}
.vl-cta:active:not([disabled]) {
  transform: translateY(1px);
  background:
    linear-gradient(135deg, #9272cc, #6a4fb8) padding-box,
    linear-gradient(135deg, #9272cc, #6a4fb8) border-box;
  box-shadow: 0 4px 14px -4px rgba(124, 95, 208, 0.45);
}
.vl-cta[disabled] {
  cursor: not-allowed;
  color: #241f3b;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  border-color: rgba(255, 255, 255, 0.05);
  box-shadow: 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

.vl-cta.vl-cta--block {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  min-width: 0;
  height: 56px;
  padding: 0 28px;
  letter-spacing: 2px;
  font-size: 12.5px;
}
.vl-cta.vl-cta--block .vl-cta-label {
  font-size: 12.5px; font-weight: 700; letter-spacing: 2px; color: #1a1226;
  text-transform: uppercase;
}
.vl-cta.vl-cta--block[disabled] .vl-cta-label {
  color: #241f3b;
}

.vl-wallet-field {
  display: flex;
  align-items: stretch;
  gap: 0;
  width: 100%;
  max-width: 420px;
  height: 52px;
  border: 1px solid rgba(168, 144, 232, 0.22);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(26, 20, 48, 0.7) 0%, rgba(18, 13, 36, 0.7) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 8px 24px -8px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.vl-wallet-field:focus-within {
  border-color: rgba(168, 144, 232, 0.5);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(168, 144, 232, 0.25),
    0 8px 24px -8px rgba(0, 0, 0, 0.55);
}
.vl-wallet-field .vl-dot {
  flex-shrink: 0;
  align-self: center;
  width: 6px; height: 6px;
  margin-left: 14px;
  border-radius: 50%;
  background: #a890e8;
  box-shadow: 0 0 10px rgba(168, 144, 232, 0.8);
}
.vl-wallet-field .vl-wallet-text {
  align-self: center;
  padding: 0 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12.5px;
  font-weight: 500;
  color: #a890e8;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  min-width: 0;
  border-right: 1px solid rgba(168, 144, 232, 0.14);
  margin-right: 2px;
  height: 32px; display: flex; align-items: center;
}
.vl-wallet-field input.vl-passphrase {
  flex: 1;
  min-width: 0;
  padding: 0 14px;
  background: transparent;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13.5px;
  color: #f0eef8;
  caret-color: #a890e8;
  letter-spacing: 0.2px;
}
.vl-wallet-field input.vl-passphrase::placeholder {
  color: #55556a;
  letter-spacing: 0.5px;
}
.vl-wallet-field input.vl-passphrase:disabled {
  color: #9a9ab4;
}

.vl-arrow {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  align-self: center;
  margin-right: 4px;
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  color: #1a1226;
  background:
    linear-gradient(135deg, #a890e8, #7c5fd0) padding-box,
    linear-gradient(135deg, #a890e8, #7c5fd0) border-box;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 4px 14px -4px rgba(168, 144, 232, 0.50);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-arrow:hover:not([disabled]) {
  transform: translateY(-1px);
  background:
    linear-gradient(135deg, #b8a2ed, #8d70d8) padding-box,
    linear-gradient(135deg, #b8a2ed, #8d70d8) border-box;
  box-shadow: 0 6px 20px -4px rgba(168, 144, 232, 0.65);
}
.vl-arrow:active:not([disabled]) {
  transform: translateY(1px);
  background:
    linear-gradient(135deg, #9272cc, #6a4fb8) padding-box,
    linear-gradient(135deg, #9272cc, #6a4fb8) border-box;
  box-shadow: 0 2px 8px -2px rgba(124, 95, 208, 0.40);
}
.vl-arrow[disabled] {
  cursor: not-allowed;
  color: #241f3b;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  box-shadow: 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

.vl-change {
  background: none; border: none; cursor: pointer;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 1.5px;
  color: #9a9ab4;
  padding: 4px 2px;
  transition: color 0.12s;
  align-self: flex-end;
}
.vl-change:hover { color: #a890e8; }

.vl-error {
  display: flex; align-items: center; gap: 8px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: #d96867;
  letter-spacing: 0.5px;
}
.vl-error .vl-err-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #d96867; box-shadow: 0 0 8px rgba(216, 117, 117, 0.5);
}

.gate-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  width: 100%;
  max-width: 460px;
  position: relative;
  z-index: 1;
  transform: translateY(5vh);
}
.gate-top-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 40px;
  margin-bottom: 40px;
}
.gate-hero-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 0;
}

.gate-headline {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 2px;
  line-height: 1.2;
  text-transform: uppercase;
  color: #f3f1fb;
  text-align: center;
  margin: 0;
}
.gate-sub {
  font-size: 15px;
  color: #8888a8;
  letter-spacing: 0.1px;
  text-align: center;
  max-width: 340px;
  line-height: 1.65;
  margin: 0;
}

.gate-form {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  width: 100%;
  max-width: 420px;
}
.gate-field-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 18px;
}
.gate-mode-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 420px;
}

.gate-helper-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin-top: 22px;
}
.gate-helper-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.38);
  letter-spacing: 0.2px;
  text-align: center;
  margin: 0;
}
.gate-social-row {
  display: flex;
  align-items: center;
  gap: 20px;
}
.gate-social-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(168, 144, 232, 0.55);
  transition: color 0.15s;
  text-decoration: none;
}
.gate-social-icon:hover { color: #a890e8; }

.vl-modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(5, 3, 8, 0.82);
  backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  animation: gateReveal 0.14s ease-out both;
}
.vl-modal {
  width: 100%; max-width: 360px; margin: 0 16px;
  background: linear-gradient(180deg, #130f20 0%, #0d0a1a 100%);
  border: 1px solid rgba(168, 144, 232, 0.18);
  border-radius: 16px;
  padding: 24px;
  box-shadow:
    0 0 0 1px rgba(168, 144, 232, 0.06),
    0 24px 64px -12px rgba(0, 0, 0, 0.85);
}
.vl-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px;
}
.vl-modal-title {
  font-size: 11px; font-weight: 700; letter-spacing: 2px;
  text-transform: uppercase; color: #c4b8f0;
}
.vl-modal-close {
  background: none; border: none; cursor: pointer; font-family: inherit;
  color: #5a5880; font-size: 13px; line-height: 1;
  padding: 4px 6px; border-radius: 4px;
  transition: color 0.14s, background 0.14s;
}
.vl-modal-close:hover { color: #9a9ab4; background: rgba(255, 255, 255, 0.05); }
.vl-modal-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.vl-modal-wallet {
  width: 100%; display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  background: rgba(168, 144, 232, 0.05);
  border: 1px solid rgba(168, 144, 232, 0.10);
  border-radius: 10px;
  cursor: pointer; font-family: inherit;
  transition: background 0.14s, border-color 0.14s;
}
.vl-modal-wallet:hover:not([disabled]) {
  background: rgba(168, 144, 232, 0.12);
  border-color: rgba(168, 144, 232, 0.25);
}
.vl-modal-wallet[disabled] { opacity: 0.5; cursor: not-allowed; }
.vl-modal-wallet-icon { width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; }
.vl-modal-wallet-name {
  font-size: 13px; font-weight: 600; color: #d4ccf0;
  flex: 1; text-align: left; letter-spacing: 0.2px;
}
.vl-modal-wallet-badge {
  font-size: 9px; font-weight: 700; letter-spacing: 1.2px;
  text-transform: uppercase; color: #43B984;
  background: rgba(67, 185, 132, 0.10);
  border: 1px solid rgba(67, 185, 132, 0.22);
  border-radius: 4px; padding: 2px 7px;
}
.vl-modal-empty {
  font-size: 12px; color: #5a5880; text-align: center;
  padding: 20px 0; margin: 0; line-height: 1.6;
}
.vl-modal-err {
  margin-top: 14px; display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: #e05a6a;
}
`;
