import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCountDocuments, mockFind, mockFindOne, mockFindOneAndUpdate, mockExec, mockModel } = vi.hoisted(() => {
  const mockCountDocuments = vi.fn();
  const mockFind = vi.fn();
  const mockFindOne = vi.fn();
  const mockFindOneAndUpdate = vi.fn();
  const mockExec = vi.fn();
  const mockModel = vi.fn();
  mockModel.mockReturnValue({ find: mockFind, findOne: mockFindOne, findOneAndUpdate: mockFindOneAndUpdate, countDocuments: mockCountDocuments });
  return { mockCountDocuments, mockFind, mockFindOne, mockFindOneAndUpdate, mockExec, mockModel };
});

vi.mock('mongoose', () => {
  class MockSchema {
    /** Mô phỏng API index của Mongoose để test query wrapper không cần kết nối Mongo. */
    public index(): this {
      return this;
    }
  }
  return {
    default: {
      model: mockModel
    },
    Schema: MockSchema
  };
});

import {
  countPendingKycSubmissions,
  findFoundationKycSubmissions,
  findLatestApprovedFoundationKycSubmission,
  findLatestFoundationSubmissionByLegalRegistrationNumber,
  updateOrganizationKycSubmissionReview
} from '../../models/organizationKycModel';

/** Dựng chain query tối thiểu mà các helper model đang sử dụng. */
function createQueryChain(): { sort: ReturnType<typeof vi.fn>; lean: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> } {
  const queryChain = {
    sort: vi.fn(),
    lean: vi.fn(),
    exec: mockExec
  };
  queryChain.sort.mockReturnValue(queryChain);
  queryChain.lean.mockReturnValue(queryChain);
  return queryChain;
}

describe('organization KYC FOUNDATION model boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const queryChain = createQueryChain();
    mockFind.mockReturnValue(queryChain);
    mockFindOne.mockReturnValue(queryChain);
    mockFindOneAndUpdate.mockReturnValue({ exec: mockExec });
    mockCountDocuments.mockReturnValue({ exec: mockExec });
  });

  it('excludes FOUNDATION records from the legacy NGO pending count', async () => {
    mockExec.mockResolvedValue(2);

    await expect(countPendingKycSubmissions()).resolves.toBe(2);

    expect(mockCountDocuments).toHaveBeenCalledWith({
      status: 'PENDING_REVIEW',
      organizationCategory: { $ne: 'FOUNDATION' }
    });
  });

  it('loads the latest FOUNDATION version by normalized legal registration number', async () => {
    mockExec.mockResolvedValue({ submissionId: 'foundation-2', version: 2 });

    await expect(findLatestFoundationSubmissionByLegalRegistrationNumber('ABC123'))
      .resolves.toEqual({ submissionId: 'foundation-2', version: 2 });

    expect(mockFindOne).toHaveBeenCalledWith({
      organizationCategory: 'FOUNDATION',
      legalRegistrationNumber: 'ABC123'
    });
  });

  it('loads all pending and reviewed legal-entity submissions for the Regulatory history', async () => {
    mockExec.mockResolvedValue([{ submissionId: 'foundation-approved', status: 'APPROVED' }]);

    await expect(findFoundationKycSubmissions()).resolves.toMatchObject([
      { submissionId: 'foundation-approved', status: 'APPROVED' }
    ]);

    expect(mockFind).toHaveBeenCalledWith({
      status: { $in: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] }
    });
  });

  it('loads only the latest approved FOUNDATION for the public badge', async () => {
    mockExec.mockResolvedValue({
      submissionId: 'foundation-approved',
      organizationCategory: 'FOUNDATION',
      status: 'APPROVED'
    });

    await expect(findLatestApprovedFoundationKycSubmission()).resolves.toMatchObject({
      submissionId: 'foundation-approved'
    });

    expect(mockFindOne).toHaveBeenCalledWith({
      organizationCategory: 'FOUNDATION',
      status: 'APPROVED'
    });
  });

  it('updates review only while the submission is still pending', async () => {
    mockExec.mockResolvedValue({ toObject: () => ({ submissionId: 'foundation-001', status: 'APPROVED' }) });

    await expect(updateOrganizationKycSubmissionReview('foundation-001', {
      status: 'APPROVED',
      reviewedBy: 'reviewer-1',
      reviewedAt: new Date('2026-08-18T00:00:00.000Z'),
      rejectionReason: null,
      files: []
    })).resolves.toMatchObject({ submissionId: 'foundation-001', status: 'APPROVED' });

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { submissionId: 'foundation-001', status: 'PENDING_REVIEW' },
      expect.objectContaining({ status: 'APPROVED' }),
      { returnDocument: 'after' }
    );
  });
});
