import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImpactSbtMetadataRecord } from '../../models/impactSbtMetadataModel';
import { toSbtTokenStatusName } from '../../constants/sbtTokenStatus';

const mocks = vi.hoisted(() => {
  const updateTokenStatus = Object.assign(vi.fn(), { estimateGas: vi.fn() });
  return {
    getReadOnly: vi.fn(),
    getWritable: vi.fn(),
    readContract: {
      getTokenMetadata: vi.fn(),
      getTokenStatus: vi.fn()
    },
    writeContract: { updateTokenStatus },
    findByProject: vi.fn(),
    countByProject: vi.fn(),
    findByToken: vi.fn(),
    updateMongo: vi.fn(),
    getCache: vi.fn(),
    getNotFoundCache: vi.fn(),
    setCache: vi.fn(),
    setNotFoundCache: vi.fn(),
    invalidateCache: vi.fn(),
    fetchIpfs: vi.fn(),
    buildGateway: vi.fn()
  };
});

vi.mock('../../config/sbtContract', () => ({
  getReadOnlyImpactSbtContract: mocks.getReadOnly,
  getWritableImpactSbtContract: mocks.getWritable
}));

vi.mock('../../models/impactSbtMetadataModel', () => ({
  findImpactSbtMetadataByProjectId: mocks.findByProject,
  countImpactSbtByProjectId: mocks.countByProject,
  findImpactSbtMetadataByTokenId: mocks.findByToken,
  updateImpactSbtOnChainStatus: mocks.updateMongo
}));

vi.mock('../../services/sbtMetadataCacheService', () => ({
  getSbtTokenCache: mocks.getCache,
  getSbtTokenNotFoundCache: mocks.getNotFoundCache,
  setSbtTokenCache: mocks.setCache,
  setSbtTokenNotFoundCache: mocks.setNotFoundCache,
  invalidateSbtTokenCache: mocks.invalidateCache
}));

vi.mock('../../utils/ipfsGateway', () => ({
  buildIpfsGatewayUrl: mocks.buildGateway,
  fetchJsonFromIpfs: mocks.fetchIpfs,
  IpfsGatewayError: class IpfsGatewayError extends Error {
    public readonly code: string;

    public constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
}));

import {
  getSbtListByProject,
  getSbtTokenDetail,
  updateSbtStatus
} from '../../services/sbt-metadata.service';

function makeRecord(overrides: Partial<ImpactSbtMetadataRecord> = {}): ImpactSbtMetadataRecord {
  return {
    sbtId: 'SBT-1',
    mintRequestId: 'MINT-1',
    verificationId: 'VER-1',
    projectId: 'project-1',
    organizationId: 'org-1',
    beneficiaryAddress: '0x0000000000000000000000000000000000000001',
    projectIdNumeric: 5,
    milestone: 2,
    beneficiaryCount: 150,
    gpsCoordinates: '10.8,106.6',
    imageCid: 'QmImage',
    tokenUri: 'ipfs://QmMetadata',
    status: 'CONFIRMED',
    attemptNumber: 1,
    lastErrorMessage: null,
    onChainTokenId: 1,
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

function setOnChainDefaults(): void {
  mocks.getReadOnly.mockReturnValue(mocks.readContract);
  mocks.getWritable.mockReturnValue(mocks.writeContract);
  mocks.buildGateway.mockImplementation((cid: string) => `https://ipfs.test/ipfs/${cid}`);
  mocks.readContract.getTokenMetadata.mockResolvedValue([
    5n,
    2n,
    150n,
    '10.8,106.6',
    'QmImage',
    1_754_041_200n
  ]);
  mocks.readContract.getTokenStatus.mockResolvedValue(0n);
  mocks.writeContract.updateTokenStatus.mockResolvedValue({
    hash: '0xstatus',
    wait: vi.fn().mockResolvedValue({ status: 1, blockNumber: 101 })
  });
  mocks.writeContract.updateTokenStatus.estimateGas.mockResolvedValue(50_000n);
  mocks.getCache.mockResolvedValue(null);
  mocks.getNotFoundCache.mockResolvedValue(false);
  mocks.setCache.mockResolvedValue(undefined);
  mocks.setNotFoundCache.mockResolvedValue(undefined);
  mocks.invalidateCache.mockResolvedValue(undefined);
  mocks.fetchIpfs.mockResolvedValue({ name: 'Impact SBT' });
  mocks.findByToken.mockResolvedValue(makeRecord());
  mocks.updateMongo.mockResolvedValue(makeRecord({ onChainTokenStatus: 'REVOKED' }));
}

describe('sbt-metadata.service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setOnChainDefaults();
    mocks.findByProject.mockResolvedValue([makeRecord()]);
    mocks.countByProject.mockResolvedValue(1);
  });

  it('clamps limit to 20 and returns list pagination', async () => {
    const result = await getSbtListByProject('project-1', 2, 50);

    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 1, totalPages: 1 });
    expect(mocks.findByProject).toHaveBeenCalledWith('project-1', 20, 20);
    expect(result.entries[0]).toMatchObject({ onChainTokenId: 1, imageGatewayUrl: 'https://ipfs.test/ipfs/QmImage' });
  });

  it('returns an empty collection when the project has no SBT', async () => {
    mocks.findByProject.mockResolvedValue([]);
    mocks.countByProject.mockResolvedValue(0);

    const result = await getSbtListByProject('missing-project');

    expect(result.entries).toEqual([]);
    expect(result.pagination.total).toBe(0);
    expect(result.pagination.totalPages).toBe(0);
  });

  it('degrades an invalid stored image CID without failing the whole gallery page', async () => {
    mocks.buildGateway.mockImplementation(() => {
      throw new Error('invalid CID');
    });

    const result = await getSbtListByProject('project-1');

    expect(result.entries[0].imageGatewayUrl).toBeNull();
  });

  it('returns cache hit without reading contract or IPFS', async () => {
    const cachedPayload = {
      onChainTokenId: 1,
      onChain: {
        projectId: 5,
        milestone: 2,
        beneficiaryCount: 150,
        gpsCoordinates: '10.8,106.6',
        imageCID: 'QmImage',
        mintedAt: '2026-08-01T10:00:00.000Z',
        tokenStatus: 'ACTIVE'
      },
      offChain: {
        sbtId: 'SBT-1',
        verificationId: 'VER-1',
        organizationId: 'org-1',
        beneficiaryAddress: '0xprivate',
        projectId: 'project-1',
        milestone: 2,
        beneficiaryCount: 150,
        imageCid: 'QmImage',
        tokenUri: 'ipfs://QmMetadata',
        confirmedAt: '2026-08-01T10:00:00.000Z'
      },
      imageGatewayUrl: 'https://attacker.example/poisoned',
      ipfsMetadata: { name: 'Impact SBT' },
      ipfsError: null,
      cached: false
    };
    mocks.getCache.mockResolvedValue(JSON.stringify(cachedPayload));

    const result = await getSbtTokenDetail(1);

    expect(result.cached).toBe(true);
    expect(result.offChain).toEqual({
      projectId: 'project-1',
      milestone: 2,
      beneficiaryCount: 150,
      imageCid: 'QmImage',
      tokenUri: 'ipfs://QmMetadata',
      confirmedAt: new Date('2026-08-01T10:00:00.000Z')
    });
    expect(result.offChain).not.toHaveProperty('beneficiaryAddress');
    expect(result.imageGatewayUrl).toBe('https://ipfs.test/ipfs/QmImage');
    expect(mocks.readContract.getTokenMetadata).not.toHaveBeenCalled();
    expect(mocks.fetchIpfs).not.toHaveBeenCalled();
  });

  it('rejects an unsafe tokenId before reading cache or blockchain', async () => {
    await expect(getSbtTokenDetail(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR'
    });
    expect(mocks.getCache).not.toHaveBeenCalled();
    expect(mocks.readContract.getTokenMetadata).not.toHaveBeenCalled();
  });

  it('ignores malformed cache and rebuilds detail from Mongo, chain and IPFS', async () => {
    mocks.getCache.mockResolvedValue(JSON.stringify({ onChainTokenId: 1, onChain: { tokenStatus: 'ACTIVE' } }));

    const result = await getSbtTokenDetail(1);

    expect(result.cached).toBe(false);
    expect(mocks.findByToken).toHaveBeenCalledWith(1);
    expect(mocks.readContract.getTokenMetadata).toHaveBeenCalledWith(1);
    expect(mocks.fetchIpfs).toHaveBeenCalledWith('ipfs://QmMetadata');
  });

  it('returns only public off-chain fields on a cache miss', async () => {
    const result = await getSbtTokenDetail(1);

    expect(result.offChain).toEqual({
      projectId: 'project-1',
      milestone: 2,
      beneficiaryCount: 150,
      imageCid: 'QmImage',
      tokenUri: 'ipfs://QmMetadata',
      confirmedAt: new Date('2026-08-01T10:00:00.000Z')
    });
    expect(result.offChain).not.toHaveProperty('mintRequestId');
    expect(result.offChain).not.toHaveProperty('verificationId');
    expect(result.offChain).not.toHaveProperty('organizationId');
    expect(result.offChain).not.toHaveProperty('beneficiaryAddress');
  });

  it('reads chain and IPFS on cache miss, then writes the detail cache', async () => {
    const result = await getSbtTokenDetail(1);

    expect(result.onChain.tokenStatus).toBe('ACTIVE');
    expect(result.ipfsMetadata).toEqual({ name: 'Impact SBT' });
    expect(mocks.readContract.getTokenMetadata).toHaveBeenCalledWith(1);
    expect(mocks.readContract.getTokenStatus).toHaveBeenCalledWith(1);
    expect(mocks.fetchIpfs).toHaveBeenCalledWith('ipfs://QmMetadata');
    expect(mocks.setCache).toHaveBeenCalledWith(1, expect.any(String));
  });

  it('maps TokenNotExists to a 404 application error', async () => {
    mocks.readContract.getTokenMetadata.mockRejectedValue({ name: 'TokenNotExists' });

    await expect(getSbtTokenDetail(999)).rejects.toMatchObject({
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      message: 'SBT không tồn tại.'
    });
    expect(mocks.setNotFoundCache).toHaveBeenCalledWith(999);

    mocks.getNotFoundCache.mockResolvedValue(true);
    await expect(getSbtTokenDetail(999)).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(mocks.readContract.getTokenMetadata).toHaveBeenCalledTimes(1);
  });

  it('degrades IPFS timeout and does not cache the response', async () => {
    const ipfsError = new (await import('../../utils/ipfsGateway')).IpfsGatewayError('timeout', 'IPFS_TIMEOUT');
    mocks.fetchIpfs.mockRejectedValue(ipfsError);

    const result = await getSbtTokenDetail(1);

    expect(result.ipfsMetadata).toBeNull();
    expect(result.ipfsError).toBe('IPFS_TIMEOUT');
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it('maps RPC network errors to BLOCKCHAIN_UNAVAILABLE instead of NOT_FOUND', async () => {
    mocks.readContract.getTokenStatus.mockRejectedValue({ code: 'NETWORK_ERROR' });

    await expect(getSbtTokenDetail(1)).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'BLOCKCHAIN_UNAVAILABLE'
    });
  });

  it('converts mintedAt bigint and rejects unsafe uint256 values', async () => {
    const result = await getSbtTokenDetail(1);
    expect(result.onChain.mintedAt).toEqual(new Date(1_754_041_200_000));

    mocks.getCache.mockResolvedValue(null);
    mocks.readContract.getTokenMetadata.mockResolvedValue([
      5n,
      2n,
      150n,
      'gps',
      'QmImage',
      9_007_199_254_740_992n
    ]);
    await expect(getSbtTokenDetail(1)).rejects.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
  });

  it('updates on-chain status with uint8 mapping and invalidates after Mongo update', async () => {
    const order: string[] = [];
    mocks.updateMongo.mockImplementation(async () => {
      order.push('mongo');
      return makeRecord({ onChainTokenStatus: 'REVOKED' });
    });
    mocks.invalidateCache.mockImplementation(async () => {
      order.push('cache');
    });

    const result = await updateSbtStatus(1, 'REVOKED', 'Evidence reused.', 'admin-1');

    expect(result).toMatchObject({ tokenId: 1, newStatus: 'REVOKED', isIrreversible: true });
    expect(mocks.writeContract.updateTokenStatus.estimateGas).toHaveBeenCalledWith(1, 2, 'Evidence reused.');
    expect(mocks.writeContract.updateTokenStatus).toHaveBeenCalledWith(
      1,
      2,
      'Evidence reused.',
      { gasLimit: 200_000n }
    );
    expect(order).toEqual(['mongo', 'cache']);
  });

  it('rejects terminal token without sending a transaction', async () => {
    mocks.readContract.getTokenStatus.mockResolvedValue(2n);

    await expect(updateSbtStatus(1, 'FROZEN', 'Need review.', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_STATUS_TRANSITION'
    });
    expect(mocks.writeContract.updateTokenStatus).not.toHaveBeenCalled();
  });

  it('rejects a no-op status transition without sending a transaction', async () => {
    await expect(updateSbtStatus(1, 'ACTIVE', 'No status change.', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_STATUS_TRANSITION'
    });
    expect(mocks.writeContract.updateTokenStatus).not.toHaveBeenCalled();
  });

  it('sanitizes phone-like PII before writing the permanent on-chain reason', async () => {
    await updateSbtStatus(1, 'FROZEN', 'Gian lận, SĐT 0901234567.', 'admin-1');

    expect(mocks.writeContract.updateTokenStatus).toHaveBeenCalledWith(
      1,
      1,
      expect.not.stringContaining('0901234567'),
      expect.any(Object)
    );
  });

  it('returns an audit warning when Mongo has no confirmed record after a successful transaction', async () => {
    mocks.updateMongo.mockResolvedValue(null);

    await expect(updateSbtStatus(1, 'FROZEN', 'Temporary freeze.', 'admin-1')).resolves.toMatchObject({
      auditWarning: 'OFF_CHAIN_RECORD_NOT_FOUND',
      transactionHash: '0xstatus'
    });
  });

  it('maps contract InvalidTransition to a stable conflict error', async () => {
    mocks.writeContract.updateTokenStatus.estimateGas.mockRejectedValue({ name: 'InvalidTransition' });

    await expect(updateSbtStatus(1, 'FROZEN', 'Need review.', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'INVALID_STATUS_TRANSITION'
    });
    expect(mocks.writeContract.updateTokenStatus).not.toHaveBeenCalled();
  });

  it('validates status reason again at the service boundary', async () => {
    await expect(updateSbtStatus(1, 'FROZEN', 'x'.repeat(201), 'admin-1')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR'
    });
    expect(mocks.readContract.getTokenStatus).not.toHaveBeenCalled();
  });

  it('rejects invalid status before any contract call', async () => {
    await expect(updateSbtStatus(1, 'INVALID', 'Need review.', 'admin-1')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR'
    });
    expect(mocks.readContract.getTokenStatus).not.toHaveBeenCalled();
    expect(mocks.writeContract.updateTokenStatus).not.toHaveBeenCalled();
  });

  it('still succeeds when cache invalidation fails after confirmed transaction', async () => {
    mocks.invalidateCache.mockRejectedValue(new Error('Redis unavailable'));

    await expect(updateSbtStatus(1, 'FROZEN', 'Temporary freeze.', 'admin-1')).resolves.toMatchObject({
      newStatus: 'FROZEN',
      transactionHash: '0xstatus'
    });
  });

  it('returns null for an unknown on-chain status value', () => {
    expect(toSbtTokenStatusName(9)).toBeNull();
  });
});
