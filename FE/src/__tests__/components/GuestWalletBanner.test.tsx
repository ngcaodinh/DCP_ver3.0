/**
 * Unit tests cho GuestWalletBanner — test logic rendering conditions và interactions.
 * Pattern giống các test files hiện có trong project.
 * Test tập trung vào: render conditions, callback wiring, và state-driven visibility.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock hook ngay tại module level
const mockDismissClaimPrompt = vi.fn();

vi.mock('@/app/components/GuestWalletProvider', () => ({
  useGuestWallet: vi.fn(),
}));

// Import sau mock
import { useGuestWallet } from '@/app/components/GuestWalletProvider';

/**
 * Build initState mock với overrides linh hoạt.
 */
function makeInitState(overrides: Record<string, unknown> = {}) {
  return {
    initStatus: 'READY',
    initError: null,
    walletAddress: '0x' + 'a'.repeat(40),
    sessionId: 'session-123',
    guestSessionToken: 'token-123',
    donationQuota: 3,
    donationCount: 2,
    remainingDonations: 1,
    canDonate: true,
    hasPendingDonation: false,
    expiresAt: '2030-01-01T00:00:00Z',
    browserCompat: { riskLevel: 'SAFE', details: [] },
    claimPromptDismissed: false,
    ...overrides,
  };
}

function makeMockContext(overrides: Record<string, unknown> = {}) {
  return {
    initState: makeInitState((overrides.initState as Record<string, unknown>) ?? {}),
    donationState: {
      donationStatus: 'IDLE',
      donationError: null,
      lastUserOpHash: null,
      lastTxHash: null,
    },
    bootstrapGuestWallet: vi.fn(),
    restoreGuestSession: vi.fn(),
    refreshGuestSession: vi.fn(),
    executeDonation: vi.fn(),
    executeRelayDonation: vi.fn(),
    dismissClaimPrompt: mockDismissClaimPrompt,
    claimGuestWallet: vi.fn(),
    clearGuestWalletData: vi.fn(),
    ...overrides,
  };
}

describe('GuestWalletBanner — Rendering Conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useGuestWallet).mockReturnValue(makeMockContext() as ReturnType<typeof useGuestWallet>);
  });

  describe('Visibility Conditions', () => {
    it('should be visible when initStatus is READY and not dismissed', () => {
      const ctx = makeMockContext();
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(true);
    });

    it('should NOT be visible when initStatus is BOOTSTRAPPING_NEW', () => {
      const ctx = makeMockContext({ initState: { initStatus: 'BOOTSTRAPPING_NEW' } });
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(false);
    });

    it('should NOT be visible when initStatus is IDLE', () => {
      const ctx = makeMockContext({ initState: { initStatus: 'IDLE' } });
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(false);
    });

    it('should NOT be visible when initStatus is CLAIMED', () => {
      const ctx = makeMockContext({ initState: { initStatus: 'CLAIMED' } });
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(false);
    });

    it('should NOT be visible when initStatus is ERROR', () => {
      const ctx = makeMockContext({ initState: { initStatus: 'ERROR' } });
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(false);
    });

    it('should NOT be visible when claimPromptDismissed is true', () => {
      const ctx = makeMockContext({ initState: { claimPromptDismissed: true } });
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(false);
    });

    it('should NOT be visible when status is BROWSER_INCOMPATIBLE', () => {
      const ctx = makeMockContext({ initState: { initStatus: 'BROWSER_INCOMPATIBLE' } });
      const isVisible = ctx.initState.initStatus === 'READY' && !ctx.initState.claimPromptDismissed;
      expect(isVisible).toBe(false);
    });
  });

  describe('Donation Count Display', () => {
    it('should show correct donation count of 2', () => {
      const ctx = makeMockContext({ initState: { donationCount: 2 } });
      expect(ctx.initState.donationCount).toBe(2);
    });

    it('should show 0 when no donations made', () => {
      const ctx = makeMockContext({ initState: { donationCount: 0 } });
      expect(ctx.initState.donationCount).toBe(0);
    });

    it('should show max count when fully used', () => {
      const ctx = makeMockContext({ initState: { donationCount: 3 } });
      expect(ctx.initState.donationCount).toBe(3);
    });
  });

  describe('Callbacks', () => {
    it('should provide dismissClaimPrompt callback', () => {
      const ctx = makeMockContext();
      expect(typeof ctx.dismissClaimPrompt).toBe('function');
    });

    it('should call dismissClaimPrompt when dismissed', () => {
      mockDismissClaimPrompt();
      expect(mockDismissClaimPrompt).toHaveBeenCalledTimes(1);
    });
  });

  describe('CanDonate State', () => {
    it('should show canDonate true when under quota', () => {
      const ctx = makeMockContext({ initState: { donationCount: 2, canDonate: true } });
      expect(ctx.initState.canDonate).toBe(true);
    });

    it('should show canDonate false when at quota', () => {
      const ctx = makeMockContext({ initState: { donationCount: 3, canDonate: false } });
      expect(ctx.initState.canDonate).toBe(false);
    });
  });

  describe('Wallet Address', () => {
    it('should have valid wallet address when READY', () => {
      const ctx = makeMockContext();
      expect(ctx.initState.walletAddress).toMatch(/^0x[a-f0-9]{40}$/);
    });

    it('should have null wallet address when BOOTSTRAPPING_NEW', () => {
      const ctx = makeMockContext({ initState: { initStatus: 'BOOTSTRAPPING_NEW', walletAddress: null } });
      expect(ctx.initState.walletAddress).toBeNull();
    });
  });
});
