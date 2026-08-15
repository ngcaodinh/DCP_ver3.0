/**
 * Hook instrumentation của Next.js, nạp config Sentry theo runtime hiện tại.
 * Next 14 cần experimental.instrumentationHook = true để register được gọi.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateFeedbackClientIdentityConfig } = await import('./app/utils/feedbackClientIdentityConfig');
    const { validateServerApiConfig } = await import('./app/utils/serverApiClient');
    validateFeedbackClientIdentityConfig();
    validateServerApiConfig();
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
