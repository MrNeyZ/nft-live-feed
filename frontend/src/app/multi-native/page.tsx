'use client';

// VictoryLabs — Multi-tab (native) — kept as a fallback/reference route while
// /multi (the default) now renders the same native layout. Both render the
// shared <MultiNativeView />; do not delete until verification is complete.

import { useEffect } from 'react';
import { MultiNativeView } from './MultiNativeView';

export default function MultiNativePage() {
  useEffect(() => { document.title = 'VictoryLabs — Multi-tab (native)'; }, []);
  return <MultiNativeView />;
}
