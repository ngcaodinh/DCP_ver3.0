import { NextFunction, Request, Response } from 'express';
import { getLogger } from '../config/logger';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  METRICS_EXCLUDED_ROUTES
} from '../config/metricsRegistry';

const UNMATCHED_ROUTE_LABEL = 'unmatched';
const NANOSECONDS_PER_SECOND = 1_000_000_000;

/** Resolve route pattern ổn định để tránh đưa path động của request vào label Prometheus. */
function resolveRouteLabel(request: Request): string {
  const routePath = request.route?.path;
  if (typeof routePath !== 'string') return UNMATCHED_ROUTE_LABEL;

  if (routePath === '/') return request.baseUrl || '/';

  return `${request.baseUrl}${routePath}` || UNMATCHED_ROUTE_LABEL;
}

/** Ghi nhận HTTP duration và request count khi response đã flush hoàn tất. */
export function metricsMiddleware(request: Request, response: Response, next: NextFunction): void {
  const normalizedRequestPath = request.path.length > 1
    ? request.path.replace(/\/+$/, '')
    : request.path;
  const isExcludedRoute = METRICS_EXCLUDED_ROUTES.includes(
    normalizedRequestPath as (typeof METRICS_EXCLUDED_ROUTES)[number]
  );

  // Không tạo timer/listener cho scrape và liveness probe vì hai route này đã bị loại khỏi metric.
  if (isExcludedRoute) {
    next();
    return;
  }

  const requestStartTime = process.hrtime.bigint();

  let listenersCleaned = false;

  // Dọn listener ở cả finish và close để request bị client ngắt không giữ timer/listener trong memory.
  const cleanupListeners = (): void => {
    if (listenersCleaned) return;
    listenersCleaned = true;
    response.off('finish', handleFinish);
    response.off('close', handleClose);
  };

  const handleFinish = (): void => {
    cleanupListeners();

    try {
      const durationInSeconds = Number(process.hrtime.bigint() - requestStartTime) / NANOSECONDS_PER_SECOND;
      const routeLabel = resolveRouteLabel(request);
      const labels = {
        method: request.method,
        route: routeLabel,
        status_code: String(response.statusCode)
      };

      httpRequestDurationSeconds.observe(labels, durationInSeconds);
      httpRequestsTotal.inc(labels);
    } catch (error) {
      // Metrics là best-effort; lỗi observability không được làm crash process sau khi response đã hoàn tất.
      getLogger().warn('Không thể ghi HTTP Prometheus metrics.', {
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleClose = (): void => {
    cleanupListeners();
  };

  response.once('finish', handleFinish);
  response.once('close', handleClose);
  next();
}
