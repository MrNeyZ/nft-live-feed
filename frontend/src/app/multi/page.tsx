'use client';

// VictoryLabs — Multi-tab (default). Renders the native two-panel layout
// directly (no iframes): LEFT DashboardCollectionsPanel (trending-collections
// table) · RIGHT SalesFeedPanel — via the shared <MultiNativeView />. The
// previous iframe implementation (embedded /mints, /tools/rare-feed, /feed)
// is retired; Rare Feed / Mint Feed have since been dropped from this route
// entirely (see MultiNativeView.tsx). /multi-native renders the same view
// and is kept temporarily as a fallback.

import { useEffect } from 'react';
import { MultiNativeView } from '../multi-native/MultiNativeView';

export default function MultiTabPage() {
  useEffect(() => { document.title = 'Multi View | VictoryLabs'; }, []);
  return <MultiNativeView />;
}
