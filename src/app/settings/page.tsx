import type { Metadata } from 'next';

import { SettingsClient } from './SettingsClient';

export const metadata: Metadata = { title: 'Settings · Mako Market Beta' };

/// /settings (21a): account, security, appearance, network and sign out.
export default function SettingsPage() {
  return <SettingsClient />;
}
