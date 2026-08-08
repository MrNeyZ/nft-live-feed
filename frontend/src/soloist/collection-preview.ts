// VictoryLabs — Dashboard/Multi → Collection page avatar handoff.
// Stashes the currently-rendered row avatar under `cp-preview:<slug>` right
// before navigating to /collection/[slug], so the collection page's header
// can paint the same image on first render instead of an initials/abbr
// flash while its own icon lookup warms up. Read back in
// collection/[slug]/page.tsx (`handoffPreview`). Shared by /dashboard and
// /multi's DashboardCollectionsPanel — both list the same rows and must
// hand off the same way.

export function stashCollectionPreview(slug: string, avatarUrl: string | null | undefined): void {
  if (!avatarUrl) return;
  try { sessionStorage.setItem(`cp-preview:${slug}`, avatarUrl); } catch { /* quota/private-mode: ignore */ }
}
