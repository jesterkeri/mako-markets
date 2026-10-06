// Sentry in the browser (src/lib/sentry-options.ts holds the quota guard and privacy rules). Off while
// NEXT_PUBLIC_SENTRY_DSN is unset. No Session Replay: it would record what users see and type.
import * as Sentry from '@sentry/nextjs';

import { sentryBaseOptions } from '@/lib/sentry-options';

Sentry.init(sentryBaseOptions());

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
