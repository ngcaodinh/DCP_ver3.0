import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrCreateEvent: vi.fn(),
  markEventApplied: vi.fn(),
  scheduleEventRetry: vi.fn(),
  updateMongo: vi.fn(),
  findMetadataByTokenId: vi.fn(),
  invalidateGalleryTotal: vi.fn(),
  invalidateToken: vi.fn()
}));

vi.mock('../../models/sbtStatusProjectionModel', () => ({
  findOrCreateSbtStatusProjectionEvent: mocks.findOrCreateEvent,
  markSbtStatusProjectionEventApplied: mocks.markEventApplied,
  scheduleSbtStatusProjectionEventRetry: mocks.scheduleEventRetry
}));

vi.mock('../../models/impactSbtMetadataModel', () => ({
  findImpactSbtMetadataByTokenId: mocks.findMetadataByTokenId,
  updateImpactSbtOnChainStatus: mocks.updateMongo
}));

vi.mock('../../services/sbtMetadataCacheService', () => ({
  invalidateSbtGalleryTotalCache: mocks.invalidateGalleryTotal,
  invalidateSbtTokenCache: mocks.invalidateToken
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

import { projectSbtTokenStatusUpdate } from '../../services/sbtStatusProjectionService';

const statusEvent = {
  chainId: '490000',
  contractAddress: '0x0000000000000000000000000000000000000001',
  transactionHash: '0xstatus-event',
  logIndex: 4,
  blockNumber: 300,
  blockHash: '0xblock',
  tokenId: 12,
  newStatus: 'REVOKED' as const,
  reason: 'Evidence invalidated.'
};

describe('projectSbtTokenStatusUpdate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findOrCreateEvent.mockResolvedValue({ ...statusEvent, projectionStatus: 'PENDING' });
    mocks.updateMongo.mockResolvedValue({ projectId: 'project-1' });
    mocks.findMetadataByTokenId.mockResolvedValue(null);
    mocks.markEventApplied.mockResolvedValue(undefined);
    mocks.scheduleEventRetry.mockResolvedValue(undefined);
    mocks.invalidateGalleryTotal.mockResolvedValue(undefined);
    mocks.invalidateToken.mockResolvedValue(undefined);
  });

  it('projects a direct on-chain revoke, invalidates global/project totals, and marks the event applied', async () => {
    await expect(projectSbtTokenStatusUpdate(statusEvent)).resolves.toBe(true);

    expect(mocks.updateMongo).toHaveBeenCalledWith(12, expect.objectContaining({
      onChainTokenStatus: 'REVOKED',
      eventLocation: {
        blockNumber: 300,
        logIndex: 4,
        transactionHash: '0xstatus-event'
      }
    }));
    expect(mocks.invalidateGalleryTotal).toHaveBeenCalledWith('project-1');
    expect(mocks.invalidateToken).toHaveBeenCalledWith(12);
    expect(mocks.markEventApplied).toHaveBeenCalledWith(expect.objectContaining({
      chainId: '490000',
      transactionHash: '0xstatus-event',
      logIndex: 4
    }));
  });

  it('does not apply a previously projected event again during replay', async () => {
    mocks.findOrCreateEvent.mockResolvedValue({ ...statusEvent, projectionStatus: 'APPLIED' });

    await expect(projectSbtTokenStatusUpdate(statusEvent)).resolves.toBe(false);

    expect(mocks.updateMongo).not.toHaveBeenCalled();
    expect(mocks.invalidateGalleryTotal).not.toHaveBeenCalled();
    expect(mocks.invalidateToken).not.toHaveBeenCalled();
    expect(mocks.markEventApplied).not.toHaveBeenCalled();
  });

  it('applies visible statuses without invalidating gallery totals', async () => {
    const activeEvent = { ...statusEvent, newStatus: 'ACTIVE' as const };

    await expect(projectSbtTokenStatusUpdate(activeEvent)).resolves.toBe(true);

    expect(mocks.updateMongo).toHaveBeenCalledWith(12, expect.objectContaining({
      onChainTokenStatus: 'ACTIVE'
    }));
    expect(mocks.invalidateGalleryTotal).not.toHaveBeenCalled();
    expect(mocks.markEventApplied).toHaveBeenCalled();
  });

  it('schedules durable retry without blocking later log ingestion when confirmed metadata is not available yet', async () => {
    mocks.updateMongo.mockResolvedValue(null);

    await expect(projectSbtTokenStatusUpdate(statusEvent)).resolves.toBe(false);

    expect(mocks.findMetadataByTokenId).toHaveBeenCalledWith(12);
    expect(mocks.scheduleEventRetry).toHaveBeenCalledWith(expect.objectContaining({
      chainId: '490000',
      transactionHash: '0xstatus-event',
      logIndex: 4
    }));
    expect(mocks.markEventApplied).not.toHaveBeenCalled();
    expect(mocks.invalidateGalleryTotal).not.toHaveBeenCalled();
  });

  it('marks an event applied without rewriting a newer canonical status during concurrent replay', async () => {
    mocks.updateMongo.mockResolvedValue(null);
    mocks.findMetadataByTokenId.mockResolvedValue({
      status: 'CONFIRMED',
      tokenStatusBlockNumber: 301,
      tokenStatusLogIndex: 0
    });

    await expect(projectSbtTokenStatusUpdate(statusEvent)).resolves.toBe(false);

    expect(mocks.markEventApplied).toHaveBeenCalledWith(expect.objectContaining({
      chainId: '490000',
      transactionHash: '0xstatus-event',
      logIndex: 4
    }));
    expect(mocks.invalidateGalleryTotal).not.toHaveBeenCalled();
  });

  it('marks an equal-location replay as applied without rewriting canonical state', async () => {
    mocks.updateMongo.mockResolvedValue(null);
    mocks.findMetadataByTokenId.mockResolvedValue({
      status: 'CONFIRMED',
      tokenStatusBlockNumber: statusEvent.blockNumber,
      tokenStatusLogIndex: statusEvent.logIndex
    });

    await expect(projectSbtTokenStatusUpdate(statusEvent)).resolves.toBe(false);

    expect(mocks.scheduleEventRetry).not.toHaveBeenCalled();
    expect(mocks.markEventApplied).toHaveBeenCalled();
  });

  it('keeps retry pending when the current metadata lacks a canonical event location', async () => {
    mocks.updateMongo.mockResolvedValue(null);
    mocks.findMetadataByTokenId.mockResolvedValue({ status: 'CONFIRMED' });

    await expect(projectSbtTokenStatusUpdate(statusEvent)).resolves.toBe(false);

    expect(mocks.scheduleEventRetry).toHaveBeenCalled();
    expect(mocks.markEventApplied).not.toHaveBeenCalled();
  });
});
