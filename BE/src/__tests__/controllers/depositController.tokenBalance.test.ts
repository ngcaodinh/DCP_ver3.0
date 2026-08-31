import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  balanceOf: vi.fn(),
  contract: vi.fn(),
  findUserById: vi.fn(),
  isAddress: vi.fn(),
  provider: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }))
}));
vi.mock('../../models/authModel', () => ({ findUserById: mocks.findUserById }));
vi.mock('../../models/depositModel', () => ({ listRecentDepositTransactionsByUserId: vi.fn() }));
vi.mock('../../services/depositService', () => ({
  createDepositRequest: vi.fn(),
  getDepositTransactionStatus: vi.fn(),
  processDepositWebhook: vi.fn()
}));
vi.mock('ethers', () => ({
  ethers: {
    Contract: mocks.contract,
    JsonRpcProvider: mocks.provider,
    isAddress: mocks.isAddress
  }
}));

import { handleGetTokenBalance } from '../../controllers/depositController';

const originalBlockchainRpcUrl = process.env.BLOCKCHAIN_RPC_URL;
const originalCharityTokenContractAddress = process.env.CHARITY_TOKEN_CONTRACT_ADDRESS;

/** Tạo request đã xác thực tối thiểu cho endpoint đọc số dư DCT. */
function createAuthenticatedRequest(): Request {
  return {
    authenticatedUser: { userId: 'user-001', role: 'donor' }
  } as unknown as Request;
}

/** Tạo response Express giả để xác nhận mã HTTP và payload trả về từ controller. */
function createMockResponse(): Response {
  const response: Partial<Response> = {
    json: vi.fn(),
    status: vi.fn().mockReturnThis()
  };
  return response as Response;
}

describe('handleGetTokenBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.example';
    process.env.CHARITY_TOKEN_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000001';
    mocks.findUserById.mockResolvedValue({ id: 'user-001', walletAddress: '0x0000000000000000000000000000000000000002' });
    mocks.isAddress.mockReturnValue(true);
    mocks.contract.mockImplementation(() => ({ balanceOf: mocks.balanceOf }));
  });

  afterEach(() => {
    if (originalBlockchainRpcUrl === undefined) {
      delete process.env.BLOCKCHAIN_RPC_URL;
    } else {
      process.env.BLOCKCHAIN_RPC_URL = originalBlockchainRpcUrl;
    }

    if (originalCharityTokenContractAddress === undefined) {
      delete process.env.CHARITY_TOKEN_CONTRACT_ADDRESS;
    } else {
      process.env.CHARITY_TOKEN_CONTRACT_ADDRESS = originalCharityTokenContractAddress;
    }
  });

  it('trả số dư uint256 dưới dạng decimal string để không mất chính xác Number', async () => {
    mocks.balanceOf.mockResolvedValue(9_007_199_254_740_993n);
    const response = createMockResponse();

    await handleGetTokenBalance(createAuthenticatedRequest(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ tokenBalance: '9007199254740993' });
  });

  it('tự thay RPC Amoy đã ngừng hoạt động bằng endpoint chuẩn hóa trước khi gọi balanceOf', async () => {
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc-amoy.polygon.technology';
    mocks.balanceOf.mockResolvedValue(10n);
    const response = createMockResponse();

    await handleGetTokenBalance(createAuthenticatedRequest(), response);

    expect(mocks.provider).toHaveBeenCalledWith('https://polygon-amoy.drpc.org');
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ tokenBalance: '10' });
  });

  it('không trả số dư 0 giả khi thiếu cấu hình RPC blockchain', async () => {
    delete process.env.BLOCKCHAIN_RPC_URL;
    const response = createMockResponse();

    await handleGetTokenBalance(createAuthenticatedRequest(), response);

    expect(mocks.contract).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'BLOCKCHAIN_UNAVAILABLE'
    }));
  });

  it('trả lỗi blockchain typed khi RPC từ chối balanceOf thay vì 500 chung chung', async () => {
    mocks.balanceOf.mockRejectedValue({ code: 'NETWORK_ERROR' });
    const response = createMockResponse();

    await handleGetTokenBalance(createAuthenticatedRequest(), response);

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'BLOCKCHAIN_UNAVAILABLE',
      message: expect.stringMatching(/Không thể kết nối blockchain/i)
    }));
  });
});
