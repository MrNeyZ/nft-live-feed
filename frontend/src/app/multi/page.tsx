'use client';

// VictoryLabs — Multi-tab (default). Now renders the native three-panel
// layout directly (no iframes): LEFT MintFeedPanel · CENTER RareFeedCompactPanel ·
// RIGHT SalesFeedPanel — via the shared <MultiNativeView />. The previous
// iframe implementation (embedded /mints, /tools/rare-feed, /feed) is retired.
// /multi-native renders the same view and is kept temporarily as a fallback.

import { useEffect } from 'react';
import { MultiNativeView } from '../multi-native/MultiNativeView';

export default function MultiTabPage() {
  useEffect(() => { document.title = 'Multi View | VictoryLabs'; }, []);
  return <MultiNativeView />;
}
