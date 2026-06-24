import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock mongoose model — dùng vi.hoisted để tránh hoisting issues ────────────

const { mockCreate, mockFind, mockFindOne } = vi.hoisted(() => {
  const mockExec = vi.fn();
  const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
  const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
  const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });

  const mockFindChain = vi.fn().mockReturnValue({ sort: mockSort });
  const mockFindOneChain = vi.fn().mockReturnValue({
    sort: vi.fn().mockReturnValue({ lean: mockLean }),
  });

  return {
    mockCreate: vi.fn(),
    mockFind: mockFindChain,
    mockFindOne: mockFindOneChain,
  };
});

vi.mock('mongoose', () => {
  const mockSchemaInstance = {
    index: vi.fn(),
  };
  const MockSchema = vi.fn().mockImplementation(() => mockSchemaInstance);
  // @ts-expect-error - Mocking mongoose module
  MockSchema.Types = {
    Mixed: vi.fn(),
  };

  return {
    Schema: MockSchema,
    model: vi.fn().mockReturnValue({
      create: mockCreate,
      find: mockFind,
      findOne: mockFindOne,
    }),
    default: {
      Schema: MockSchema,
      model: vi.fn().mockReturnValue({
        create: mockCreate,
        find: mockFind,
        findOne: mockFindOne,
      }),
    },
  };
});

import {
  createMultisigOverrideLog,
  findMultisigOverrideLogsByProjectId,
  findMultisigOverrideLogByRequestId,
} from '../../models/multisigOverrideLogModel';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildLogRecord(overrides: Record<string, unknown> = {}) {
  return {
    multisigOverrideLogId: 'log-001',
    overrideRequestId: 'req-001',
    projectId: 'proj-001',
    operator: 'admin-1',
    operatorRole: 'admin',
    action: 'OVERRIDE_VOTE_APPROVE',
    resolution: 'APPROVED',
    reason: 'Location verified manually',
    txHash: null,
    blockNumber: null,
    eventTimestamp: new Date('2024-01-15T10:00:00Z'),
    metadata: {},
    createdAt: new Date('2024-01-15T10:00:00Z'),
    ...overrides,
  };
}

// ─── Tests: createMultisigOverrideLog ─────────────────────────────────────────

describe('multisigOverrideLogModel - createMultisigOverrideLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tạo bản ghi với đúng các trường bắt buộc', async () => {
    const inputData = {
      multisigOverrideLogId: 'log-new-001',
      overrideRequestId: 'req-new-001',
      projectId: 'proj-new-001',
      operator: 'admin-1',
      operatorRole: 'admin',
      action: 'OVERRIDE_VOTE_APPROVE' as const,
      resolution: 'APPROVED' as const,
      reason: 'Manual verification passed',
      txHash: null,
      blockNumber: null,
      eventTimestamp: new Date(),
      metadata: { source: 'override_voting' },
    };

    const savedRecord = { ...inputData, createdAt: new Date() };
    mockCreate.mockResolvedValue(savedRecord);

    const result = await createMultisigOverrideLog(inputData);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(inputData);
    expect(result).toEqual(savedRecord);
  });

  it('tạo bản ghi với action=OVERRIDE_VOTE_REJECT và resolution=REJECTED', async () => {
    const inputData = {
      multisigOverrideLogId: 'log-reject-001',
      overrideRequestId: 'req-001',
      projectId: 'proj-001',
      operator: 'regulatory-1',
      operatorRole: 'regulatory',
      action: 'OVERRIDE_VOTE_REJECT' as const,
      resolution: 'REJECTED' as const,
      reason: 'Invalid evidence',
      txHash: null,
      blockNumber: null,
      eventTimestamp: new Date(),
      metadata: {},
    };

    const savedRecord = { ...inputData, createdAt: new Date() };
    mockCreate.mockResolvedValue(savedRecord);

    const result = await createMultisigOverrideLog(inputData);

    expect(mockCreate).toHaveBeenCalledWith(inputData);
    expect(result.action).toBe('OVERRIDE_VOTE_REJECT');
    expect(result.resolution).toBe('REJECTED');
  });

  it('tạo bản ghi với action=OVERRIDE_EXPIRED và resolution=EXPIRED', async () => {
    const inputData = {
      multisigOverrideLogId: 'log-expired-001',
      overrideRequestId: 'req-001',
      projectId: 'proj-001',
      operator: 'admin-1',
      operatorRole: 'admin',
      action: 'OVERRIDE_EXPIRED' as const,
      resolution: 'EXPIRED' as const,
      reason: 'Commissioner set changed',
      txHash: null,
      blockNumber: null,
      eventTimestamp: new Date(),
      metadata: {},
    };

    const savedRecord = { ...inputData, createdAt: new Date() };
    mockCreate.mockResolvedValue(savedRecord);

    const result = await createMultisigOverrideLog(inputData);

    expect(mockCreate).toHaveBeenCalledWith(inputData);
    expect(result.action).toBe('OVERRIDE_EXPIRED');
    expect(result.resolution).toBe('EXPIRED');
  });

  it('không thêm createdAt/updatedAt vì mongoose tự quản lý', async () => {
    const inputData = {
      multisigOverrideLogId: 'log-no-ts-001',
      overrideRequestId: 'req-001',
      projectId: 'proj-001',
      operator: 'admin-1',
      operatorRole: 'admin',
      action: 'OVERRIDE_VOTE_APPROVE' as const,
      resolution: 'APPROVED' as const,
      reason: 'Test',
      txHash: null,
      blockNumber: null,
      eventTimestamp: new Date(),
      metadata: {},
    };

    mockCreate.mockResolvedValue({ ...inputData, createdAt: new Date() });

    await createMultisigOverrideLog(inputData);

    expect(mockCreate).toHaveBeenCalledWith(inputData);
  });
});

// ─── Tests: findMultisigOverrideLogsByProjectId ────────────────────────────────

describe('multisigOverrideLogModel - findMultisigOverrideLogsByProjectId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về danh sách logs sắp xếp theo eventTimestamp giảm dần', async () => {
    const logs = [
      buildLogRecord({ multisigOverrideLogId: 'log-002', eventTimestamp: new Date('2024-01-16T10:00:00Z') }),
      buildLogRecord({ multisigOverrideLogId: 'log-001', eventTimestamp: new Date('2024-01-15T10:00:00Z') }),
      buildLogRecord({ multisigOverrideLogId: 'log-003', eventTimestamp: new Date('2024-01-14T10:00:00Z') }),
    ];

    // Thiết lập chain mock trả về logs
    const mockExec = vi.fn().mockResolvedValue(logs);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    const result = await findMultisigOverrideLogsByProjectId('proj-001');

    expect(mockFind).toHaveBeenCalledWith({ projectId: 'proj-001' });
    expect(mockSort).toHaveBeenCalledWith({ eventTimestamp: -1 });
    expect(mockSkip).toHaveBeenCalledWith(0); // default skip
    expect(mockLimit).toHaveBeenCalledWith(20); // default limit
    expect(result).toEqual(logs);
  });

  it('áp dụng limit và skip khi được truyền', async () => {
    const logs = [buildLogRecord({ multisigOverrideLogId: 'log-001' })];
    const mockExec = vi.fn().mockResolvedValue(logs);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogsByProjectId('proj-001', 10, 5);

    expect(mockSkip).toHaveBeenCalledWith(5);
    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('clamp limit về 100 khi limit > 100 (phòng DoS)', async () => {
    const logs = [buildLogRecord({ multisigOverrideLogId: 'log-001' })];
    const mockExec = vi.fn().mockResolvedValue(logs);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogsByProjectId('proj-001', 500, 0);

    expect(mockLimit).toHaveBeenCalledWith(100);
  });

  it('cho phép limit=100 mà không clamp (boundary)', async () => {
    const logs = [buildLogRecord({ multisigOverrideLogId: 'log-001' })];
    const mockExec = vi.fn().mockResolvedValue(logs);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogsByProjectId('proj-001', 100, 0);

    expect(mockLimit).toHaveBeenCalledWith(100);
  });

  it('sử dụng giá trị mặc định limit=20 và skip=0 khi không truyền', async () => {
    const mockExec = vi.fn().mockResolvedValue([]);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogsByProjectId('proj-001');

    expect(mockSkip).toHaveBeenCalledWith(0);
    expect(mockLimit).toHaveBeenCalledWith(20);
  });

  it('trả về mảng rỗng khi không có log nào cho projectId', async () => {
    const mockExec = vi.fn().mockResolvedValue([]);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    const result = await findMultisigOverrideLogsByProjectId('proj-no-logs');

    expect(result).toEqual([]);
  });

  it('sử dụng lean() để trả về plain object thay vì mongoose document', async () => {
    const logs = [buildLogRecord()];
    const mockExec = vi.fn().mockResolvedValue(logs);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
    const mockSkip = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockSort = vi.fn().mockReturnValue({ skip: mockSkip });
    mockFind.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogsByProjectId('proj-001');

    expect(mockLean).toHaveBeenCalled();
  });
});

// ─── Tests: findMultisigOverrideLogByRequestId ─────────────────────────────────

describe('multisigOverrideLogModel - findMultisigOverrideLogByRequestId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('trả về bản ghi khi tìm thấy theo overrideRequestId', async () => {
    const log = buildLogRecord({ multisigOverrideLogId: 'log-find-001' });

    const mockExec = vi.fn().mockResolvedValue(log);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockSort = vi.fn().mockReturnValue({ lean: mockLean });
    mockFindOne.mockReturnValue({ sort: mockSort });

    const result = await findMultisigOverrideLogByRequestId('req-001');

    expect(mockFindOne).toHaveBeenCalledWith({ overrideRequestId: 'req-001' });
    expect(mockSort).toHaveBeenCalledWith({ eventTimestamp: -1 });
    expect(result).toEqual(log);
  });

  it('trả về null khi không tìm thấy bản ghi nào', async () => {
    const mockExec = vi.fn().mockResolvedValue(null);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockSort = vi.fn().mockReturnValue({ lean: mockLean });
    mockFindOne.mockReturnValue({ sort: mockSort });

    const result = await findMultisigOverrideLogByRequestId('req-not-found');

    expect(mockFindOne).toHaveBeenCalledWith({ overrideRequestId: 'req-not-found' });
    expect(result).toBeNull();
  });

  it('sắp xếp theo eventTimestamp giảm dần (lấy bản ghi mới nhất)', async () => {
    const log = buildLogRecord({ multisigOverrideLogId: 'log-latest-001' });

    const mockExec = vi.fn().mockResolvedValue(log);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockSort = vi.fn().mockReturnValue({ lean: mockLean });
    mockFindOne.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogByRequestId('req-001');

    expect(mockSort).toHaveBeenCalledWith({ eventTimestamp: -1 });
  });

  it('sử dụng lean() để trả về plain object', async () => {
    const log = buildLogRecord();

    const mockExec = vi.fn().mockResolvedValue(log);
    const mockLean = vi.fn().mockReturnValue({ exec: mockExec });
    const mockSort = vi.fn().mockReturnValue({ lean: mockLean });
    mockFindOne.mockReturnValue({ sort: mockSort });

    await findMultisigOverrideLogByRequestId('req-001');

    expect(mockLean).toHaveBeenCalled();
  });
});
