/**
 * Test cho feedbackFlagging.service.ts - kiểm tra admin flag/unflag operations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getFlaggedFeedback,
  flagFeedbackManually,
  unflagFeedback,
  FeedbackNotFoundError,
  FlagValidationError
} from '../../services/feedbackFlagging.service';

// Create mock functions
const mockFind = vi.fn();
const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockCountDocuments = vi.fn();

// Mock mongoose model
vi.mock('../../models/beneficiaryFeedbackModel', () => ({
  BeneficiaryFeedbackModel: {
    find: (...args: unknown[]) => mockFind(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args)
  }
}));

describe('feedbackFlagging.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mocks
    mockFind.mockReset();
    mockFindOne.mockReset();
    mockFindOneAndUpdate.mockReset();
    mockCountDocuments.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getFlaggedFeedback', () => {
    const mockFlaggedFeedbacks = [
      {
        feedbackId: 'fb001',
        projectId: 'proj001',
        beneficiaryNameHash: 'hash1',
        rating: 1,
        comment: 'Bad service',
        submittedAt: new Date(),
        riskScore: 8,
        isFlagged: true,
        flagReason: 'High risk score',
        flaggedAt: new Date(),
        flaggedBy: 'admin1',
        uploadedByOrganizationId: 'org1',
        batchContentHash: 'batch1',
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        feedbackId: 'fb002',
        projectId: 'proj002',
        beneficiaryNameHash: 'hash2',
        rating: 5,
        comment: 'aaaaaa bbbbbb',
        submittedAt: new Date(),
        riskScore: 9,
        isFlagged: true,
        flagReason: 'Gibberish detected',
        flaggedAt: new Date(),
        flaggedBy: 'admin2',
        uploadedByOrganizationId: 'org2',
        batchContentHash: 'batch2',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    // Helper để tạo mock query chain có thể gọi .exec() và trả về resolvedValue.
    // Type dùng any cho chain vì mock object không cần kế thừa Query API đầy đủ.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createQueryChain = (resolvedValue: unknown): Record<string, any> => {
      const chain: Record<string, any> = {};
      chain.exec = async () => resolvedValue;
      chain.sort = vi.fn().mockReturnValue(chain);
      chain.skip = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.lean = vi.fn().mockReturnValue(chain);

      return chain;
    };

    it('nên trả về chỉ các feedback có isFlagged=true', async () => {
      const queryChain = createQueryChain(mockFlaggedFeedbacks);
      mockFind.mockReturnValue(queryChain);
      
      const countChain = { exec: async () => 2 };
      mockCountDocuments.mockReturnValue(countChain);

      const result = await getFlaggedFeedback();

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.items.every((fb: { isFlagged: boolean }) => fb.isFlagged)).toBe(true);
    });

    it('nên áp dụng pagination đúng', async () => {
      const queryChain = createQueryChain([mockFlaggedFeedbacks[0]]);
      mockFind.mockReturnValue(queryChain);
      
      const countChain = { exec: async () => 10 };
      mockCountDocuments.mockReturnValue(countChain);

      const result = await getFlaggedFeedback({ page: 2, limit: 5 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
      expect(result.totalPages).toBe(2);
    });

    it('nên giới hạn limit tối đa là 50', async () => {
      const queryChain = createQueryChain([]);
      mockFind.mockReturnValue(queryChain);
      
      const countChain = { exec: async () => 0 };
      mockCountDocuments.mockReturnValue(countChain);

      const result = await getFlaggedFeedback({ limit: 100 });

      expect(result.limit).toBe(50);
    });

    it('nên lọc theo projectId khi được cung cấp', async () => {
      const queryChain = createQueryChain([mockFlaggedFeedbacks[0]]);
      mockFind.mockReturnValue(queryChain);
      
      const countChain = { exec: async () => 1 };
      mockCountDocuments.mockReturnValue(countChain);

      await getFlaggedFeedback({ projectId: 'proj001' });

      expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj001' }));
    });

    it('nên lọc theo minRiskScore khi được cung cấp', async () => {
      const queryChain = createQueryChain([]);
      mockFind.mockReturnValue(queryChain);
      
      const countChain = { exec: async () => 0 };
      mockCountDocuments.mockReturnValue(countChain);

      await getFlaggedFeedback({ minRiskScore: 8 });

      expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
        riskScore: { $gte: 8 }
      }));
    });

    it('nên trả về empty result khi không có feedback nào được flag', async () => {
      const queryChain = createQueryChain([]);
      mockFind.mockReturnValue(queryChain);
      
      const countChain = { exec: async () => 0 };
      mockCountDocuments.mockReturnValue(countChain);

      const result = await getFlaggedFeedback();

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('flagFeedbackManually', () => {
    const existingFeedback = {
      feedbackId: 'fb001',
      projectId: 'proj001',
      beneficiaryNameHash: 'hash1',
      rating: 3,
      comment: 'Normal comment',
      submittedAt: new Date(),
      riskScore: 0,
      isFlagged: false,
      uploadedByOrganizationId: 'org1',
      batchContentHash: 'batch1',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const updatedFeedback = {
      ...existingFeedback,
      isFlagged: true,
      flagReason: 'Manual review required',
      flaggedAt: new Date(),
      flaggedBy: 'admin1',
      flagHistory: [{
        action: 'flagged',
        reason: 'Manual review required',
        performedBy: 'admin1',
        performedAt: new Date(),
        previousFlaggedState: false
      }]
    };

    // Helper để tạo mock findOne chain có thể gọi .exec() và trả về resolvedValue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createFindOneChain = (resolvedValue: unknown): Record<string, any> => {
      const chain: Record<string, any> = {};
      chain.exec = async () => resolvedValue;
      chain.lean = vi.fn().mockReturnValue(chain);

      return chain;
    };

    // Helper để tạo mock findOneAndUpdate chain có thể gọi .exec() và trả về resolvedValue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createFindOneAndUpdateChain = (resolvedValue: unknown): Record<string, any> => {
      const chain: Record<string, any> = {};
      chain.exec = async () => resolvedValue;
      chain.lean = vi.fn().mockReturnValue(chain);

      return chain;
    };

    it('nên set isFlagged=true và các trường flag metadata', async () => {
      const findOneChain = createFindOneChain(existingFeedback);
      mockFindOne.mockReturnValue(findOneChain);
      
      const updateChain = createFindOneAndUpdateChain(updatedFeedback);
      mockFindOneAndUpdate.mockReturnValue(updateChain);

      const result = await flagFeedbackManually('fb001', 'admin1', 'Manual review required');

      expect(result.isFlagged).toBe(true);
      expect(result.flagReason).toBe('Manual review required');
      expect(result.flaggedBy).toBe('admin1');
    });

    it('nên thêm flagHistory entry', async () => {
      const findOneChain = createFindOneChain(existingFeedback);
      mockFindOne.mockReturnValue(findOneChain);
      
      const updateChain = createFindOneAndUpdateChain(updatedFeedback);
      mockFindOneAndUpdate.mockReturnValue(updateChain);

      await flagFeedbackManually('fb001', 'admin1', 'Manual review required');

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { feedbackId: 'fb001' },
        expect.objectContaining({
          $push: expect.objectContaining({
            flagHistory: expect.objectContaining({
              $each: expect.arrayContaining([
                expect.objectContaining({
                  action: 'flagged',
                  reason: 'Manual review required',
                  performedBy: 'admin1',
                  previousFlaggedState: false
                })
              ]),
              $slice: -100
            })
          })
        }),
        { new: true }
      );
    });

    it('nên ném FeedbackNotFoundError khi feedback không tồn tại', async () => {
      const findOneChain = createFindOneChain(null);
      mockFindOne.mockReturnValue(findOneChain);

      await expect(flagFeedbackManually('nonexistent', 'admin1', 'Test reason'))
        .rejects
        .toThrow(FeedbackNotFoundError);
    });

    it('nên ném FlagValidationError khi reason < 5 ký tự', async () => {
      await expect(flagFeedbackManually('fb001', 'admin1', 'abc'))
        .rejects
        .toThrow(FlagValidationError);
    });

    it('nên ném FlagValidationError khi reason > 500 ký tự', async () => {
      const longReason = 'a'.repeat(501);
      await expect(flagFeedbackManually('fb001', 'admin1', longReason))
        .rejects
        .toThrow(FlagValidationError);
    });

    it('nên ném FlagValidationError khi reason là empty string', async () => {
      await expect(flagFeedbackManually('fb001', 'admin1', ''))
        .rejects
        .toThrow(FlagValidationError);
    });

    it('nên ném FlagValidationError khi reason là undefined', async () => {
      await expect(flagFeedbackManually('fb001', 'admin1', undefined as unknown as string))
        .rejects
        .toThrow(FlagValidationError);
    });
  });

  describe('unflagFeedback', () => {
    const flaggedFeedback = {
      feedbackId: 'fb001',
      projectId: 'proj001',
      beneficiaryNameHash: 'hash1',
      rating: 1,
      comment: 'Spam comment',
      submittedAt: new Date(),
      riskScore: 8,
      isFlagged: true,
      flagReason: 'High risk score',
      flaggedAt: new Date(),
      flaggedBy: 'admin1',
      uploadedByOrganizationId: 'org1',
      batchContentHash: 'batch1',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const unflaggedFeedback = {
      ...flaggedFeedback,
      isFlagged: false,
      flagHistory: [{
        action: 'unflagged',
        reason: 'Manual unflag by admin',
        performedBy: 'admin2',
        performedAt: new Date(),
        previousFlaggedState: true
      }]
    };

    // Helper để tạo mock findOne chain có thể gọi .exec() và trả về resolvedValue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createFindOneChain = (resolvedValue: unknown): Record<string, any> => {
      const chain: Record<string, any> = {};
      chain.exec = async () => resolvedValue;
      chain.lean = vi.fn().mockReturnValue(chain);

      return chain;
    };

    // Helper để tạo mock findOneAndUpdate chain có thể gọi .exec() và trả về resolvedValue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createFindOneAndUpdateChain = (resolvedValue: unknown): Record<string, any> => {
      const chain: Record<string, any> = {};
      chain.exec = async () => resolvedValue;
      chain.lean = vi.fn().mockReturnValue(chain);

      return chain;
    };

    it('nên set isFlagged=false khi unflag', async () => {
      const findOneChain = createFindOneChain(flaggedFeedback);
      mockFindOne.mockReturnValue(findOneChain);
      
      const updateChain = createFindOneAndUpdateChain(unflaggedFeedback);
      mockFindOneAndUpdate.mockReturnValue(updateChain);

      const result = await unflagFeedback('fb001', 'admin2');

      expect(result.isFlagged).toBe(false);
    });

    it('nên thêm flagHistory entry với action=unflagged', async () => {
      const findOneChain = createFindOneChain(flaggedFeedback);
      mockFindOne.mockReturnValue(findOneChain);
      
      const updateChain = createFindOneAndUpdateChain(unflaggedFeedback);
      mockFindOneAndUpdate.mockReturnValue(updateChain);

      await unflagFeedback('fb001', 'admin2');

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { feedbackId: 'fb001' },
        expect.objectContaining({
          $push: expect.objectContaining({
            flagHistory: expect.objectContaining({
              $each: expect.arrayContaining([
                expect.objectContaining({
                  action: 'unflagged',
                  previousFlaggedState: true
                })
              ]),
              $slice: -100
            })
          })
        }),
        { new: true }
      );
    });

    it('nên ném FeedbackNotFoundError khi feedback không tồn tại', async () => {
      const findOneChain = createFindOneChain(null);
      mockFindOne.mockReturnValue(findOneChain);

      await expect(unflagFeedback('nonexistent', 'admin1'))
        .rejects
        .toThrow(FeedbackNotFoundError);
    });
  });

  describe('FeedbackNotFoundError', () => {
    it('nên có đúng error properties', () => {
      const error = new FeedbackNotFoundError('fb001');

      expect(error.message).toContain('fb001');
      expect(error.statusCode).toBe(404);
      expect(error.errorCode).toBe('FEEDBACK_NOT_FOUND');
      expect(error.name).toBe('FeedbackNotFoundError');
    });
  });

  describe('FlagValidationError', () => {
    it('nên có đúng error properties', () => {
      const error = new FlagValidationError('Lý do không hợp lệ');

      expect(error.message).toBe('Lý do không hợp lệ');
      expect(error.statusCode).toBe(400);
      expect(error.errorCode).toBe('VALIDATION_ERROR');
      expect(error.name).toBe('FlagValidationError');
    });
  });
});
