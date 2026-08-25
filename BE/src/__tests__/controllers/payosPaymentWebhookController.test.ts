import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  findAccountDeposit: vi.fn(),
  findGuestDeposit: vi.fn(),
  findGuestDonation: vi.fn(),
  handleAccountDeposit: vi.fn(),
  handleGuestDeposit: vi.fn(),
  handleGuestDonation: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }))
}));
vi.mock('../../models/depositModel', () => ({ findDepositTransactionByOrderCode: mocks.findAccountDeposit }));
vi.mock('../../repositories/guestDepositRepository', () => ({ findGuestDepositByOrderCodeRepo: mocks.findGuestDeposit }));
vi.mock('../../repositories/guestPayosDonationRepository', () => ({ findGuestPayosDonationByOrderCode: mocks.findGuestDonation }));
vi.mock('../../controllers/depositController', () => ({ handleDepositWebhook: mocks.handleAccountDeposit }));
vi.mock('../../controllers/guestDepositController', () => ({ handleGuestDepositWebhook: mocks.handleGuestDeposit }));
vi.mock('../../controllers/guestPayosWebhookController', () => ({ handleGuestPayosWebhook: mocks.handleGuestDonation }));

import {
  handlePayosPaymentWebhook,
  handlePayosPaymentWebhookHealth
} from '../../controllers/payosPaymentWebhookController';

/** Tạo request webhook PayOS tối thiểu cho từng trường hợp định tuyến. */
function createWebhookRequest(body: Record<string, unknown>): Request {
  return { body, headers: {} } as Request;
}

/** Tạo response Express giả để kiểm tra HTTP response của webhook. */
function createMockResponse(): Response {
  const response: Partial<Response> = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis()
  };
  return response as Response;
}

describe('handlePayosPaymentWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findAccountDeposit.mockResolvedValue(null);
    mocks.findGuestDeposit.mockResolvedValue(null);
    mocks.findGuestDonation.mockResolvedValue(null);
  });

  it('trả health check khi PayOS kiểm tra URL mà không có orderCode', async () => {
    const response = createMockResponse();

    await handlePayosPaymentWebhookHealth(createWebhookRequest({}), response);
    await handlePayosPaymentWebhook(createWebhookRequest({ signature: 'test-signature' }), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenLastCalledWith({ message: 'PayOS payment webhook URL hoạt động.' });
  });

  it('chuyển tiếp payment của tài khoản đăng nhập hoặc kích hoạt Kiểm toán viên về deposit handler', async () => {
    mocks.findAccountDeposit.mockResolvedValue({ orderCode: '1001' });
    const request = createWebhookRequest({ data: { orderCode: 1001 } });
    const response = createMockResponse();

    await handlePayosPaymentWebhook(request, response);

    expect(mocks.handleAccountDeposit).toHaveBeenCalledWith(request, response);
    expect(mocks.handleGuestDeposit).not.toHaveBeenCalled();
    expect(mocks.handleGuestDonation).not.toHaveBeenCalled();
  });

  it('chuyển tiếp guest deposit về handler anonymous tương ứng', async () => {
    mocks.findGuestDeposit.mockResolvedValue({ orderCode: '1002' });
    const request = createWebhookRequest({ data: JSON.stringify({ orderCode: '1002' }) });
    const response = createMockResponse();

    await handlePayosPaymentWebhook(request, response);

    expect(mocks.handleGuestDeposit).toHaveBeenCalledWith(request, response);
  });

  it('chuyển tiếp guest PayOS donation về handler anonymous tương ứng', async () => {
    mocks.findGuestDonation.mockResolvedValue({ orderCode: '1003' });
    const request = createWebhookRequest({ orderCode: '1003' });
    const response = createMockResponse();

    await handlePayosPaymentWebhook(request, response);

    expect(mocks.handleGuestDonation).toHaveBeenCalledWith(request, response);
  });

  it('không xử lý khi orderCode trùng giữa nhiều luồng', async () => {
    mocks.findAccountDeposit.mockResolvedValue({ orderCode: '1004' });
    mocks.findGuestDonation.mockResolvedValue({ orderCode: '1004' });
    const response = createMockResponse();

    await handlePayosPaymentWebhook(createWebhookRequest({ orderCode: '1004' }), response);

    expect(mocks.handleAccountDeposit).not.toHaveBeenCalled();
    expect(mocks.handleGuestDeposit).not.toHaveBeenCalled();
    expect(mocks.handleGuestDonation).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
