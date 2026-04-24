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

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/access';
    return NextResponse.redirect(url, 307);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/'],
};
