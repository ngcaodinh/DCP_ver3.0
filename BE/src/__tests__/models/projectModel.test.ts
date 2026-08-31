import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  findAllProjectsByProjectIdList,
  findExecutivePendingPublicationProjects,
  findProjectNamesByProjectIdList,
  findProjectStatusesByProjectIdList,
  type ProjectStatus
} from '../../models/projectModel';

let mongoServer: MongoMemoryServer;

/** Tạo project fixture đầy đủ để kiểm chứng truy vấn tên không phụ thuộc lifecycle project. */
function buildProjectRecord(
  projectId: string,
  status: ProjectStatus,
  deadline: Date
): Record<string, unknown> {
  return {
    projectId,
    organizationId: `organization-${projectId}`,
    name: 'Dự án đã hoàn thành lâu',
    description: 'Project fixture cho gallery.',
    goalAmount: 1_000_000,
    deadline,
    status,
    evidenceCids: [],
    evidenceFiles: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z')
  };
}

describe('projectModel gallery name lookup', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    await mongoose.connection.collection('projects').deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('returns the name of a long-closed project without status or deadline filters', async () => {
    const oldDeadline = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    await mongoose.connection.collection('projects').insertOne(
      buildProjectRecord('project-closed-long-ago', 'COMPLETED', oldDeadline)
    );

    const result = await findProjectNamesByProjectIdList(['project-closed-long-ago']);

    expect(result).toEqual([
      { projectId: 'project-closed-long-ago', name: 'Dự án đã hoàn thành lâu' }
    ]);
  });

  it('keeps an active project with an old deadline visible to Auditor exit eligibility', async () => {
    const oldDeadline = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await mongoose.connection.collection('projects').insertOne(
      buildProjectRecord('project-active-long-ago', 'ACTIVE', oldDeadline)
    );

    await expect(findAllProjectsByProjectIdList(['project-active-long-ago'])).resolves.toEqual([]);
    await expect(findProjectStatusesByProjectIdList(['project-active-long-ago'], ['ACTIVE']))
      .resolves.toEqual([{ projectId: 'project-active-long-ago', name: 'Dự án đã hoàn thành lâu', status: 'ACTIVE' }]);
  });

  it('phân trang DISPUTED trước PENDING_ACTIVATION với cursor timestamp/id ổn định và projection card tối thiểu', async () => {
    const deadline = new Date('2026-12-31T00:00:00.000Z');
    const activationAt = new Date('2026-09-01T00:00:00.000Z');
    await mongoose.connection.collection('projects').insertMany([
      { ...buildProjectRecord('disputed-null', 'DISPUTED', deadline), activationEligibleAt: null, listingRound: 1, evidenceFiles: [{ cid: 'hidden', fileName: 'hidden.pdf', mimeType: 'application/pdf' }], milestonePlan: [{ milestoneIndex: 1, milestoneKey: 'M1_ADVANCE', percentage: 20, description: 'Không được trả trong card' }] },
      { ...buildProjectRecord('disputed-a', 'DISPUTED', deadline), activationEligibleAt: activationAt, listingRound: 1 },
      { ...buildProjectRecord('disputed-b', 'DISPUTED', deadline), activationEligibleAt: activationAt, listingRound: 1 },
      { ...buildProjectRecord('pending-a', 'PENDING_ACTIVATION', deadline), activationEligibleAt: activationAt, listingRound: 1 }
    ]);

    const firstPage = await findExecutivePendingPublicationProjects(null, 2);
    const secondPage = await findExecutivePendingPublicationProjects({
      status: 'DISPUTED',
      activationEligibleAt: firstPage[1].activationEligibleAt || null,
      projectId: firstPage[1].projectId
    }, 2);

    expect(firstPage.map(project => project.projectId)).toEqual(['disputed-null', 'disputed-a']);
    expect(secondPage.map(project => project.projectId)).toEqual(['disputed-b', 'pending-a']);
    expect([...firstPage, ...secondPage].map(project => project.status)).toEqual(['DISPUTED', 'DISPUTED', 'DISPUTED', 'PENDING_ACTIVATION']);
    expect(firstPage[0]).not.toHaveProperty('evidenceFiles');
    expect(firstPage[0]).not.toHaveProperty('milestonePlan');
    expect(firstPage[0]).not.toHaveProperty('description');
  });
});
