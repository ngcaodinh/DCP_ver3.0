import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findEarliestAnchor: vi.fn(),
  findAllCheckpoints: vi.fn(),
  rewindCheckpoint: vi.fn()
}));

vi.mock('../../models/impactSbtMetadataModel', () => ({
  findEarliestConfirmedImpactSbtBackfillAnchor: mocks.findEarliestAnchor
}));

vi.mock('../../models/sbtStatusProjectionModel', () => ({
  findAllSbtStatusProjectionCheckpoints: mocks.findAllCheckpoints,
  rewindSbtStatusProjectionCheckpoint: mocks.rewindCheckpoint
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

import { backfillSbtStatusProjectionCheckpoints } from '../../scripts/backfillSbtStatusProjectionCheckpoints';

const scope = {
  chainId: '490000',
  contractAddress: '0x0000000000000000000000000000000000000001'
};

describe('backfillSbtStatusProjectionCheckpoints', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findEarliestAnchor.mockResolvedValue({
      blockNumber: 100,
      confirmedAt: new Date('2026-08-02T10:00:00.000Z')
    });
    mocks.findAllCheckpoints.mockResolvedValue([
      {
        ...scope,
        lastProcessedBlock: 200,
        lastProcessedLogIndex: Number.MAX_SAFE_INTEGER,
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        updatedAt: new Date('2026-08-01T10:00:00.000Z')
      },
      {
        ...scope,
        lastProcessedBlock: 100,
        lastProcessedLogIndex: 4,
        createdAt: new Date('2026-08-03T10:00:00.000Z'),
        updatedAt: new Date('2026-08-03T10:00:00.000Z')
      },
      {
        ...scope,
        lastProcessedBlock: 150,
        lastProcessedLogIndex: Number.MAX_SAFE_INTEGER,
        createdAt: new Date('2026-08-03T10:00:00.000Z'),
        updatedAt: new Date('2026-08-03T10:00:00.000Z')
      },
      {
        ...scope,
        lastProcessedBlock: 99,
        lastProcessedLogIndex: Number.MAX_SAFE_INTEGER,
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        updatedAt: new Date('2026-08-01T10:00:00.000Z')
      },
      {
        ...scope,
        lastProcessedBlock: 200,
        lastProcessedLogIndex: Number.MAX_SAFE_INTEGER,
        createdAt: new Date('2026-08-02T10:00:00.000Z'),
        updatedAt: new Date('2026-08-02T10:00:00.000Z')
      }
    ]);
    mocks.rewindCheckpoint.mockResolvedValue(null);
  });

  it('reports affected checkpoints without writing in dry-run mode', async () => {
    await expect(backfillSbtStatusProjectionCheckpoints(true)).resolves.toMatchObject({
      dryRun: true,
      earliestConfirmedBlock: 100,
      inspected: 5,
      rewound: 1
    });

    expect(mocks.rewindCheckpoint).not.toHaveBeenCalled();
  });

  it('rewinds only a legacy sentinel created before the first confirmed mint', async () => {
    await expect(backfillSbtStatusProjectionCheckpoints(false)).resolves.toMatchObject({
      dryRun: false,
      rewound: 1
    });

    expect(mocks.rewindCheckpoint).toHaveBeenCalledTimes(1);
    expect(mocks.rewindCheckpoint).toHaveBeenCalledWith(expect.objectContaining(scope), 100, -1);
  });

  it('does not modify checkpoints when the confirmed mint has no usable backfill anchor', async () => {
    mocks.findEarliestAnchor.mockResolvedValue(null);

    await expect(backfillSbtStatusProjectionCheckpoints(false)).resolves.toMatchObject({
      earliestConfirmedBlock: null,
      inspected: 5,
      rewound: 0
    });

    expect(mocks.rewindCheckpoint).not.toHaveBeenCalled();
  });

  it('does not rewind a legacy-shaped checkpoint when its creation timestamp is unavailable', async () => {
    mocks.findAllCheckpoints.mockResolvedValue([{
      ...scope,
      lastProcessedBlock: 200,
      lastProcessedLogIndex: Number.MAX_SAFE_INTEGER,
      updatedAt: new Date('2026-08-01T10:00:00.000Z')
    }]);

    await expect(backfillSbtStatusProjectionCheckpoints(false)).resolves.toMatchObject({
      rewound: 0
    });

    expect(mocks.rewindCheckpoint).not.toHaveBeenCalled();
  });
});
