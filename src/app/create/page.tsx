import { permanentRedirect } from 'next/navigation';

/// The old create form. The redesigned one (/pools/new) replaces it: it builds the same pools, shows the exact
/// target it settles on, and names only the pool the creator made. /create/private (Private Markets, hidden) is a
/// separate route and unaffected.
export default function CreateRedirect() {
  permanentRedirect('/pools/new');
}
