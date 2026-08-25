import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDepositTransaction: vi.fn(),
  createPayosPaymentLink: vi.fn(),
  getPayosPaymentLinkStatus: vi.fn(),
  mintTokenForDeposit: vi.fn(),
  updateDepositTransaction: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }))
}));
vi.mock('../../models/depositModel', () => ({
  createDepositTransaction: mocks.createDepositTransaction,
  findDepositTransactionByOrderCode: vi.fn(),
  updateDepositTransaction: mocks.updateDepositTransaction
}));
vi.mock('../../services/payosService', () => ({
  createPayosPaymentLink: mocks.createPayosPaymentLink,
  getPayosPaymentLinkStatus: mocks.getPayosPaymentLinkStatus,
  verifyPayosWebhookChecksum: vi.fn()
}));
vi.mock('../../services/blockchainMintService', () => ({ mintTokenForDeposit: mocks.mintTokenForDeposit }));

import { createDepositRequest, reconcilePendingDepositPayment } from '../../services/depositService';
import type { DepositTransaction } from '../../models/depositModel';

/** Tạo input deposit tối thiểu hợp lệ để kiểm tra mã đơn hàng gửi sang PayOS. */
function createDepositInput() {
  return {
    amountVnd: 3_000_000,
    correlationId: 'correlation-001',
    userId: 'user-001',
    walletAddress: '0x0000000000000000000000000000000000000001'
  };
}

/** Tạo giao dịch deposit chờ thanh toán để kiểm tra đối soát server-to-server với PayOS. */
function createPendingDepositTransaction(): DepositTransaction {
  const createdAt = new Date();
  return {
    amountVnd: 3_000_000,
    correlationId: 'correlation-001',
    createdAt,
    failureReason: null,
    id: 'deposit-001',
    mintCompletedAt: null,
    onChainTransactionHash: null,
    orderCode: '1787650889515545',
    paymentConfirmedAt: null,
    paymentUrl: 'https://pay.example/checkout',
    payosTransactionId: null,
    status: 'PENDING_PAYMENT',
    tokenAmount: 3_000_000,
    updatedAt: createdAt,
    userId: 'user-001',
    walletAddress: '0x0000000000000000000000000000000000000001',
    webhookProcessedAt: null
  };
}

describe('createDepositRequest - PayOS orderCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPayosPaymentLink.mockImplementation(async ({ orderCode }) => ({
      orderCode,
      paymentUrl: 'https://pay.example/checkout'
    }));
    mocks.createDepositTransaction.mockImplementation(async (transaction) => transaction);
    mocks.updateDepositTransaction.mockImplementation(async (transaction) => transaction);
  });

  it('sinh mã số dương, an toàn cho JavaScript và không vượt giới hạn PayOS', async () => {
    await createDepositRequest(createDepositInput());

    const payosInput = mocks.createPayosPaymentLink.mock.calls[0][0];
    const numericOrderCode = Number(payosInput.orderCode);

    expect(payosInput.orderCode).toMatch(/^\d+$/);
    expect(numericOrderCode).toBeGreaterThan(0);
    expect(Number.isSafeInteger(numericOrderCode)).toBe(true);
    expect(numericOrderCode).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(mocks.createDepositTransaction).toHaveBeenCalledWith(expect.objectContaining({
      orderCode: payosInput.orderCode
    }));
  });

  it('giữ redirect /deposit cho luồng thường và trả Auditor về /register để tiếp tục đặt cọc', async () => {
    const configuredReturnUrl = process.env.PAYOS_RETURN_URL;
    const configuredCancelUrl = process.env.PAYOS_CANCEL_URL;
    process.env.PAYOS_RETURN_URL = 'https://app.example/deposit?paymentStatus=success&role=donor&paymentFlow=standard';
    process.env.PAYOS_CANCEL_URL = 'https://app.example/deposit?paymentStatus=cancel&role=donor&paymentFlow=standard';

    try {
      await createDepositRequest(createDepositInput());
      await createDepositRequest({ ...createDepositInput(), paymentFlow: 'AUDITOR_ONBOARDING' });

      const standardPayosInput = mocks.createPayosPaymentLink.mock.calls[0][0];
      const auditorPayosInput = mocks.createPayosPaymentLink.mock.calls[1][0];
      const standardReturnUrl = new URL(standardPayosInput.returnUrl);
      const auditorReturnUrl = new URL(auditorPayosInput.returnUrl);
      const auditorCancelUrl = new URL(auditorPayosInput.cancelUrl);

      expect(standardReturnUrl.pathname).toBe('/deposit');
      expect(standardReturnUrl.searchParams.get('paymentStatus')).toBe('success');
      expect(standardReturnUrl.searchParams.get('orderCode')).toBe(standardPayosInput.orderCode);
      expect(auditorReturnUrl.pathname).toBe('/register');
      expect(auditorReturnUrl.searchParams.get('role')).toBe('auditor');
      expect(auditorReturnUrl.searchParams.get('paymentFlow')).toBe('auditor_onboarding');
      expect(auditorReturnUrl.searchParams.get('paymentStatus')).toBe('success');
      expect(auditorReturnUrl.searchParams.get('orderCode')).toBe(auditorPayosInput.orderCode);
      expect(auditorCancelUrl.pathname).toBe('/register');
      expect(auditorCancelUrl.searchParams.get('paymentStatus')).toBe('cancel');
      expect(auditorCancelUrl.searchParams.get('paymentFlow')).toBe('auditor_onboarding');
    } finally {
      if (configuredReturnUrl === undefined) {
        delete process.env.PAYOS_RETURN_URL;
      } else {
        process.env.PAYOS_RETURN_URL = configuredReturnUrl;
      }
      if (configuredCancelUrl === undefined) {
        delete process.env.PAYOS_CANCEL_URL;
      } else {
        process.env.PAYOS_CANCEL_URL = configuredCancelUrl;
      }
    }
  });

  it('mint khi PayOS đối soát PAID và dữ liệu khớp hoàn toàn với giao dịch', async () => {
    const pendingDeposit = createPendingDepositTransaction();
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: pendingDeposit.amountVnd,
      orderCode: pendingDeposit.orderCode,
      paymentLinkId: 'payos-link-001',
      status: 'PAID'
    });
    mocks.mintTokenForDeposit.mockResolvedValue({ transactionHash: '0xmint001' });

    const result = await reconcilePendingDepositPayment(pendingDeposit);

    expect(result).toMatchObject({ status: 'MINT_COMPLETED', onChainTransactionHash: '0xmint001' });
    expect(mocks.mintTokenForDeposit).toHaveBeenCalledWith(
      pendingDeposit.walletAddress,
      pendingDeposit.tokenAmount,
      pendingDeposit.orderCode
    );
    expect(mocks.updateDepositTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: 'PAYMENT_CONFIRMED',
      payosTransactionId: 'payos-link-001'
    }));
    expect(mocks.updateDepositTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'MINT_COMPLETED' }));
  });

  it('không mint khi số tiền PayOS đối soát không khớp với giao dịch', async () => {
    const pendingDeposit = createPendingDepositTransaction();
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: pendingDeposit.amountVnd + 1,
      orderCode: pendingDeposit.orderCode,
      paymentLinkId: 'payos-link-001',
      status: 'PAID'
    });

    await expect(reconcilePendingDepositPayment(pendingDeposit)).rejects.toThrow(
      'Dữ liệu đối soát PayOS không khớp với giao dịch nạp tiền.'
    );

    expect(mocks.mintTokenForDeposit).not.toHaveBeenCalled();
    expect(mocks.updateDepositTransaction).not.toHaveBeenCalled();
  });

  it('khôi phục giao dịch timeout khi PayOS đối soát xác nhận đã PAID', async () => {
    const timedOutDeposit: DepositTransaction = {
      ...createPendingDepositTransaction(),
      failureReason: 'Quá thời gian thanh toán 15 phút.',
      status: 'FAILED'
    };
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: timedOutDeposit.amountVnd,
      orderCode: timedOutDeposit.orderCode,
      paymentLinkId: 'payos-link-timeout',
      status: 'PAID'
    });
    mocks.mintTokenForDeposit.mockResolvedValue({ transactionHash: '0xmint-timeout' });

    await expect(reconcilePendingDepositPayment(timedOutDeposit)).resolves.toMatchObject({
      status: 'MINT_COMPLETED',
      onChainTransactionHash: '0xmint-timeout'
    });

    expect(mocks.mintTokenForDeposit).toHaveBeenCalledTimes(1);
  });

  it.each(['PENDING', 'CANCELLED', 'EXPIRED'])('không mint khi PayOS chưa xác nhận thanh toán với trạng thái %s', async (payosStatus) => {
    const pendingDeposit = createPendingDepositTransaction();
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: pendingDeposit.amountVnd,
      orderCode: pendingDeposit.orderCode,
      paymentLinkId: 'payos-link-pending',
      status: payosStatus
    });

    await expect(reconcilePendingDepositPayment(pendingDeposit)).resolves.toBe(pendingDeposit);

    expect(mocks.mintTokenForDeposit).not.toHaveBeenCalled();
    expect(mocks.updateDepositTransaction).not.toHaveBeenCalled();
  });

  it('không mint khi orderCode PayOS đối soát không thuộc giao dịch đang kiểm tra', async () => {
    const pendingDeposit = createPendingDepositTransaction();
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: pendingDeposit.amountVnd,
      orderCode: '1787650889515546',
      paymentLinkId: 'payos-link-other-order',
      status: 'PAID'
    });

    await expect(reconcilePendingDepositPayment(pendingDeposit)).rejects.toThrow(
      'Dữ liệu đối soát PayOS không khớp với giao dịch nạp tiền.'
    );

    expect(mocks.mintTokenForDeposit).not.toHaveBeenCalled();
    expect(mocks.updateDepositTransaction).not.toHaveBeenCalled();
  });

  it('đánh dấu PAYMENT_CONFIRMED rồi FAILED khi mint thất bại sau ba lần retry', async () => {
    const pendingDeposit = createPendingDepositTransaction();
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: pendingDeposit.amountVnd,
      orderCode: pendingDeposit.orderCode,
      paymentLinkId: 'payos-link-mint-failed',
      status: 'PAID'
    });
    mocks.mintTokenForDeposit.mockRejectedValue(new Error('RPC không phản hồi.'));

    const result = await reconcilePendingDepositPayment(pendingDeposit);

    expect(mocks.mintTokenForDeposit).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: 'FAILED',
      failureReason: 'Mint token thất bại: RPC không phản hồi.',
      mintCompletedAt: null
    });
    expect(result.paymentConfirmedAt).toBeInstanceOf(Date);
    expect(mocks.updateDepositTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: 'PAYMENT_CONFIRMED',
      paymentConfirmedAt: expect.any(Date)
    }));
    expect(mocks.updateDepositTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: 'FAILED',
      mintCompletedAt: null
    }));
  });

  it('gộp hai lần đối soát PAID đồng thời để mint đúng một lần', async () => {
    const pendingDeposit = createPendingDepositTransaction();
    let resolveMint: ((value: { transactionHash: string }) => void) | undefined;
    mocks.getPayosPaymentLinkStatus.mockResolvedValue({
      amountVnd: pendingDeposit.amountVnd,
      orderCode: pendingDeposit.orderCode,
      paymentLinkId: 'payos-link-concurrent',
      status: 'PAID'
    });
    mocks.mintTokenForDeposit.mockImplementation(() => new Promise<{ transactionHash: string }>((resolve) => {
      resolveMint = resolve;
    }));

    const firstReconciliation = reconcilePendingDepositPayment(pendingDeposit);
    const secondReconciliation = reconcilePendingDepositPayment(pendingDeposit);
    await vi.waitFor(() => expect(mocks.mintTokenForDeposit).toHaveBeenCalledTimes(1));
    resolveMint?.({ transactionHash: '0xmint-concurrent' });

    await expect(Promise.all([firstReconciliation, secondReconciliation])).resolves.toEqual([
      expect.objectContaining({ status: 'MINT_COMPLETED', onChainTransactionHash: '0xmint-concurrent' }),
      expect.objectContaining({ status: 'MINT_COMPLETED', onChainTransactionHash: '0xmint-concurrent' })
    ]);
    expect(mocks.updateDepositTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(['MINT_COMPLETED', 'PAYMENT_CONFIRMED', 'FAILED'] as const)(
    'không gọi PayOS hoặc mint lại cho giao dịch đã kết thúc ở trạng thái %s',
    async (status) => {
      const terminalDeposit: DepositTransaction = {
        ...createPendingDepositTransaction(),
        status,
        paymentConfirmedAt: new Date()
      };

      await expect(reconcilePendingDepositPayment(terminalDeposit)).resolves.toBe(terminalDeposit);

      expect(mocks.getPayosPaymentLinkStatus).not.toHaveBeenCalled();
      expect(mocks.mintTokenForDeposit).not.toHaveBeenCalled();
      expect(mocks.updateDepositTransaction).not.toHaveBeenCalled();
    }
  );
});
