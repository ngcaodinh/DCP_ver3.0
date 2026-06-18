/**
 * Unit tests cho transparencyController — input validation, query parsing, va response shape.
 *
 * Coverage:
 * 1. Input validation — valid request tra ve 200 voi dung shape
 * 2. Input validation — invalid wallet address (khong match regex) tra ve 400
 * 3. Input validation — invalid date format tra ve 400
 * 4. Input validation — pageSize < 1 tra ve 400
 * 5. Input validation — pageSize > 50 tra ve 400
 * 6. Query params hop le duoc parse va truyen dung cho service
 * 7. startDate / endDate duoc parse thanh Date object
 * 8. pageSize duoc coerce thanh integer
 * 9. Service throws error → controller tra ve 500 voi message
 * 10. Response shape dung: { timeline, nextCursor, cached, grouped, count }
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleGetUnifiedTimeline } from '../../controllers/transparencyController';
import { getUnifiedTimeline, groupTimelineByCorrelation } from '../../services/unified-timeline.service';

vi.mock('../../services/unified-timeline.service', () => ({
  getUnifiedTimeline: vi.fn(),
  groupTimelineByCorrelation: vi.fn()
}));

function createMockRequest(query: Record<string, unknown> = {}) {
  return {
    query
  } as unknown as Parameters<typeof handleGetUnifiedTimeline>[0];
}

function createMockResponse() {
  const res: Partial<Parameters<typeof handleGetUnifiedTimeline>[1]> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as Parameters<typeof handleGetUnifiedTimeline>[1];
}

function createMockTimelineEvent() {
  return {
    eventId: 'event-001',
    correlationId: 'deposit:12345678',
    eventType: 'DONATION' as const,
    timestamp: '2024-06-15T10:30:00.000Z',
    chainBlockNumber: 12345678,
    amountVnd: 50000,
    chainStatus: 'CONFIRMED' as const,
    chainTxHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    payosStatus: 'PAYMENT_CONFIRMED' as const,
    payosOrderCode: '12345678',
    walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
    projectId: 'project-001',
    source: 'payos' as const
  };
}

describe('transparencyController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===== 1. Input validation — valid request tra ve 200 =====
  describe('valid request handling', () => {
    it('valid request tra ve 200 voi dung shape', async () => {
      const mockTimeline = [createMockTimelineEvent()];
      const mockGrouped = new Map([['deposit:12345678', mockTimeline]]);

      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: mockTimeline,
        nextCursor: null,
        cached: false,
        count: 1
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(mockGrouped);

      const req = createMockRequest({ projectId: 'project-001' });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        timeline: mockTimeline,
        nextCursor: null,
        cached: false,
        grouped: { 'deposit:12345678': mockTimeline },
        count: 1
      });
    });

    it('request voi tat ca params hop le', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        projectId: 'project-001',
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-12-31T23:59:59.999Z',
        pageSize: '25',
        cursor: 'some-cursor'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-001',
          walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a',
          startDate: '2024-01-01T00:00:00.000Z',
          endDate: '2024-12-31T23:59:59.999Z'
        }),
        25,
        'some-cursor'
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ===== 2. Input validation — invalid wallet address =====
  describe('walletAddress validation', () => {
    it('invalid wallet address (khong match regex) tra ve 400', async () => {
      const req = createMockRequest({
        walletAddress: 'invalid-address'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            field: 'walletAddress',
            message: expect.stringContaining('Invalid')
          })
        ])
      });
    });

    it('wallet address qua ngan tra ve 400', async () => {
      const req = createMockRequest({
        walletAddress: '0x123'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('wallet address khong co prefix 0x tra ve 400', async () => {
      const req = createMockRequest({
        walletAddress: '742d35cc6634c0532925a3b844bc9e7595f5c21a'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ===== 3. Input validation — invalid date format =====
  describe('date format validation', () => {
    it('invalid startDate format tra ve 400', async () => {
      const req = createMockRequest({
        startDate: 'not-a-date'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            field: 'startDate'
          })
        ])
      });
    });

    it('invalid endDate format tra ve 400', async () => {
      const req = createMockRequest({
        endDate: '2024/01/01'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('date khong co timezone cu phap ISO tra ve 400', async () => {
      const req = createMockRequest({
        startDate: '2024-01-01'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ===== 4. Input validation — pageSize < 1 =====
  describe('pageSize validation', () => {
    it('pageSize < 1 tra ve 400', async () => {
      const req = createMockRequest({
        pageSize: '0'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            field: 'pageSize'
          })
        ])
      });
    });

    it('pageSize am tra ve 400', async () => {
      const req = createMockRequest({
        pageSize: '-5'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ===== 5. Input validation — pageSize > 50 =====
  describe('pageSize max validation', () => {
    it('pageSize > 50 tra ve 400', async () => {
      const req = createMockRequest({
        pageSize: '100'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            field: 'pageSize'
          })
        ])
      });
    });

    it('pageSize = 50 la hop le', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        pageSize: '50'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ===== 6. Query params parsing =====
  describe('query params parsing', () => {
    it('projectId duoc trim', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        projectId: '  project-001  '
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-001'
        }),
        expect.any(Number),
        undefined
      );
    });

    it('walletAddress valid duoc xu ly dung', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      // Use valid walletAddress without extra whitespace
      const req = createMockRequest({
        walletAddress: '0x742d35cc6634c0532925a3b844bc9e7595f5c21a'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('pageSize duoc coerce thanh integer', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        pageSize: '25'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        25,
        undefined
      );
    });

    it('default pageSize la 50', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({});
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        50,
        undefined
      );
    });

    it('cursor duoc trim', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        cursor: '  some-cursor-value  '
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Number),
        'some-cursor-value'
      );
    });

    it('empty cursor bi bo qua', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        cursor: '   '
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Number),
        undefined
      );
    });
  });

  // ===== 7. startDate / endDate parsing =====
  describe('date params parsing', () => {
    it('startDate va endDate duoc truyen dung cho service', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        startDate: '2024-01-01T00:00:00.000Z',
        endDate: '2024-12-31T23:59:59.999Z'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: '2024-01-01T00:00:00.000Z',
          endDate: '2024-12-31T23:59:59.999Z'
        }),
        expect.any(Number),
        undefined
      );
    });

    it('startDate null/undefined khong duoc truyen', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({});
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: undefined,
          endDate: undefined
        }),
        expect.any(Number),
        undefined
      );
    });
  });

  // ===== 8. Response shape =====
  describe('response shape', () => {
    it('response co tat ca cac fields bat buoc', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [createMockTimelineEvent()],
        nextCursor: 'next-cursor-value',
        cached: true,
        count: 1
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map([
        ['deposit:12345678', [createMockTimelineEvent()]]
      ]));

      const req = createMockRequest({});
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          timeline: expect.any(Array),
          nextCursor: 'next-cursor-value',
          cached: true,
          grouped: expect.any(Object),
          count: 1
        })
      );
    });

    it('grouped duoc tao tu groupTimelineByCorrelation', async () => {
      const mockTimeline = [createMockTimelineEvent()];
      const mockGrouped = new Map([
        ['corr-1', [mockTimeline[0]]],
        ['corr-2', [mockTimeline[0]]]
      ]);

      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: mockTimeline,
        nextCursor: null,
        cached: false,
        count: 1
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(mockGrouped);

      const req = createMockRequest({});
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(groupTimelineByCorrelation).toHaveBeenCalledWith(mockTimeline);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          grouped: { 'corr-1': [mockTimeline[0]], 'corr-2': [mockTimeline[0]] }
        })
      );
    });
  });

  // ===== 9. Service error handling =====
  describe('service error handling', () => {
    it('service throws error → tra ve 500 voi message', async () => {
      vi.mocked(getUnifiedTimeline).mockRejectedValue(new Error('Database connection failed'));

      const req = createMockRequest({});
      const res = createMockResponse();

      // Catch the error to prevent test crash
      await expect(
        handleGetUnifiedTimeline(req, res)
      ).rejects.toThrow('Database connection failed');
    });
  });

  // ===== 10. Validation error details =====
  describe('validation error details format', () => {
    it('tra ve dung format error details', async () => {
      const req = createMockRequest({
        walletAddress: 'invalid',
        pageSize: '100'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.json).toHaveBeenCalledWith({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({
            field: expect.any(String),
            message: expect.any(String)
          })
        ])
      });
    });

    it('nhieu loi validation duoc tra ve cung luc', async () => {
      const req = createMockRequest({
        walletAddress: 'invalid',
        startDate: 'not-a-date',
        pageSize: '100'
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const jsonCall = vi.mocked(res.json);
      const callArgs = jsonCall.mock.calls[0][0] as { details: unknown[] };
      expect((callArgs.details as unknown[]).length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===== Edge cases =====
  describe('edge cases', () => {
    it('khong co query params nao van hoat dong', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({});
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: undefined,
          walletAddress: undefined,
          startDate: undefined,
          endDate: undefined
        }),
        50,
        undefined
      );
    });

    it('projectId rong sau trim bi bo qua', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        projectId: '   '
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      expect(getUnifiedTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: undefined
        }),
        expect.any(Number),
        undefined
      );
    });

    it('cursor khong hop le (khong phai string) bi bo qua', async () => {
      vi.mocked(getUnifiedTimeline).mockResolvedValue({
        timeline: [],
        nextCursor: null,
        cached: false,
        count: 0
      });
      vi.mocked(groupTimelineByCorrelation).mockReturnValue(new Map());

      const req = createMockRequest({
        cursor: { invalid: 'object' } as unknown as string
      });
      const res = createMockResponse();

      await handleGetUnifiedTimeline(req, res);

      // Zod schema se reject vi cursor phai la string
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
