import Link from 'next/link';

/**
 * Full-width brutalist "+ CREATE MARKET" CTA that sits below the home
 * feed header. Navigates to /create where the user picks a question
 * and duration and fires an ad-hoc market creation tx.
 *
 * Styled to match the feed card rhythm (hard borders, uppercase
 * tracking, hover-inverts to black-on-beige).
 */
export function CreateMarketButton() {
  return (
    <Link
      href="/create"
      className="block w-full px-6 py-4 border-b border-ink font-black text-xs uppercase tracking-widest hover:bg-ink hover:text-paper transition-colors text-center"
    >
      [ + CREATE NEW MARKET ]
    </Link>
  );
}
