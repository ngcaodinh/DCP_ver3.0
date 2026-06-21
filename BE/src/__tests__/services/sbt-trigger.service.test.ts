import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()
  })
}));

vi.mock('../../services/sbtMintService', () => ({
  createSbtMintRequest: vi.fn()
}));

// No model mock needed - service only imports types, not functions from this module

import { triggerSbtMintFromOracle, isTransactionStuck } from '../../services/sbt-trigger.service';
import { createSbtMintRequest } from '../../services/sbtMintService';

// =============================================================================
// Test: isTransactionStuck
// =============================================================================
describe('sbt-trigger.service - isTransactionStuck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
  });

  it('trả về false khi status không phải SUBMITTED', () => {
    const record = { status: 'PENDING' } as any;
    expect(isTransactionStuck(record)).toBe(false);
  });

  it('trả về false khi submittedAt là null', () => {
    const record = { status: 'SUBMITTED', submittedAt: null } as any;
    expect(isTransactionStuck(record)).toBe(false);
  });

  it('trả về false khi SUBMITTED dưới 5 phút', () => {
    const recentDate = new Date('2025-01-01T11:56:00Z'); // 4 phút trước
    const record = { status: 'SUBMITTED', submittedAt: recentDate } as any;
    expect(isTransactionStuck(record)).toBe(false);
  });

  it('trả về true khi SUBMITTED hơn 5 phút', () => {
    const oldDate = new Date('2025-01-01T11:54:00Z'); // 6 phút trước
    const record = { status: 'SUBMITTED', submittedAt: oldDate } as any;
    expect(isTransactionStuck(record)).toBe(true);
  });
});

// =============================================================================
// Test: triggerSbtMintFromOracle
// =============================================================================
describe('sbt-trigger.service - triggerSbtMintFromOracle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tạo mint request mới + trả về duplicate=false', async () => {
    const validPayload = {
      verificationId: 'ver-new',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    const expectedRecord = {
      sbtId: 'SBT-new',
      mintRequestId: 'SBT-MINT-new',
      verificationId: 'ver-new',
      projectId: 'proj-1',
      status: 'PENDING'
    };

    (createSbtMintRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: expectedRecord as any,
      jobId: 'job-123',
      enqueued: true,
      duplicate: false
    });

    const result = await triggerSbtMintFromOracle(validPayload);

    expect(result.duplicate).toBe(false);
    expect(result.record.sbtId).toBe('SBT-new');
    expect(createSbtMintRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationId: 'ver-new',
        projectId: 'proj-1',
        organizationId: 'org-1',
        beneficiaryAddress: '0x1234567890123456789012345678901234567890',
        projectIdNumeric: 1,
        milestone: 0,
        beneficiaryCount: 1,
        gpsCoordinates: '',
        imageCid: 'QmTest',
        tokenUri: 'ipfs://QmTest'
      })
    );
  });

  it('trả về duplicate=true khi verificationId đã tồn tại', async () => {
    const validPayload = {
      verificationId: 'ver-existing',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,
      beneficiaryCount: 1,
      gpsCoordinates: '',
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    const existingRecord = {
      sbtId: 'SBT-existing',
      mintRequestId: 'SBT-MINT-existing',
      verificationId: 'ver-existing',
      projectId: 'proj-1',
      status: 'PENDING'
    };

    (createSbtMintRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: existingRecord as any,
      jobId: undefined,
      enqueued: false,
      duplicate: true
    });

    const result = await triggerSbtMintFromOracle(validPayload);

    expect(result.duplicate).toBe(true);
    expect(result.record.mintRequestId).toBe('SBT-MINT-existing');
  });

  it('sử dụng giá trị default cho các trường optional (được apply bởi Zod ở controller)', async () => {
    // Service nhận pre-validated data từ controller (Zod đã apply defaults)
    const validatedPayload: Parameters<typeof triggerSbtMintFromOracle>[0] = {
      verificationId: 'ver-defaults',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      milestone: 0,        // default đã được Zod apply ở controller
      beneficiaryCount: 0, // default đã được Zod apply ở controller
      gpsCoordinates: '',  // default đã được Zod apply ở controller
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
    };

    (createSbtMintRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: { sbtId: 'SBT-defaults', mintRequestId: 'SBT-MINT-defaults' } as any,
      jobId: 'job-defaults',
      enqueued: true,
      duplicate: false
    });

    await triggerSbtMintFromOracle(validatedPayload);

    expect(createSbtMintRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        milestone: 0,
        beneficiaryCount: 0,
        gpsCoordinates: ''
      })
    );
  });
});
