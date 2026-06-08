import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectBrowserCompatibility } from '@/app/utils/browserCompat';

function setupMinimalNavigator() {
  vi.stubGlobal('navigator', {
    brave: undefined,
    storage: undefined,
  } as unknown as Navigator);
}

function setupNavigatorWithBrave(isBrave: boolean) {
  vi.stubGlobal('navigator', {
    brave: { isBrave: vi.fn().mockResolvedValue(isBrave) },
    storage: undefined,
  } as unknown as Navigator);
}

function setupNavigatorWithSafariPrivate(quota: number) {
  vi.stubGlobal('navigator', {
    brave: undefined,
    storage: { estimate: vi.fn().mockResolvedValue({ quota }) },
  } as unknown as Navigator);
}

function setupNavigatorWithBraveAndSafari(isBrave: boolean, quota: number) {
  vi.stubGlobal('navigator', {
    brave: { isBrave: vi.fn().mockResolvedValue(isBrave) },
    storage: { estimate: vi.fn().mockResolvedValue({ quota }) },
  } as unknown as Navigator);
}

function setupWorkingLocalStorage() {
  vi.stubGlobal('localStorage', {
    setItem: vi.fn(() => {}),
    getItem: vi.fn(() => '1'),
    removeItem: vi.fn(),
  });
}

function setupBlockedLocalStorage() {
  vi.stubGlobal('localStorage', {
    setItem: vi.fn(() => {}),
    getItem: vi.fn(() => null),
    removeItem: vi.fn(),
  });
}

function setupCryptoAvailable() {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn().mockReturnValue('test-uuid-000'),
    subtle: { digest: vi.fn() },
  });
}

function setupCryptoUnavailable() {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn().mockReturnValue('test-uuid-000'),
    subtle: null,
  });
}

function setupCryptoNoRandomUUID() {
  vi.stubGlobal('crypto', {
    randomUUID: undefined,
    subtle: { digest: vi.fn() },
  } as unknown as Crypto);
}

function setupCryptoUndefined() {
  vi.stubGlobal('crypto', undefined as unknown as Crypto);
}

describe('detectBrowserCompatibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should return SAFE when all checks pass', async () => {
    setupMinimalNavigator();
    setupWorkingLocalStorage();
    setupCryptoAvailable();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('SAFE');
    expect(result.details).toHaveLength(0);
  });

  it('should return CRITICAL when LocalStorage is unavailable', async () => {
    setupMinimalNavigator();
    setupBlockedLocalStorage();
    setupCryptoAvailable();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.details).toContain(
      'Trình duyệt không hỗ trợ LocalStorage. Dữ liệu ví sẽ không được lưu giữ.'
    );
  });

  it('should return WARNING when Brave Strict mode is detected', async () => {
    setupNavigatorWithBrave(true);
    setupWorkingLocalStorage();
    setupCryptoAvailable();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('WARNING');
    expect(result.details).toContain(
      'Brave Strict mode đang bật. Một số tính năng bảo mật có thể bị ảnh hưởng.'
    );
  });

  it('should return WARNING when only Safari Private Mode is detected', async () => {
    setupNavigatorWithSafariPrivate(500_000);
    setupWorkingLocalStorage();
    setupCryptoAvailable();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('WARNING');
    expect(result.details).toContain(
      'Phát hiện chế độ Private của Safari. Dữ liệu ví có thể không được lưu lâu dài.'
    );
  });

  it('should return CRITICAL when two issues are detected', async () => {
    setupNavigatorWithBraveAndSafari(true, 500_000);
    setupWorkingLocalStorage();
    setupCryptoAvailable();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.details).toContain(
      'Brave Strict mode đang bật. Một số tính năng bảo mật có thể bị ảnh hưởng.'
    );
    expect(result.details).toContain(
      'Phát hiện chế độ Private của Safari. Dữ liệu ví có thể không được lưu lâu dài.'
    );
  });

  it('should use randomized key for LocalStorage test', async () => {
    const mockSetItem = vi.fn(() => {});
    const mockRemoveItem = vi.fn();
    vi.stubGlobal('localStorage', {
      setItem: mockSetItem,
      getItem: vi.fn(() => '1'),
      removeItem: mockRemoveItem,
    });
    vi.stubGlobal('navigator', {
      brave: undefined,
      storage: undefined,
    } as unknown as Navigator);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('test-uuid-123'),
      subtle: { digest: vi.fn() },
    });

    await detectBrowserCompatibility();

    expect(mockSetItem).toHaveBeenCalledWith('__dcp_ls_test_test-uuid-123__', '1');
    expect(mockRemoveItem).toHaveBeenCalledWith('__dcp_ls_test_test-uuid-123__');
  });

  it('should return CRITICAL when Web Crypto is unavailable', async () => {
    setupMinimalNavigator();
    setupWorkingLocalStorage();
    setupCryptoUnavailable();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.details).toContain(
      'Trình duyệt không hỗ trợ Web Crypto API. Không thể mã hóa owner key.'
    );
  });

  it('should fall back to Date.now() when crypto.randomUUID is undefined', async () => {
    setupMinimalNavigator();
    setupWorkingLocalStorage();
    setupCryptoNoRandomUUID();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('SAFE');
  });

  it('should handle crypto global being undefined', async () => {
    vi.stubGlobal('navigator', {
      brave: undefined,
      storage: undefined,
    } as unknown as Navigator);
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(() => {}),
      getItem: vi.fn(() => '1'),
      removeItem: vi.fn(),
    });
    setupCryptoUndefined();

    const result = await detectBrowserCompatibility();

    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.details).toContain(
      'Trình duyệt không hỗ trợ Web Crypto API. Không thể mã hóa owner key.'
    );
  });
});
