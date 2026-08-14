/** Khởi tạo Sentry cho Node runtime của Next.js, gồm server component và route handler. */
import * as Sentry from '@sentry/nextjs';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@/app/utils/sentryScrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  sendDefaultPii: false,
  maxBreadcrumbs: 50,
  beforeSend: event => scrubSentryEvent(event),
  beforeBreadcrumb: breadcrumb => scrubSentryBreadcrumb(breadcrumb)
});
