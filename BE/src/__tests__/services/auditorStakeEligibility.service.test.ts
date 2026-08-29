import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findReports: vi.fn(),
  findGuard: vi.fn(),
  findProjectStatuses: vi.fn()
}));

vi.mock('../../repositories/auditorFieldReportRepository', () => ({ findAllAuditorFieldReportsByAuditorUserIdFromRepository: mocks.findReports }));
vi.mock('../../models/auditorStakeGuardModel', () => ({ findAuditorStakeGuardByUserId: mocks.findGuard }));
vi.mock('../../repositories/projectRepository', () => ({ findProjectStatusesByIdListFromRepository: mocks.findProjectStatuses }));

import { evaluateAuditorFullExitEligibility } from '../../services/auditorStakeEligibility.service';

describe('auditor full-exit eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findGuard.mockResolvedValue({ openCaseIds: [], penaltyDebtVnd: 0 });
    mocks.findReports.mockResolvedValue([]);
    mocks.findProjectStatuses.mockResolvedValue([]);
  });

  it('permits an Auditor with no open obligations to exit', async () => {
    await expect(evaluateAuditorFullExitEligibility('auditor-1')).resolves.toEqual({ eligible: true, reasons: [] });
  });

  it('reports every independent blocking reason together', async () => {
    mocks.findGuard.mockResolvedValue({ openCaseIds: ['case-1'], penaltyDebtVnd: 150_000 });
    mocks.findReports.mockResolvedValue([{ projectId: 'project-1' }]);
    mocks.findProjectStatuses.mockResolvedValue([{ projectId: 'project-1', name: 'Dự án A', status: 'ACTIVE' }]);

    const result = await evaluateAuditorFullExitEligibility('auditor-1');

    expect(result.eligible).toBe(false);
    expect(result.reasons.map(reason => reason.code)).toEqual(['OPEN_DISPUTE', 'PENALTY_DEBT', 'ACTIVE_PROJECT_TIES']);
    expect(result.reasons[2].projectTies).toEqual([{ projectId: 'project-1', projectName: 'Dự án A', status: 'ACTIVE' }]);
  });

  it('does not block exit for a completed project tied to a field report', async () => {
    mocks.findReports.mockResolvedValue([{ projectId: 'project-1' }]);
    mocks.findProjectStatuses.mockResolvedValue([]);

    await expect(evaluateAuditorFullExitEligibility('auditor-1')).resolves.toEqual({ eligible: true, reasons: [] });
  });
});
