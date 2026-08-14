/**
 * Hook instrumentation của Next.js, nạp config Sentry theo runtime hiện tại.
 * Next 14 cần experimental.instrumentationHook = true để register được gọi.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
