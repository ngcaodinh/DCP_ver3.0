import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../models/projectModel';

const { mockCleanupPhotos, mockCreate, mockCreateRegistry, mockFindReport, mockFindProject, mockProcessPhotos } = vi.hoisted(() => ({ mockCleanupPhotos: vi.fn(), mockCreate: vi.fn(), mockCreateRegistry: vi.fn(), mockFindReport: vi.fn(), mockFindProject: vi.fn(), mockProcessPhotos: vi.fn() }));
vi.mock('../../repositories/auditorFieldReportRepository', () => ({ createAuditorFieldReportFromRepository: mockCreate, findAuditorFieldReportByProjectIdFromRepository: mockFindReport }));
vi.mock('../../repositories/evidencePhotoRegistryRepository', () => ({ createEvidencePhotoRegistryRecordsFromRepository: mockCreateRegistry }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectById: mockFindProject }));
vi.mock('../../services/evidencePhotoCapture.service', () => ({ processCapturedEvidencePhotos: mockProcessPhotos, cleanupCapturedEvidencePhotos: mockCleanupPhotos }));
vi.mock('../../utils/mongoTransaction', () => ({ runMongoTransaction: async (work: (session: undefined) => unknown) => work(undefined) }));
import { submitAuditorFieldReport } from '../../services/auditorFieldReport.service';

/** Tạo fixture dự án ACTIVE có đủ ba milestone. */
function project(status: ProjectRecord['status'] = 'ACTIVE'): ProjectRecord {
  const now = new Date();
  return { projectId: 'project-1', organizationId: 'org-1', name: 'Dự án', description: 'Mô tả hợp lệ', goalAmount: 1, deadline: now, status, evidenceCids: [], evidenceFiles: [], submittedAt: now, reviewedAt: now, reviewedBy: 'r', rejectionReason: null, milestonePlan: [{ milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 25, description: 'Chuẩn bị vật tư và hiện trường dự án.' }, { milestoneIndex: 2, milestoneKey: 'M2_CONSTRUCTION', percentage: 45, description: 'Thi công phần khung công trình chính.' }, { milestoneIndex: 3, milestoneKey: 'M3_HANDOVER', percentage: 30, description: 'Nghiệm thu và bàn giao công trình.' }], createdAt: now, updatedAt: now };
}

const now = new Date('2026-08-20T10:00:00.000Z');
const payload = { projectId: 'project-1', note: 'Đã kiểm tra thực địa, ghi nhận hạng mục hoàn thành.', verifiedMilestoneIndexes: [1, 2], clientSubmittedAt: now.toISOString(), photos: [{ fileName: 'capture-1.jpg', mimeType: 'image/jpeg' as const, contentBase64: 'unused', gps: { latitude: 21, longitude: 105 }, accuracyMeters: 20, capturedAtClient: now.toISOString(), geolocationTimestamp: now.toISOString(), lowAccuracyOverride: false, overrideUnlockedAfterMs: null, lowAccuracyReason: null }] };

describe('auditor field report service', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mockFindProject.mockResolvedValue(project()); mockFindReport.mockResolvedValue(null); mockCreate.mockResolvedValue({ reportId: 'report-1' }); mockCreateRegistry.mockResolvedValue(undefined);
    mockProcessPhotos.mockResolvedValue([{ ...payload.photos[0], cid: 'bafyfield', contentSha256: 'a'.repeat(64), capturedAt: now, capturedAtClient: now, clockSkewSeconds: 0 }]);
  });

  it('records field-report evidence through the camera registry contract', async () => {
    await expect(submitAuditorFieldReport('auditor-1', payload)).resolves.toMatchObject({ reportId: 'report-1' });
    expect(mockProcessPhotos).toHaveBeenCalledWith(expect.objectContaining({ module: 'AUDITOR_FIELD_REPORT' }));
    expect(mockCreateRegistry).toHaveBeenCalledWith([expect.objectContaining({ module: 'AUDITOR_FIELD_REPORT', refId: 'report-1' })], undefined);
  });

  it('rejects non-ACTIVE projects and duplicate reports before processing photos', async () => {
    mockFindProject.mockResolvedValue(project('PENDING_ACTIVATION'));
    await expect(submitAuditorFieldReport('auditor-1', payload)).rejects.toMatchObject({ errorCode: 'INVALID_STATUS_TRANSITION' });
    mockFindProject.mockResolvedValue(project()); mockFindReport.mockResolvedValue({ reportId: 'existing' });
    await expect(submitAuditorFieldReport('auditor-1', payload)).rejects.toMatchObject({ errorCode: 'FIELD_REPORT_ALREADY_EXISTS' });
    expect(mockProcessPhotos).not.toHaveBeenCalled();
  });

  it('rejects milestones outside the project plan', async () => {
    await expect(submitAuditorFieldReport('auditor-1', { ...payload, verifiedMilestoneIndexes: [3, 4] })).rejects.toMatchObject({ errorCode: 'MILESTONE_NOT_FOUND' });
  });
});
