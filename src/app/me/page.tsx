import type { Metadata } from 'next';

import { MeClient } from './MeClient';

export const metadata: Metadata = { title: 'Me · Mako Market Beta' };

/// /me (11a): the signed-in account's identity, balance, positions, claims and profit.
export default function MePage() {
  return <MeClient />;
}
