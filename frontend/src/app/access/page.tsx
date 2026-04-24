'use client';

// The Gate component is mounted by app/layout.tsx around all children, so
// when an unauthed visitor hits /access they see the LoginScreen and when
// an authed-but-unmoded visitor hits it they see Select Runtime. This page
// only needs to handle the third state — already authed with an active
// mode — by bouncing them onto the real app at /dashboard, otherwise Gate
// would fall through to render our (intentionally empty) children and the
// screen would look blank.

import { useEffect } from 'react';
import { isAuthed } from '@/runtime/auth';
import { fetchMode } from '@/runtime/mode';

export default function AccessPage() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isAuthed()) return;
      const mode = await fetchMode();
      if (cancelled) return;
      if (mode && mode !== 'off') window.location.replace('/dashboard');
    })();
    return () => { cancelled = true; };
  }, []);
  return null;
}
