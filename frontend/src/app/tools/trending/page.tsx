'use client';

// Retired — merged into /dashboard (ME-sourced trending data + Tensor
// supplement + live overlay). Kept as a redirect so old bookmarks/links
// still land somewhere real instead of 404ing.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TrendingRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard'); }, [router]);
  return null;
}
