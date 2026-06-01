'use client';

// VictoryLabs — /multi shared live-sales source.
// Calls useSalesFeed() ONCE and exposes the single live events list to both
// the Sales panel (renders it) and the compact Rare strip (filters EPIC+ from
// it). This guarantees the Rare strip is a navigator over the SAME sales the
// right column shows — no stale historical rare events. /multi-only.

import { createContext, useContext } from 'react';
import type { FeedEvent } from '@/soloist/mock-data';
import { useSaleStream } from './sale-event-stream';
import { useSalesFeed } from '@/app/feed/lib/use-sales-feed';

interface MultiSales { events: FeedEvent[]; meStale: boolean }
const MultiSalesContext = createContext<MultiSales>({ events: [], meStale: false });

export function useMultiSales(): MultiSales {
  return useContext(MultiSalesContext);
}

export function MultiSalesProvider({ children }: { children: React.ReactNode }) {
  const { events, meStale } = useSalesFeed(useSaleStream());
  return <MultiSalesContext.Provider value={{ events, meStale }}>{children}</MultiSalesContext.Provider>;
}
