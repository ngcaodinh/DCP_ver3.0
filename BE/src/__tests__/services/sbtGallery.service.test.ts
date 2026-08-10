import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImpactSbtMetadataRecord } from '../../models/impactSbtMetadataModel';

const mocks = vi.hoisted(() => ({
  findGallery: vi.fn(),
  countGallery: vi.fn(),
  findProjectNames: vi.fn(),
  buildGateway: vi.fn(),
  getOrLoadGalleryTotal: vi.fn()
}));

vi.mock('../../models/impactSbtMetadataModel', () => ({
  countImpactSbtGallery: mocks.countGallery,
  findImpactSbtGallery: mocks.findGallery,
  findImpactSbtMetadataByTokenId: vi.fn(),
  updateImpactSbtOnChainStatus: vi.fn()
}));

vi.mock('../../models/projectModel', () => ({
  findProjectNamesByProjectIdList: mocks.findProjectNames
}));

vi.mock('../../config/sbtContract', () => ({
  getReadOnlyImpactSbtContract: vi.fn(),
  getWritableImpactSbtContract: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

vi.mock('../../utils/ipfsGateway', () => ({
  buildIpfsGatewayUrl: mocks.buildGateway,
  fetchJsonFromIpfs: vi.fn(),
  IpfsGatewayError: class IpfsGatewayError extends Error {
    public readonly code = 'INVALID_CID';
  }
}));

vi.mock('../../services/sbtMetadataCacheService', () => ({
  getOrLoadSbtGalleryTotal: mocks.getOrLoadGalleryTotal,
  getSbtTokenCache: vi.fn(),
  getSbtTokenNotFoundCache: vi.fn(),
  setSbtTokenCache: vi.fn(),
  setSbtTokenNotFoundCache: vi.fn(),
  invalidateSbtTokenCache: vi.fn(),
  invalidateSbtGalleryTotalCache: vi.fn()
}));

import { getSbtGallery } from '../../services/sbt-metadata.service';

function makeRecord(overrides: Partial<ImpactSbtMetadataRecord> = {}): ImpactSbtMetadataRecord {
  return {
    sbtId: 'SBT-1',
    mintRequestId: 'MINT-1',
    verificationId: 'VER-1',
    projectId: 'project-1',
    organizationId: 'org-1',
    beneficiaryAddress: '0x0000000000000000000000000000000000000001',
    projectIdNumeric: 1,
    milestone: 2,
    beneficiaryCount: 150,
    gpsCoordinates: '',
    imageCid: 'QmImage',
    tokenUri: 'ipfs://QmMetadata',
    status: 'CONFIRMED',
    attemptNumber: 1,
    lastErrorMessage: null,
    onChainTokenId: 12,
    transactionHash: '0xtx',
    blockNumber: 100,
    confirmedAt: new Date('2026-08-01T10:00:00.000Z'),
    submittedAt: null,
    dlqAt: null,
    reRunCount: 0,
    lastReRunBy: null,
    lastReRunAt: null,
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    updatedAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides
  };
}

describe('getSbtGallery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.buildGateway.mockImplementation((cid: string) => `https://ipfs.test/ipfs/${cid}`);
    mocks.findGallery.mockResolvedValue([
      makeRecord({ projectId: 'project-1', onChainTokenId: 12 }),
      makeRecord({
        sbtId: 'SBT-2',
        projectId: 'project-2',
        onChainTokenId: 13,
        confirmedAt: new Date('2026-08-02T10:00:00.000Z')
      })
    ]);
    mocks.countGallery.mockResolvedValue(2);
    mocks.getOrLoadGalleryTotal.mockImplementation(async (_projectId: string | undefined, loadTotal: () => Promise<number>) => loadTotal());
    mocks.findProjectNames.mockResolvedValue([
      { projectId: 'project-1', name: 'Dự án đã hoàn thành' },
      { projectId: 'project-2', name: 'Dự án đang triển khai' }
    ]);
  });

  it('lấy gallery toàn cục, giữ thứ tự DB và gắn tên nhiều project bằng một batch lookup', async () => {
    const result = await getSbtGallery();

    expect(mocks.findGallery).toHaveBeenCalledWith(20, 0, undefined);
    expect(mocks.countGallery).toHaveBeenCalledWith(undefined);
    expect(mocks.getOrLoadGalleryTotal).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(mocks.findProjectNames).toHaveBeenCalledTimes(1);
    expect(mocks.findProjectNames).toHaveBeenCalledWith(['project-1', 'project-2']);
    expect(result.entries.map(entry => entry.projectName)).toEqual([
      'Dự án đã hoàn thành',
      'Dự án đang triển khai'
    ]);
  });

  it('truyền projectId vào cả find và count, đồng thời clamp limit về 20', async () => {
    const result = await getSbtGallery(2, 50, 'project-2');

    expect(mocks.findGallery).toHaveBeenCalledWith(20, 20, 'project-2');
    expect(mocks.countGallery).toHaveBeenCalledWith('project-2');
    expect(mocks.getOrLoadGalleryTotal).toHaveBeenCalledWith('project-2', expect.any(Function));
    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 2, totalPages: 1 });
  });

  it('dùng total từ cache và bỏ qua countDocuments khi cache còn hiệu lực', async () => {
    mocks.getOrLoadGalleryTotal.mockResolvedValue(2);

    const result = await getSbtGallery(1, 20, 'project-2');

    expect(mocks.findGallery).toHaveBeenCalledWith(20, 0, 'project-2');
    expect(mocks.countGallery).not.toHaveBeenCalled();
    expect(mocks.getOrLoadGalleryTotal).toHaveBeenCalledWith('project-2', expect.any(Function));
    expect(result.pagination.total).toBe(2);
  });

  it('không làm fail gallery khi cache total trả fallback từ lần đọc trước', async () => {
    mocks.getOrLoadGalleryTotal.mockResolvedValue(2);

    const result = await getSbtGallery();

    expect(result.pagination.total).toBe(2);
    expect(mocks.countGallery).not.toHaveBeenCalled();
  });

  it('trim projectId trước khi tạo filter DB', async () => {
    await getSbtGallery(1, 20, '  project-2  ');

    expect(mocks.findGallery).toHaveBeenCalledWith(20, 0, 'project-2');
    expect(mocks.countGallery).toHaveBeenCalledWith('project-2');
  });

  it('giữ token FROZEN và fallback projectName về null khi project đã bị xóa', async () => {
    mocks.findGallery.mockResolvedValue([
      makeRecord({ onChainTokenStatus: 'FROZEN', projectId: 'deleted-project' })
    ]);
    mocks.countGallery.mockResolvedValue(1);
    mocks.findProjectNames.mockResolvedValue([]);

    const result = await getSbtGallery(1, 20);

    expect(result.entries[0]).toMatchObject({
      onChainTokenStatus: 'FROZEN',
      projectName: null
    });
  });

  it('không lookup project khi trang gallery rỗng', async () => {
    mocks.findGallery.mockResolvedValue([]);
    mocks.countGallery.mockResolvedValue(0);

    const result = await getSbtGallery();

    expect(result.entries).toEqual([]);
    expect(mocks.findProjectNames).not.toHaveBeenCalled();
  });
});
