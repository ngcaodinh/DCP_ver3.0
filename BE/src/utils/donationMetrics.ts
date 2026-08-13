import { donationAmountVnd, donationEventsTotal } from '../config/metricsRegistry';
import { getLogger } from '../config/logger';

const logger = getLogger();

/** Ghi metric donation theo cơ chế best-effort để lỗi observability không làm hỏng event đã index. */
export function recordDonationMetrics(amountVnd: number): void {
  try {
    donationEventsTotal.inc();
    donationAmountVnd.observe(amountVnd);
  } catch (error) {
    // Metric chỉ phục vụ quan sát; không được đẩy lỗi registry ngược vào luồng xử lý donation.
    logger.warn('Không thể ghi donation Prometheus metrics.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
}
