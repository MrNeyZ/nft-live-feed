'use client';

// VictoryLabs — native Rare Sales feed panel for /multi-native.
// Thin wrapper: owns data via useRareFeed() and renders the SHARED
// <RareFeedPanelView> (same chrome the standalone /tools/rare-feed page
// uses) in embed mode. No duplicated panel/header markup lives here.

import { useCallback } from 'react';
import { useRareFeed } from './lib/use-rare-feed';
import { RareFeedPanelView } from './RareFeedPanelView';

export function RareFeedPanel() {
  const { rows, error, loading, minScore } = useRareFeed();

  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <RareFeedPanelView
      rows={rows}
      error={error}
      loading={loading}
      onPreview={onPreview}
      embedded
      maxW="none"
      minScore={minScore}
    />
  );
}
