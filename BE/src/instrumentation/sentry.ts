/**
 * Khởi tạo Sentry cho backend.
 * File này được import đầu tiên từ server.ts để auto-instrumentation patch kịp các module HTTP.
 * Không import logger tại đây để tránh phụ thuộc vòng và giữ module init độc lập.
 */
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import {
  getConfiguredTracesSampleRate,
  getSentryDsn,
  getSentryEnvironment,
  getSentryRelease,
  isSentryEnabled,
  resolveSentryServerName
} from '../config/sentryConfig';
import { getRequestId } from '../config/requestContext';
import {
  redactSentryBreadcrumb,
  redactSentryEvent,
  resolveTracesSampleRate
} from './sentryScrubber';

/** Integration mặc định bị loại vì console breadcrumb trùng Winston và dễ mang dữ liệu thô. */
const REMOVED_DEFAULT_INTEGRATIONS = new Set(['Console', 'OnUncaughtException']);

if (isSentryEnabled()) {
  Sentry.init({
    dsn: getSentryDsn() ?? undefined,
    environment: getSentryEnvironment(),
    release: getSentryRelease(),
    serverName: resolveSentryServerName(),
    sampleRate: 1.0,
    sendDefaultPii: false,
    maxBreadcrumbs: 50,
    tracesSampler: samplingContext => resolveTracesSampleRate(
      samplingContext,
      getConfiguredTracesSampleRate(),
      process.env.NODE_ENV || 'development'
    ),
    beforeSend: event => redactSentryEvent(event, getRequestId()),
    beforeSendTransaction: event => redactSentryEvent(event, getRequestId()),
    beforeBreadcrumb: breadcrumb => redactSentryBreadcrumb(breadcrumb),
    integrations: defaultIntegrations => [
      ...defaultIntegrations.filter(
        integration => !REMOVED_DEFAULT_INTEGRATIONS.has(integration.name)
      ),
      // Winston đã đăng ký exception handler và exitOnError:false; giữ process sống như E6.
      Sentry.onUncaughtExceptionIntegration({ exitEvenIfOtherHandlersAreRegistered: false })
    ]
  });
}
