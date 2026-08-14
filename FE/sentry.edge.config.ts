/** Khởi tạo Sentry cho edge runtime; không dùng API Node-specific trong config này. */
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
