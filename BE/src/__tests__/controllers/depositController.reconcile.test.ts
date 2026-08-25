import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { DepositTransaction } from '../../models/depositModel';

const mocks = vi.hoisted(() => ({
  createDepositRequest: vi.fn(),
  findDepositTransactionByOrderCode: vi.fn(),
  findUserById: vi.fn(),
  getDepositTransactionStatus: vi.fn(),
  reconcilePendingDepositPayment: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }))
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUserById }));
vi.mock('../../models/depositModel', () => ({
  findDepositTransactionByOrderCode: mocks.findDepositTransactionByOrderCode,
  listRecentDepositTransactionsByUserId: vi.fn()
}));
vi.mock('../../services/depositService', () => ({
  createDepositRequest: mocks.createDepositRequest,
  getDepositTransactionStatus: mocks.getDepositTransactionStatus,
  processDepositWebhook: vi.fn(),
  reconcilePendingDepositPayment: mocks.reconcilePendingDepositPayment
}));
vi.mock('ethers', () => ({
  ethers: {
    Contract: vi.fn(),
    JsonRpcProvider: vi.fn()
  }
}));

import { handleCreateDeposit, handleGetDepositStatus } from '../../controllers/depositController';

/** Tạo giao dịch deposit tối thiểu để kiểm tra endpoint đối soát sau redirect PayOS. */
function createDepositTransaction(): DepositTransaction {
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

/** Tạo request đã xác thực cho endpoint trạng thái deposit. */
function createRequest(userId: string, reconcile = true): Request {
  return {
    authenticatedUser: { role: 'auditor', userId },
    params: { orderCode: '1787650889515545' },
    query: reconcile ? { reconcile: 'true' } : {}
  } as unknown as Request;
}

/** Tạo response Express giả để xác nhận payload và HTTP status. */
function createResponse(): Response {
  const response: Partial<Response> = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis()
  };
  return response as Response;
}

/** Tạo request tạo phiếu nạp đã xác thực để kiểm tra ngữ cảnh redirect nội bộ. */
function createDepositRequestWithFlow(paymentFlow: unknown): Request {
  return {
    authenticatedUser: { role: 'auditor', userId: 'user-001' },
    body: { amountVnd: 3_000_000, paymentFlow }
  } as unknown as Request;
}

describe('handleGetDepositStatus - PayOS reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('đối soát và trả trạng thái mint khi chủ giao dịch yêu cầu recovery', async () => {
    const pendingDeposit = createDepositTransaction();
    const mintCompletedDeposit = {
      ...pendingDeposit,
      onChainTransactionHash: '0xmint001',
      status: 'MINT_COMPLETED' as const
    };
    mocks.findDepositTransactionByOrderCode.mockResolvedValue(pendingDeposit);
    mocks.reconcilePendingDepositPayment.mockResolvedValue(mintCompletedDeposit);
    const response = createResponse();

    await handleGetDepositStatus(createRequest('user-001'), response);

    expect(mocks.reconcilePendingDepositPayment).toHaveBeenCalledWith(pendingDeposit);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      onChainTransactionHash: '0xmint001',
      status: 'MINT_COMPLETED'
    }));
  });

  it('không đối soát giao dịch thuộc tài khoản khác', async () => {
    mocks.findDepositTransactionByOrderCode.mockResolvedValue(createDepositTransaction());
    const response = createResponse();

    await handleGetDepositStatus(createRequest('user-other'), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(mocks.reconcilePendingDepositPayment).not.toHaveBeenCalled();
  });

  it('không gọi PayOS khi request tra cứu thông thường không yêu cầu recovery', async () => {
    const pendingDeposit = createDepositTransaction();
    mocks.getDepositTransactionStatus.mockResolvedValue(pendingDeposit);
    const response = createResponse();

    await handleGetDepositStatus(createRequest('user-001', false), response);

    expect(mocks.getDepositTransactionStatus).toHaveBeenCalledWith(pendingDeposit.orderCode);
    expect(mocks.reconcilePendingDepositPayment).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it('đánh dấu rõ thanh toán đã xác nhận nhưng mint token on-chain thất bại', async () => {
    const mintFailedDeposit: DepositTransaction = {
      ...createDepositTransaction(),
      failureReason: 'Mint token thất bại sau khi đã retry tối đa.',
      paymentConfirmedAt: new Date(),
      status: 'FAILED'
    };
    mocks.getDepositTransactionStatus.mockResolvedValue(mintFailedDeposit);
    const response = createResponse();

    await handleGetDepositStatus(createRequest('user-001', false), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      isPaymentConfirmedButMintFailed: true,
      status: 'FAILED'
    }));
  });

  it('không gắn cờ lỗi mint khi phiếu thất bại trước khi PayOS xác nhận thanh toán', async () => {
    const unpaidFailedDeposit: DepositTransaction = {
      ...createDepositTransaction(),
      failureReason: 'Người dùng đã hủy thanh toán.',
      status: 'FAILED'
    };
    mocks.getDepositTransactionStatus.mockResolvedValue(unpaidFailedDeposit);
    const response = createResponse();

    await handleGetDepositStatus(createRequest('user-001', false), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      isPaymentConfirmedButMintFailed: false,
      status: 'FAILED'
    }));
  });
});

describe('handleCreateDeposit - payment flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue({
      correlationId: 'correlation-001',
      id: 'user-001',
      walletAddress: '0x0000000000000000000000000000000000000001'
    });
    mocks.createDepositRequest.mockResolvedValue({
      orderCode: '1787650889515545',
      paymentUrl: 'https://pay.example/checkout',
      status: 'PENDING_PAYMENT'
    });
  });

  it('chỉ chuyển enum Auditor đã cho phép sang service, các giá trị khác giữ luồng nạp thường', async () => {
    const auditorResponse = createResponse();
    await handleCreateDeposit(createDepositRequestWithFlow('AUDITOR_ONBOARDING'), auditorResponse);

    expect(mocks.createDepositRequest).toHaveBeenCalledWith(expect.objectContaining({
      paymentFlow: 'AUDITOR_ONBOARDING'
    }));
    expect(auditorResponse.status).toHaveBeenCalledWith(201);

    const standardResponse = createResponse();
    await handleCreateDeposit(createDepositRequestWithFlow('https://attacker.example/register'), standardResponse);

    expect(mocks.createDepositRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      paymentFlow: undefined
    }));
    expect(standardResponse.status).toHaveBeenCalledWith(201);
  });
});
