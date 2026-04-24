// /collection/ has no slug context, so it can't render a real collection.
// Redirect to /dashboard where the user picks a collection that opens in
// /collection/[slug]. Server-side redirect — no Communi3 mock template,
// no animations, no localStorage state.

import { redirect } from 'next/navigation';

export default function CollectionIndex(): never {
  redirect('/dashboard');
}
