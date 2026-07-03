import { NextRequest, NextResponse } from 'next/server';

// Edge-level redirect for the root path.
//
// Why: `app/page.tsx` calls `redirect('/access')`, which in isolation would
// return an HTTP 307. But the root layout wraps `{children}` in the `<Gate>`
// client component, and that client boundary causes Next.js to serialize
// the NEXT_REDIRECT error into the RSC stream rather than surfacing it as
// a 307 status code. The browser ends up with 200 + layout HTML, Gate
// hydrates, and the user briefly sees Gate's mode-select UI before the
// stream-level redirect marker takes effect.
//
// Middleware runs before the layout and before any client boundary, so the
// browser receives a real HTTP 307 at request time with no UI flash.

// ── Audit Mode (read-only view-gate bypass) ─────────────────────────────────
// When a request carries `?audit=<AUDIT_BYPASS_TOKEN>` and the value matches
// the server-only env secret, set a boolean cookie that unlocks the frontend
// view gate (Gate.tsx) so pages like /feed render live UI without a wallet
// SIWS login — for UX/UI audits of gated pages.
//
// Security invariants (do not relax without review):
//   - The token is compared SERVER-SIDE ONLY, here in middleware (Edge/server
//     runtime). It is never referenced in any client component, so it is
//     never inlined into the client bundle.
//   - The token is never logged and never written into the cookie. The cookie
//     value is the constant marker `1` — a boolean, not the secret.
//   - The cookie ONLY unlocks viewing. It does not mint an auth token
//     (TOKEN_KEY in auth.ts is untouched), so `authHeaders()` stays empty and
//     every backend requireAuth (write) endpoint still rejects the session.
//   - The feature is fully inert when AUDIT_BYPASS_TOKEN is unset/empty — a
//     request with `?audit=...` then behaves exactly as it does today.
const AUDIT_COOKIE = 'vl_audit_view';

function applyAuditCookie(req: NextRequest, res: NextResponse): void {
  const secret = process.env.AUDIT_BYPASS_TOKEN;
  if (!secret) return; // feature off unless the secret is configured
  const presented = req.nextUrl.searchParams.get('audit');
  if (presented === secret) {
    res.cookies.set(AUDIT_COOKIE, '1', {
      path:     '/',
      sameSite: 'lax',
      secure:   true,
      httpOnly: false,       // Gate.tsx (client) reads this boolean marker
      maxAge:   8 * 60 * 60, // 8h — an audit session, not a standing bypass
    });
  }
}

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/access';
    const res = NextResponse.redirect(url, 307);
    applyAuditCookie(req, res);
    return res;
  }
  const res = NextResponse.next();
  applyAuditCookie(req, res);
  return res;
}

export const config = {
  // '/' keeps the existing root redirect. The gated view routes are included
  // so a first landing at e.g. /feed?audit=TOKEN sets the cookie; once set,
  // it unlocks every page via Gate.tsx regardless of matcher coverage.
  matcher: ['/', '/feed', '/dashboard', '/mints', '/tools', '/tools/:path*', '/multi'],
};
