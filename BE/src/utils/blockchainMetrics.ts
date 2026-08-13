import { getLogger } from '../config/logger';
import {
  blockchainTransactionConfirmationDurationSeconds,
  blockchainTransactionGasUsed,
  blockchainTransactionsTotal
} from '../config/metricsRegistry';

export type BlockchainMetricOperation = 'mint_sbt' | 'mint_deposit' | 'finalize_disbursement';

interface BlockchainTransactionReceiptLike {
  gasUsed: bigint;
  status: number | null;
}

interface RecordBlockchainTransactionInput {
  operation: BlockchainMetricOperation;
  receipt: BlockchainTransactionReceiptLike;
  startedAtMs: number;
}

/** Ghi nhận gas, thời gian xác nhận và trạng thái receipt mà không làm hỏng luồng giao dịch nghiệp vụ. */
export function recordBlockchainTransaction({
  operation,
  receipt,
  startedAtMs
}: RecordBlockchainTransactionInput): void {
  try {
    const status = receipt.status === 1 ? 'success' : 'failed';
    const labels = { operation, status };
    const confirmationDurationInSeconds = Math.max(0, Date.now() - startedAtMs) / 1_000;

    blockchainTransactionGasUsed.observe(labels, Number(receipt.gasUsed));
    blockchainTransactionConfirmationDurationSeconds.observe(labels, confirmationDurationInSeconds);
    blockchainTransactionsTotal.inc(labels);
  } catch (error) {
    // Metrics chỉ phục vụ quan sát; tuyệt đối không để lỗi registry ảnh hưởng transaction đã được confirm.
    getLogger().warn('Không thể ghi blockchain Prometheus metrics.', {
      errorMessage: error instanceof Error ? error.message : String(error),
      operation
    });
  }
}
