import type { Metadata } from 'next';

import { PoolsClient } from './PoolsClient';

export const metadata: Metadata = { title: 'Pools · Mako Market' };

export default function PoolsPage() {
  return <PoolsClient />;
}
