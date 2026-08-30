import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reconcileBootstrap: vi.fn(),
  reconcileRoster: vi.fn(),
  warn: vi.fn()
}));

vi.mock('../../services/governanceSeatService', () => ({
  reconcileGovernanceBootstrapFromChain: mocks.reconcileBootstrap,
  reconcileGovernanceRosterFromChain: mocks.reconcileRoster
}));
vi.mock('../../config/logger', () => ({ getLogger: () => ({ warn: mocks.warn }) }));

import { reconcileGovernanceAtStartup } from '../../services/governanceSeatStartup.service';

describe('governanceSeatStartup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    mocks.reconcileBootstrap.mockResolvedValue(null);
    mocks.reconcileRoster.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('đồng bộ bootstrap trước roster khi blockchain sẵn sàng', async () => {
    await expect(reconcileGovernanceAtStartup()).resolves.toBeUndefined();

    expect(mocks.reconcileBootstrap).toHaveBeenCalledOnce();
    expect(mocks.reconcileRoster).toHaveBeenCalledOnce();
    expect(mocks.reconcileBootstrap.mock.invocationCallOrder[0]).toBeLessThan(mocks.reconcileRoster.mock.invocationCallOrder[0]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('vẫn cho API local khởi động khi RPC lỗi và ghi cảnh báo vận hành', async () => {
    mocks.reconcileBootstrap.mockRejectedValue(new Error('RPC unavailable'));

    await expect(reconcileGovernanceAtStartup()).resolves.toBeUndefined();

    expect(mocks.reconcileRoster).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('khởi động local'),
      { errorMessage: 'RPC unavailable' }
    );
  });

  it('vẫn fail-closed ở production khi reconcile blockchain thất bại', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = new Error('RPC unavailable');
    mocks.reconcileRoster.mockRejectedValue(error);

    await expect(reconcileGovernanceAtStartup()).rejects.toBe(error);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
