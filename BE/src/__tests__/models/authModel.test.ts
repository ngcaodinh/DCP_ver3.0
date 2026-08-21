/**
 * Unit tests cho authModel.ts — kiểm tra các query helpers liên quan đến commissioner.
 * Dùng minimal mongoose mock để không cần MongoDB thật.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mongoose mock ────────────────────────────────────────────────────────────
// Định nghĩa mock functions trước khi import module (vi.hoisted được hoist lên đầu file)
const { mockFind, mockLean, mockExec, mockCountDocuments, mockCountExec } = vi.hoisted(() => {
  const mockExec = vi.fn();
  const mockLean = vi.fn(() => ({ exec: mockExec }));
  const mockFind = vi.fn(() => ({ lean: mockLean }));
  const mockCountDocuments = vi.fn();
  const mockCountExec = vi.fn();
  mockCountDocuments.mockReturnValue({ exec: mockCountExec });
  return { mockFind, mockLean, mockExec, mockCountDocuments, mockCountExec };
});

vi.mock('mongoose', () => {
  // Mongoose Schema tối giản — chỉ cần constructor + index() để authModel.ts load được
  class MockSchema {
    constructor(_def?: unknown, _options?: unknown) {}
    index(_fields: unknown, _options?: unknown) { return this; }
    pre(_event: unknown, _fn?: unknown) { return this; }
    post(_event: unknown, _fn?: unknown) { return this; }
  }

  return {
    default: {
      Schema: MockSchema,
      // mongoose.model() → trả fake model với find() đã được spy
      model: vi.fn(() => ({
        find: mockFind,
        findOne: vi.fn(),
        create: vi.fn(),
        countDocuments: mockCountDocuments,
        findOneAndUpdate: vi.fn()
      }))
    },
    Schema: MockSchema
  };
});

// Import sau khi mock đã được thiết lập
import { countActiveAuditors, findActiveAuditors, findActiveCommissioners, findActiveExecutiveCommittee } from '../../models/authModel';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('findActiveCommissioners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mặc định: find chain trả về mảng rỗng
    mockExec.mockResolvedValue([]);
    mockLean.mockReturnValue({ exec: mockExec });
    mockFind.mockReturnValue({ lean: mockLean });
  });

  it('[T5] query bao gồm isSybil: false để loại bỏ Sybil user', async () => {
    await findActiveCommissioners();

    expect(mockFind).toHaveBeenCalledOnce();
    const queryArg = (mockFind.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(queryArg).toMatchObject({ isSybil: false });
  });

  it('[T5] query bao gồm accountStatus: ACTIVE để loại bỏ user chưa active', async () => {
    await findActiveCommissioners();

    const queryArg = (mockFind.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(queryArg).toMatchObject({ accountStatus: 'ACTIVE' });
  });

  it('[T5] query chỉ lấy role admin và regulatory', async () => {
    await findActiveCommissioners();

    const queryArg = (mockFind.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(queryArg).toMatchObject({
      role: { $in: expect.arrayContaining(['admin', 'regulatory']) }
    });
    // Không lấy role donor hoặc organization
    const rolesInQuery = (queryArg['role'] as { $in: string[] })['$in'];
    expect(rolesInQuery).not.toContain('donor');
    expect(rolesInQuery).not.toContain('organization');
  });

  it('[T5] trả về danh sách commissioner từ DB', async () => {
    const mockCommissioners = [
      { id: 'admin-1', role: 'admin', accountStatus: 'ACTIVE', isSybil: false },
      { id: 'regulatory-1', role: 'regulatory', accountStatus: 'ACTIVE', isSybil: false }
    ];
    mockExec.mockResolvedValue(mockCommissioners);

    const result = await findActiveCommissioners();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'admin-1', role: 'admin' });
    expect(result[1]).toMatchObject({ id: 'regulatory-1', role: 'regulatory' });
  });

  it('[T5] dùng .lean() để trả plain object (không phải Mongoose Document)', async () => {
    await findActiveCommissioners();

    expect(mockLean).toHaveBeenCalledOnce();
  });
});

describe('F2 governance role directories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue([]);
    mockLean.mockReturnValue({ exec: mockExec });
    mockFind.mockReturnValue({ lean: mockLean });
    mockCountExec.mockResolvedValue(0);
  });

  it('keeps the executive committee separate from legacy commissioners', async () => {
    await findActiveExecutiveCommittee();
    expect(mockFind).toHaveBeenCalledWith(expect.objectContaining({
      role: { $in: ['executive_chair', 'executive_member'] }, accountStatus: 'ACTIVE', isSybil: false
    }));
  });

  it('finds and counts only active non-Sybil auditors', async () => {
    mockCountExec.mockResolvedValue(3);
    await expect(findActiveAuditors()).resolves.toEqual([]);
    await expect(countActiveAuditors()).resolves.toBe(3);
    expect(mockFind).toHaveBeenCalledWith({ role: 'auditor', accountStatus: 'ACTIVE', isSybil: false });
    expect(mockCountDocuments).toHaveBeenCalledWith({ role: 'auditor', accountStatus: 'ACTIVE', isSybil: false });
  });
});
