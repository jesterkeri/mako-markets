import type { Metadata } from 'next';

import { ScheduleClient } from './ScheduleClient';

export const metadata: Metadata = { title: 'Schedule a round · Mako Market Beta' };

/// /rounds/new: a creator schedules a round. Only addresses on MakoRoundsV1's creator list may.
export default function ScheduleRoundPage() {
  return <ScheduleClient />;
}
