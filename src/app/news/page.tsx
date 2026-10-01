import type { Metadata } from 'next';

import { NewsClient } from './NewsClient';

export const metadata: Metadata = { title: 'Market intel · Mako Market Beta' };

/// Market intel (3a): the whole news feed Home shows the newest four of.
export default function NewsPage() {
  return <NewsClient />;
}
