import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Đọc mã nguồn invariant vì các ranh giới này là yêu cầu kiến trúc, không phải output runtime. */
function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), 'src', relativePath), 'utf8');
}

describe('F2 governance isolation invariants', () => {
  it('keeps GPS commissioners restricted to admin and regulatory', () => {
    const authModel = source('models/authModel.ts');
    const commissionerStart = authModel.indexOf('export async function findActiveCommissioners');
    const commissionerEnd = authModel.indexOf('export async function findActiveExecutiveCommittee');
    const commissionerBody = authModel.slice(commissionerStart, commissionerEnd);
    expect(commissionerBody).toContain("role: { $in: ['admin', 'regulatory'] }");
    expect(commissionerBody).not.toContain('executive_chair');
    expect(commissionerBody).not.toContain('executive_member');
  });

  it('permits only regulatory in every project review route', () => {
    const routes = source('routes/projectRoutes.ts');
    expect(routes).toContain("createRoleAuthorizationMiddleware(['regulatory'])");
    expect(routes).not.toContain("['admin', 'regulatory']");
  });

  it('does not connect field reports to disbursement or oracle workflows', () => {
    expect(source('services/disbursementService.ts')).not.toMatch(/auditorFieldReport|auditor_field_report/i);
    expect(source('services/oracleService.ts')).not.toMatch(/auditorFieldReport|auditor_field_report/i);
  });

  it('does not invoke blockchain activation from regulatory review', () => {
    const projectService = source('services/projectService.ts');
    const reviewBody = projectService.slice(projectService.indexOf('export async function reviewProjectByReviewer'));
    expect(reviewBody).not.toMatch(/activateProjectOnBlockchain\(/);
  });
});
