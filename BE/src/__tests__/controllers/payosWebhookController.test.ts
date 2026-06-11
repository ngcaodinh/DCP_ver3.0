/**
 * Unit tests cho PayOS Webhook Controller (Task A2).
 * Test cac edge cases: empty payload, missing identifier, IP extraction, checksum normalization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mockProcessPayosWebhook = vi.hoisted(() => vi.fn());

vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

vi.mock('../../services/payosWebhookService', () => ({
  processPayosWebhook: mockProcessPayosWebhook
}));

import {
  handlePayosWebhook,
  handlePayosWebhookHealth
} from '../../controllers/payosWebhookController';

function createMockRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    body: {},
    ip: '127.0.0.1',
    headers: {},
    ...overrides
  } as unknown as Request;
}

function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as unknown as Response;
}

describe('handlePayosWebhookHealth', () => {
  it('tra ve 200 voi timestamp', async () => {
    const req = createMockRequest();
    const res = createMockResponse();

    await handlePayosWebhookHealth(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.any(String),
        timestamp: expect.any(String)
      })
    );
  });
});

describe('handlePayosWebhook - edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tra ve 200 khi payload trong', async () => {
    const req = createMockRequest({ body: {} });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Webhook URL hoạt động.' })
    );
  });

  it('tra ve 200 khi thieu business identifier', async () => {
    const req = createMockRequest({
      body: {
        status: 'SUCCESS',
        signature: 'valid'
      }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Webhook URL hoạt động.' })
    );
  });

  it('tra ve 200 cho disbursement khong tim thay (khong retry PayOS)', async () => {
    mockProcessPayosWebhook.mockRejectedValue(
      new Error('Không tìm thấy disbursement theo transferId hoặc requestId.')
    );

    const req = createMockRequest({
      body: {
        requestId: 'DS-NOTFOUND',
        status: 'SUCCESS',
        signature: 'valid'
      }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Webhook URL hoạt động.' })
    );
  });

  it('tra ve 400 cho checksum khong hop le', async () => {
    mockProcessPayosWebhook.mockRejectedValue(
      new Error('Webhook checksum không hợp lệ.')
    );

    const req = createMockRequest({
      body: {
        requestId: 'DS-123',
        status: 'SUCCESS',
        signature: 'invalid'
      }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('checksum') })
    );
  });

  it('tra ve 200 voi isDuplicate=true cho webhook trung lap', async () => {
    mockProcessPayosWebhook.mockResolvedValue({
      success: true,
      isDuplicate: true,
      disbursement: null,
      message: 'Webhook đã được xử lý trước đó.'
    });

    const req = createMockRequest({
      body: {
        requestId: 'DS-DUP',
        status: 'SUCCESS',
        signature: 'valid'
      }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        isDuplicate: true
      })
    );
  });

  it('tra ve 200 voi disbursement details khi xu ly thanh cong', async () => {
    mockProcessPayosWebhook.mockResolvedValue({
      success: true,
      isDuplicate: false,
      disbursement: {
        requestId: 'DS-123',
        projectId: 'PRJ-001',
        organizationId: 'ORG-001',
        status: 'COMPLETED',
        payosTransferStatus: 'SUCCESS',
        payosTransferId: 'TRF-456',
        amount: 1000000,
        beneficiaryWalletAddress: '0x123...',
        beneficiaryBankAccount: { bankName: 'VCB', bankAccountNumber: '123', accountHolderName: 'Test' },
        approvals: [],
        rejection: null,
        requiredApprovals: 2,
        raisedRatioBpsAtCreation: 5000,
        onChainRequestId: 1,
        requestMode: 'NORMAL',
        emergencyReason: null,
        usagePurpose: 'Test',
        evidenceCid: 'QmTest',
        timeoutDeadline: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiredAt: null,
        completedAt: new Date()
      },
      message: 'Webhook đã được xử lý thành công.'
    });

    const req = createMockRequest({
      body: {
        requestId: 'DS-123',
        status: 'SUCCESS',
        signature: 'valid'
      }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        isDuplicate: false,
        requestId: 'DS-123',
        status: 'COMPLETED',
        payosTransferStatus: 'SUCCESS'
      })
    );
  });

  it('tra ve 200 (khong retry) cho loi xu ly khac', async () => {
    mockProcessPayosWebhook.mockRejectedValue(new Error('Database connection failed'));

    const req = createMockRequest({
      body: {
        requestId: 'DS-ERROR',
        status: 'SUCCESS',
        signature: 'valid'
      }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Webhook đã được nhận.' })
    );
  });

  it('su dung x-client-ip header khi co', async () => {
    mockProcessPayosWebhook.mockResolvedValue({
      success: true,
      isDuplicate: false,
      disbursement: null,
      message: 'OK'
    });

    const req = createMockRequest({
      body: { requestId: 'DS-IP', status: 'SUCCESS', signature: 'valid' },
      headers: { 'x-client-ip': '203.0.113.50' }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(mockProcessPayosWebhook).toHaveBeenCalledWith(
      expect.anything(),
      '203.0.113.50'
    );
  });

  it('su dung x-forwarded-for lay IP dau tien', async () => {
    mockProcessPayosWebhook.mockResolvedValue({
      success: true,
      isDuplicate: false,
      disbursement: null,
      message: 'OK'
    });

    const req = createMockRequest({
      body: { requestId: 'DS-FWD', status: 'SUCCESS', signature: 'valid' },
      headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(mockProcessPayosWebhook).toHaveBeenCalledWith(
      expect.anything(),
      '10.0.0.1'
    );
  });

  it('lay signature tu header x-payos-signature', async () => {
    mockProcessPayosWebhook.mockResolvedValue({
      success: true,
      isDuplicate: false,
      disbursement: null,
      message: 'OK'
    });

    const req = createMockRequest({
      body: { requestId: 'DS-HEADER' },
      headers: { 'x-payos-signature': 'header-signature-123' }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(mockProcessPayosWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: 'header-signature-123',
        checksum: 'header-signature-123'
      }),
      expect.anything()
    );
  });

  it('uu tien body signature thay vi header', async () => {
    mockProcessPayosWebhook.mockResolvedValue({
      success: true,
      isDuplicate: false,
      disbursement: null,
      message: 'OK'
    });

    const req = createMockRequest({
      body: { requestId: 'DS-BODY-SIG', signature: 'body-signature-456' },
      headers: { 'x-payos-signature': 'header-signature-123' }
    });
    const res = createMockResponse();

    await handlePayosWebhook(req, res);

    expect(mockProcessPayosWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: 'body-signature-456',
        checksum: 'body-signature-456'
      }),
      expect.anything()
    );
  });
});
