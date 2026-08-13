import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockchainTransactionGasUsed,
  getMetricsRegistry,
  resetMetricsForTest
} from '../../config/metricsRegistry';
import { recordBlockchainTransaction } from '../../utils/blockchainMetrics';

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    warn: vi.fn()
  }))
}));

describe('recordBlockchainTransaction', () => {
  beforeEach(() => {
    resetMetricsForTest();
    vi.restoreAllMocks();
  });

  it('records gas, confirmation duration and success status', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000);

    recordBlockchainTransaction({
      operation: 'mint_sbt',
      receipt: { gasUsed: 123456n, status: 1 },
      startedAtMs: 1_000
    });

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain(
      'blockchain_transaction_gas_used_bucket{le="200000",operation="mint_sbt",status="success"} 1'
    );
    expect(metrics).toContain(
      'blockchain_transaction_confirmation_duration_seconds_bucket{le="120",operation="mint_sbt",status="success"} 1'
    );
    expect(metrics).toContain(
      'blockchain_transaction_gas_used_sum{operation="mint_sbt",status="success"} 123456'
    );
    expect(metrics).toContain(
      'blockchain_transaction_confirmation_duration_seconds_count{operation="mint_sbt",status="success"} 1'
    );
    expect(metrics).toContain(
      'blockchain_transactions_total{operation="mint_sbt",status="success"} 1'
    );
  });

  it('records a reverted receipt as failed without throwing', async () => {
    recordBlockchainTransaction({
      operation: 'finalize_disbursement',
      receipt: { gasUsed: 9_999n, status: 0 },
      startedAtMs: Date.now()
    });

    const metrics = await getMetricsRegistry().metrics();
    expect(metrics).toContain(
      'blockchain_transactions_total{operation="finalize_disbursement",status="failed"} 1'
    );
  });

  it('does not propagate a registry failure into the transaction flow', () => {
    vi.spyOn(blockchainTransactionGasUsed, 'observe').mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    expect(() => recordBlockchainTransaction({
      operation: 'mint_deposit',
      receipt: { gasUsed: 100n, status: 1 },
      startedAtMs: Date.now()
    })).not.toThrow();
  });
});
