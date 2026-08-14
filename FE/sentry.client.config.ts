/**
 * Khởi tạo Sentry cho browser runtime.
 * Dùng tên file tương thích Next 14; không dùng instrumentation-client của Next 15.3+.
 */
import * as Sentry from '@sentry/nextjs';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@/app/utils/sentryScrub';

const isDevelopment = process.env.NODE_ENV !== 'production';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  tracesSampleRate: isDevelopment ? 1.0 : 0.1,
  sendDefaultPii: false,
  maxBreadcrumbs: 50,
  // Không bật Session Replay vì form quyên góp có thể chứa dữ liệu tài chính nhạy cảm.
  beforeSend: event => scrubSentryEvent(event),
  beforeBreadcrumb: breadcrumb => scrubSentryBreadcrumb(breadcrumb),
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications'
  ],
  denyUrls: [/extensions\//i, /^chrome:\/\//i, /^moz-extension:\/\//i]
});
