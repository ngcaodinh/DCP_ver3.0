import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry
} from 'prom-client';

const HTTP_REQUEST_DURATION_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
  120
];

const DONATION_AMOUNT_BUCKETS = [
  10_000,
  50_000,
  100_000,
  200_000,
  500_000,
  1_000_000,
  5_000_000,
  10_000_000,
  50_000_000
];

const BLOCKCHAIN_TRANSACTION_GAS_USED_BUCKETS = [
  21_000,
  50_000,
  100_000,
  200_000,
  300_000,
  500_000,
  1_000_000
];

/** Các endpoint hạ tầng có tần suất scrape/healthcheck cao nên không tự đếm như HTTP request thông thường. */
export const METRICS_EXCLUDED_ROUTES = ['/metrics', '/live'] as const;

const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

/** Histogram đo thời gian xử lý request đến lúc response hoàn tất. */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Thời gian xử lý HTTP request tính bằng giây.',
  labelNames: ['method', 'route', 'status_code'],
  buckets: HTTP_REQUEST_DURATION_BUCKETS,
  registers: [metricsRegistry]
});

/** Counter đếm số HTTP request hoàn tất theo method, route pattern và status code. */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Tổng số HTTP request đã hoàn tất.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry]
});

/** Counter đếm số request feedback SSR không xác minh được identity theo từng route đọc. */
export const publicFeedbackClientIdentityFallbackTotal = new Counter({
  name: 'public_feedback_client_identity_fallback_total',
  help: 'Số request feedback SSR phải fallback về IP của request vì identity không được xác minh.',
  labelNames: ['route'],
  registers: [metricsRegistry]
});

/** Counter đếm kết quả submit KYC FOUNDATION theo outcome nghiệp vụ. */
export const foundationKycSubmissionsTotal = new Counter({
  name: 'dcp_foundation_kyc_submissions_total',
  help: 'Tổng số request KYC FOUNDATION theo kết quả xử lý.',
  labelNames: ['result'],
  registers: [metricsRegistry]
});

/** Counter đếm các lần captcha FOUNDATION thất bại theo nguyên nhân. */
export const foundationKycCaptchaFailuresTotal = new Counter({
  name: 'dcp_foundation_kyc_captcha_failures_total',
  help: 'Tổng số lần xác minh reCAPTCHA KYC FOUNDATION thất bại theo nguyên nhân.',
  labelNames: ['reason'],
  registers: [metricsRegistry]
});

/** Histogram ghi nhận gas đã dùng của các transaction blockchain được instrument. */
export const blockchainTransactionGasUsed = new Histogram({
  name: 'blockchain_transaction_gas_used',
  help: 'Lượng gas đã sử dụng bởi một giao dịch blockchain.',
  labelNames: ['operation', 'status'],
  buckets: BLOCKCHAIN_TRANSACTION_GAS_USED_BUCKETS,
  registers: [metricsRegistry]
});

/** Histogram đo thời gian từ lúc submit transaction đến khi nhận receipt. */
export const blockchainTransactionConfirmationDurationSeconds = new Histogram({
  name: 'blockchain_transaction_confirmation_duration_seconds',
  help: 'Thời gian xác nhận giao dịch blockchain tính bằng giây.',
  labelNames: ['operation', 'status'],
  buckets: HTTP_REQUEST_DURATION_BUCKETS,
  registers: [metricsRegistry]
});

/** Counter đếm số transaction blockchain theo operation và trạng thái receipt. */
export const blockchainTransactionsTotal = new Counter({
  name: 'blockchain_transactions_total',
  help: 'Tổng số giao dịch blockchain đã nhận receipt.',
  labelNames: ['operation', 'status'],
  registers: [metricsRegistry]
});

/** Counter đếm số donation event đã được index và post-process. */
export const donationEventsTotal = new Counter({
  name: 'donation_events_total',
  help: 'Tổng số donation event đã được xử lý sau khi index.',
  registers: [metricsRegistry]
});

/** Histogram ghi nhận giá trị donation theo đơn vị VND. */
export const donationAmountVnd = new Histogram({
  name: 'donation_amount_vnd',
  help: 'Giá trị của từng donation tính bằng VND.',
  buckets: DONATION_AMOUNT_BUCKETS,
  registers: [metricsRegistry]
});

/** Counter đếm feedback đã quá hạn lưu trữ và bị purge cứng khỏi MongoDB. */
export const feedbackHardPurgedTotal = new Counter({
  name: 'dcp_feedback_hard_purged_total',
  help: 'Số feedback đã xoá mềm bị xoá cứng sau thời hạn lưu trữ.',
  registers: [metricsRegistry]
});

/** Gauge theo dõi số event đang chờ worker ghi vào MongoDB. */
export const eventLoggerBufferDepth = new Gauge({
  name: 'dcp_event_logger_buffer_depth',
  help: 'Số event hiện đang nằm trong Redis buffer của event logger.',
  registers: [metricsRegistry]
});

/** Gauge phản ánh subscriber realtime của event logger đã kết nối và subscribe channel hay chưa. */
export const eventSocketBridgeConnected = new Gauge({
  name: 'dcp_event_socket_bridge_connected',
  help: 'Trạng thái kết nối Redis subscriber của event socket bridge (1 = connected).',
  registers: [metricsRegistry]
});

/** Counter ghi nhận event bị loại khi Redis buffer đạt giới hạn cứng. */
export const eventLoggerDroppedTotal = new Counter({
  name: 'dcp_event_logger_dropped_total',
  help: 'Tổng số event bị loại do Redis buffer đạt giới hạn.',
  registers: [metricsRegistry]
});

/** Histogram đo thời gian worker xử lý một lượt flush event. */
export const eventLoggerFlushDurationMs = new Histogram({
  name: 'dcp_event_logger_flush_duration_ms',
  help: 'Thời gian xử lý một lượt flush event logger tính bằng mili-giây.',
  registers: [metricsRegistry]
});

/** Histogram đo độ trễ từ thời điểm event xảy ra tới lúc được ghi vào MongoDB. */
export const eventLoggerFlushLagMs = new Histogram({
  name: 'dcp_event_logger_flush_lag_ms',
  help: 'Độ trễ từ timestamp nghiệp vụ tới createdAt khi flush event.',
  registers: [metricsRegistry]
});

/** Trả về registry riêng của backend để endpoint scrape và test dùng chung. */
export function getMetricsRegistry(): Registry {
  return metricsRegistry;
}

/** Reset toàn bộ giá trị metric trong test mà không đăng ký lại metric và gây duplicate name. */
export function resetMetricsForTest(): void {
  metricsRegistry.resetMetrics();
}
