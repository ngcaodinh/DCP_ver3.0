import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPayosPaymentLink,
  getPayosPaymentLinkStatus,
  getPayosTransferStatusByReferenceId
} from '../../services/payosService';

/** Tạo response PayOS tối thiểu cho các case reconciliation nhiều payout. */
function createPayosResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: '00', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('payosService provider reconciliation', () => {
  beforeEach(() => {
    process.env.PAYOS_TRANSFER_CLIENT_ID = 'test-client-id';
    process.env.PAYOS_TRANSFER_API_KEY = 'test-api-key';
    process.env.PAYOS_TRANSFER_API_URL = 'https://payos.test/v1/payouts';
    process.env.PAYOS_CLIENT_ID = 'test-client-id';
    process.env.PAYOS_API_KEY = 'test-api-key';
    process.env.PAYOS_CHECKSUM_KEY = 'test-checksum-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PAYOS_TRANSFER_CLIENT_ID;
    delete process.env.PAYOS_TRANSFER_API_KEY;
    delete process.env.PAYOS_TRANSFER_API_URL;
    delete process.env.PAYOS_CLIENT_ID;
    delete process.env.PAYOS_API_KEY;
    delete process.env.PAYOS_CHECKSUM_KEY;
  });

  it('treats any PROCESSING payout as active when an older payout is FAILED', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createPayosResponse([
      { id: 'payout-failed', status: 'FAILED' },
      { id: 'payout-processing', status: 'PROCESSING' }
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getPayosTransferStatusByReferenceId('DS-001');
    const requestUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);

    expect(result).toMatchObject({
      found: true,
      transferId: 'payout-processing',
      transferStatus: 'PROCESSING'
    });
    expect(requestUrl.searchParams.get('referenceId')).toBe('DS-001');
    expect(requestUrl.searchParams.get('limit')).toBe('100');
  });

  it('prioritizes SUCCESS over older FAILED or PROCESSING payouts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createPayosResponse({
      payouts: [
        { id: 'payout-processing', status: 'PROCESSING' },
        { id: 'payout-success', status: 'SUCCESS' },
        { id: 'payout-failed', status: 'FAILED' }
      ]
    })));

    await expect(getPayosTransferStatusByReferenceId('DS-001')).resolves.toMatchObject({
      found: true,
      transferId: 'payout-success',
      transferStatus: 'SUCCESS'
    });
  });

  it('sanitizes structured provider error bodies before exposing the Error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: '101',
      desc: JSON.stringify({
        accountHolderName: 'Nguyen Van A',
        accountNumber: '1234567890',
        message: 'Invalid beneficiary account'
      })
    }), { status: 502 })));

    let caughtError: unknown;
    try {
      await getPayosTransferStatusByReferenceId('DS-001');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const errorMessage = (caughtError as Error).message;
    expect(errorMessage).not.toContain('Nguyen Van A');
    expect(errorMessage).not.toContain('1234567890');
    expect(errorMessage).toContain('[REDACTED]');
  });

  it('sanitizes malformed successful payment-link payloads before exposing the Error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: '00',
      data: {
        accountHolderName: 'Nguyen Van A',
        accountNumber: '1234567890',
        message: 'Missing checkout URL'
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));

    let caughtError: unknown;
    try {
      await createPayosPaymentLink({
        orderCode: '1001',
        amountVnd: 100_000,
        description: 'Test payment',
        returnUrl: 'https://example.test/return',
        cancelUrl: 'https://example.test/cancel'
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    const errorMessage = (caughtError as Error).message;
    expect(errorMessage).toContain('payment link không hợp lệ');
    expect(errorMessage).not.toContain('Nguyen Van A');
    expect(errorMessage).not.toContain('1234567890');
    expect(errorMessage).toContain('[REDACTED]');
  });

  it('lấy trạng thái payment link trực tiếp từ PayOS theo orderCode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createPayosResponse({
      amount: 3_000_000,
      id: 'payos-link-001',
      orderCode: 1787650889515545,
      status: 'PAID'
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPayosPaymentLinkStatus('1787650889515545')).resolves.toEqual({
      amountVnd: 3_000_000,
      orderCode: '1787650889515545',
      paymentLinkId: 'payos-link-001',
      status: 'PAID'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-merchant.payos.vn/v2/payment-requests/1787650889515545',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('chặn orderCode vượt giới hạn trước khi gửi request đến PayOS', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createPayosPaymentLink({
      orderCode: String(Number.MAX_SAFE_INTEGER + 1),
      amountVnd: 100_000,
      description: 'Test payment',
      returnUrl: 'https://example.test/return',
      cancelUrl: 'https://example.test/cancel'
    })).rejects.toThrow('orderCode PayOS vượt giới hạn cho phép.');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
