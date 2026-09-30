import type { Metadata } from 'next';

import { CreatePoolClient } from './CreatePoolClient';

export const metadata: Metadata = { title: 'Create pool · Mako Market Beta' };

export default function CreatePoolPage() {
  return <CreatePoolClient />;
}
