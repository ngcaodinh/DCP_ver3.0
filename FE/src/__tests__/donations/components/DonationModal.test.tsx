/**
 * Integration tests cho DonationModal component.
 * Test routing: authenticated user vs guest (no-wallet, ready).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('@/app/components/GuestWalletProvider', () => ({
  useGuestWallet: vi.fn(),
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: vi.fn(),
}));

vi.mock('@/app/donations/components/DonationModal.services', () => ({
  executeOneClickDonationRequest: vi.fn(() => Promise.resolve('0xtxhash123')),
  recordDonationByTransactionHash: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/app/utils/apiClient', () => ({
  fetchApi: vi.fn(() => Promise.resolve({ data: [] })),
  buildApiUrl: vi.fn((path: string) => `http://localhost:3000${path}`),
}));

import { useGuestWallet } from '@/app/components/GuestWalletProvider';
import { readAuthSession } from '@/app/utils/authSession';
import type { DonationCampaignItem } from '@/app/donations/components/DonationModal.types';
import DonationModal from '@/app/donations/components/DonationModal';

/** Full normalization: NFC → NFD → strip marks → replace diacritics → lowercase */
function normalizeText(text: string): string {
  let r = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const M: Record<string, string> = {
    'ă':'a','ắ':'a','ằ':'a','ẳ':'a','ẵ':'a',
    'â':'a','ấ':'a','ầ':'a','ẩ':'a','ẫ':'a',
    'á':'a','à':'a','ả':'a','ã':'a','ạ':'a',
    'đ':'d',
    'ê':'e','ế':'e','ề':'e','ể':'e','ễ':'e','ệ':'e',
    'é':'e','è':'e','ẻ':'e','ẽ':'e','ẹ':'e',
    'î':'i','í':'i','ì':'i','ỉ':'i','ĩ':'i','ị':'i',
    'ô':'o','ố':'o','ồ':'o','ổ':'o','ỗ':'o','ộ':'o',
    'ơ':'o','ớ':'o','ờ':'o','ở':'o','ỡ':'o','ợ':'o',
    'ó':'o','ò':'o','ỏ':'o','õ':'o','ọ':'o',
    'ư':'u','ứ':'u','ừ':'u','ử':'u','ữ':'u','ự':'u',
    'ú':'u','ù':'u','ủ':'u','ũ':'u','ụ':'u',
    'ỳ':'y','ý':'y','ỵ':'y','ỷ':'y','ỹ':'y',
  };
  for (const [k, v] of Object.entries(M)) r = r.split(k).join(v);
  return r.toLowerCase();
}

/** Assert text exists in DOM using ASCII-stripped substring match */
function assertText(pattern: string | RegExp): void {
  const bodyText = document.body.textContent ?? '';
  const normBody = normalizeText(bodyText);
  if (typeof pattern === 'string') {
    expect(normBody).toContain(normalizeText(pattern));
  } else {
    // Decompose regex source to NFD first (matches Write tool output), then normalize
    const normPattern = normalizeText(pattern.source.normalize('NFD'));
    expect(normBody).toContain(normPattern);
  }
}

/** Find button by diacritic-stripped substring match */
function findButton(text: string | RegExp): HTMLButtonElement | null {
  const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
  return buttons.find((b) => {
    const bt = normalizeText(b.textContent ?? '');
    if (typeof text === 'string') return bt.includes(normalizeText(text));
    // Decompose regex source to NFD first (matches Write tool output), then normalize
    const normSrc = normalizeText(text.source.normalize('NFD'));
    return bt.includes(normSrc);
  }) ?? null;
}

const mockCampaign: DonationCampaignItem = {
  projectId: '1001',
  name: 'Test Campaign',
  status: 'ACTIVE',
  deadline: new Date(Date.now() + 86400000).toISOString(),
  minDonation: 1,
  maxDonation: 600000,
};

const defaultOnClose = vi.fn();
const defaultOnSuccess = vi.fn((): Promise<void> => Promise.resolve());

function makeInitState(overrides = {}) {
  return {
    initStatus: 'READY' as const,
    initError: null as string | null,
    walletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0E8eD',
    sessionId: 'sess123',
    guestSessionToken: 'token123',
    donationQuota: 3,
    donationCount: 0,
    remainingDonations: 3,
    canDonate: true,
    hasPendingDonation: false,
    expiresAt: '2030-01-01T00:00:00Z',
    browserCompat: { riskLevel: 'SAFE' as const, details: [] as string[] },
    claimPromptDismissed: false,
    ...overrides,
  };
}

function makeDonationState(overrides = {}) {
  return {
    donationStatus: 'IDLE' as const,
    donationError: null as string | null,
    lastUserOpHash: null as string | null,
    lastTxHash: null as string | null,
    ...overrides,
  };
}

function mockGuestWallet(initOverrides = {}, donationOverrides = {}) {
  vi.mocked(useGuestWallet).mockReturnValue({
    initState: makeInitState(initOverrides),
    donationState: makeDonationState(donationOverrides),
    executeDonation: vi.fn().mockResolvedValue(true),
    executeRelayDonation: vi.fn().mockResolvedValue(true),
    bootstrapGuestWallet: vi.fn(),
    restoreGuestSession: vi.fn(),
    refreshGuestSession: vi.fn(),
    dismissClaimPrompt: vi.fn(),
    claimGuestWallet: vi.fn(),
    clearGuestWalletData: vi.fn(),
  });
}

describe('DonationModal -- Routing Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthSession).mockReturnValue({ accessToken: undefined });
  });

  describe('Guest no-wallet path', () => {
    it('renders no-wallet view when not authenticated (IDLE)', () => {
      mockGuestWallet({ initStatus: 'IDLE' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Quyên góp cho dự án');
      // Bootstrap button visible and NOT disabled in IDLE state
      const btn = findButton('Bắt đầu quyên góp ngay');
      expect(btn).not.toBeNull();
      expect(btn).not.toBeDisabled();
    });

    it('disables bootstrap button when BOOTSTRAPPING_NEW', () => {
      mockGuestWallet({ initStatus: 'BOOTSTRAPPING_NEW' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      // In BOOTSTRAPPING_NEW state, the component renders "Đang khởi tạo..." button
      const btn = findButton('Đang khởi tạo');
      expect(btn).not.toBeNull();
      expect(btn).toBeDisabled();
    });

    it('disables bootstrap button when ERROR', () => {
      mockGuestWallet({ initStatus: 'ERROR', initError: 'Lỗi kết nối server' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Lỗi kết nối server');
      // In ERROR state, button shows "Bắt đầu quyên góp ngay" (text unchanged but button is disabled)
      const btn = findButton(/Bat dau quyen gop/i);
      expect(btn).not.toBeNull();
      expect(btn).toBeDisabled();
    });

    it('disables bootstrap button when BROWSER_INCOMPATIBLE', () => {
      mockGuestWallet({ initStatus: 'BROWSER_INCOMPATIBLE' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Trình duyệt không hỗ trợ');
      // In BROWSER_INCOMPATIBLE state, button shows "Bắt đầu quyên góp ngay" (disabled)
      const btn = findButton(/Bat dau quyen gop/i);
      expect(btn).not.toBeNull();
      expect(btn).toBeDisabled();
    });
  });

  describe('Guest ready path', () => {
    it('renders guest ready view with wallet info bar', () => {
      mockGuestWallet({ initStatus: 'READY', donationCount: 1, remainingDonations: 2 });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Quyên góp cho dự án');
      assertText('0x742d...E8eD');
      assertText('Còn lại');
      assertText('2/3');
    });

    it('shows quota exceeded message when remainingDonations=0', () => {
      mockGuestWallet({ initStatus: 'READY', donationCount: 3, remainingDonations: 0 });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Bạn đã đạt giới hạn 3 lần quyên góp');
    });

    it('shows pending donation alert when hasPendingDonation=true', () => {
      mockGuestWallet({ initStatus: 'READY', hasPendingDonation: true });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('giao dịch đang chờ xử lý');
    });

    it('disables submit button during donation (DECRYPTING_KEY state)', () => {
      mockGuestWallet({ initStatus: 'READY' }, { donationStatus: 'DECRYPTING_KEY' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      // In DECRYPTING_KEY state, the component shows processing indicator, not donation form
      // Donation form button should NOT be present
      expect(findButton('Quyen gop')).toBeNull();
    });

    it('enables submit button when donationStatus is IDLE', () => {
      mockGuestWallet({ initStatus: 'READY' }, { donationStatus: 'IDLE' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      const btn = findButton('Quyên góp ngay');
      expect(btn).not.toBeNull();
      expect(btn).not.toBeDisabled();
    });

    it('shows success notice and hides donation form when donationStatus is SUCCESS', () => {
      mockGuestWallet({ initStatus: 'READY' }, { donationStatus: 'SUCCESS' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      // In SUCCESS state, the component shows success notice, not donation form
      assertText('thành công');
      // Donation form button should NOT be present
      expect(findButton('Quyên góp')).toBeNull();
    });

    it('enables submit button when donationStatus is FAILED', () => {
      mockGuestWallet({ initStatus: 'READY' }, { donationStatus: 'FAILED' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      const btn = findButton('Quyên góp ngay');
      expect(btn).not.toBeNull();
      expect(btn).not.toBeDisabled();
    });
  });

  describe('Guest double-submit protection', () => {
    it('does not open confirm modal when already submitting (isSubmitting=true)', async () => {
      // Simulate: user already clicked "Xác nhận" and is waiting for blockchain response.
      // While waiting, isSubmitting is true. Clicking "Quyên góp ngay" again must NOT open confirm modal.
      mockGuestWallet({ initStatus: 'READY', remainingDonations: 3 }, { donationStatus: 'SUBMITTING_BUNDLER' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      // Submitting state — button text is guestDisplayStatusValue ('Đang gửi lên blockchain...')
      // No donation button visible
      expect(findButton('Quyen gop')).toBeNull();
    });
  });

  describe('Authenticated path', () => {
    it('renders authenticated view and prefers it over guest', () => {
      vi.mocked(readAuthSession).mockReturnValue({ accessToken: 'mock-token' });
      mockGuestWallet({ initStatus: 'READY' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Quyên góp cho dự án');
      // Guest info bar should NOT appear for authenticated users
      const guestInfo = document.body.textContent ?? '';
      expect(normalizeText(guestInfo)).not.toContain('con lai');
      // Authenticated-specific text
      assertText('Quyên góp');
    });
  });

  describe('Guest donation states', () => {
    it('shows success notice when donationStatus is SUCCESS', () => {
      mockGuestWallet({ initStatus: 'READY' }, { donationStatus: 'SUCCESS', lastTxHash: '0xtxhash123' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Quyên góp thành công');
    });

    it('shows error message when donationStatus is FAILED', () => {
      mockGuestWallet({ initStatus: 'READY' }, { donationStatus: 'FAILED', donationError: 'Bundler timeout' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Bundler timeout');
    });

    it('shows UserOp hash when tx not available after success', () => {
      mockGuestWallet(
        { initStatus: 'READY' },
        { donationStatus: 'SUCCESS', lastUserOpHash: '0xuserop123', lastTxHash: null },
      );
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('UserOp');
    });
  });

  describe('Close button', () => {
    it('calls onClose when close button clicked in guest ready view', async () => {
      mockGuestWallet({ initStatus: 'READY' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      const btn = findButton('Hủy');
      expect(btn).not.toBeNull();
      await act(async () => { fireEvent.click(btn!); });
      expect(defaultOnClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when close button clicked in no-wallet view', async () => {
      mockGuestWallet({ initStatus: 'IDLE' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      const btn = findButton('Đóng');
      expect(btn).not.toBeNull();
      await act(async () => { fireEvent.click(btn!); });
      expect(defaultOnClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when backdrop clicked in guest ready view', async () => {
      mockGuestWallet({ initStatus: 'READY' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      // Backdrop là div ngoài cùng với z-50 — fireEvent.click bắt sự kiện click trên backdrop
      const backdrop = document.querySelector('[class*="fixed inset-0"][class*="z-50"]') as HTMLElement;
      expect(backdrop).not.toBeNull();
      await act(async () => { fireEvent.click(backdrop); });
      expect(defaultOnClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when backdrop clicked in no-wallet view', async () => {
      mockGuestWallet({ initStatus: 'IDLE' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      const backdrop = document.querySelector('[class*="fixed inset-0"][class*="z-50"]') as HTMLElement;
      expect(backdrop).not.toBeNull();
      await act(async () => { fireEvent.click(backdrop); });
      expect(defaultOnClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose when inner card clicked in guest ready view', async () => {
      mockGuestWallet({ initStatus: 'READY' });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      // Tìm card trắng bên trong backdrop
      const innerCard = document.querySelector('[class*="rounded-xl"][class*="bg-white"]') as HTMLElement;
      expect(innerCard).not.toBeNull();
      await act(async () => { fireEvent.click(innerCard); });
      expect(defaultOnClose).not.toHaveBeenCalled();
    });
  });

  describe('Bootstrap button', () => {
    it('calls bootstrapGuestWallet when clicked', async () => {
      const bootstrapMock = vi.fn();
      mockGuestWallet({ initStatus: 'IDLE' });
      // Override the specific mock
      vi.mocked(useGuestWallet).mockReturnValue({
        ...vi.mocked(useGuestWallet)(),
        bootstrapGuestWallet: bootstrapMock,
      });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      const btn = findButton('Bắt đầu quyên góp ngay');
      expect(btn).not.toBeNull();
      await act(async () => { fireEvent.click(btn!); });
      expect(bootstrapMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleGuestDonationSubmit guards', () => {
    it('opens confirm modal when donation amount is valid', async () => {
      mockGuestWallet({ initStatus: 'READY', remainingDonations: 3 });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);

      const input = screen.getByPlaceholderText(/Từ/);
      fireEvent.change(input, { target: { value: '100' } });
      const btn = findButton('Quyên góp ngay');
      await act(async () => { fireEvent.click(btn!); });

      assertText('Xác nhận quyên góp');
    });

    it('disables submit button when remainingDonations=0', () => {
      mockGuestWallet({ initStatus: 'READY', remainingDonations: 0 });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);
      assertText('Bạn đã đạt giới hạn 3 lần quyên góp');
      // Button is disabled when quota exceeded — text changes to "Quyên góp" (no "ngay")
      const btn = findButton('Quyên góp');
      expect(btn).not.toBeNull();
      expect(btn).toBeDisabled();
    });

    it('rejects decimal input', async () => {
      mockGuestWallet({ initStatus: 'READY', remainingDonations: 3 });
      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);

      const input = screen.getByPlaceholderText(/Từ/);
      fireEvent.change(input, { target: { value: '1.5' } });
      const btn = findButton('Quyên góp ngay');
      await act(async () => { fireEvent.click(btn!); });

      // Confirm modal should NOT open (decimal is invalid)
      expect(document.body.textContent ?? '').not.toContain('Xác nhận quyên góp');
    });

    it('clears input on successful donation', async () => {
      vi.useFakeTimers();
      try {
        const mockExecute = vi.fn().mockResolvedValue(true);
        mockGuestWallet({ initStatus: 'READY', remainingDonations: 3 });
        vi.mocked(useGuestWallet).mockReturnValue({
          ...vi.mocked(useGuestWallet)(),
          executeDonation: mockExecute,
        });

        render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);

        const input = screen.getByPlaceholderText(/Từ/) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '100' } });
        expect(input.value).toBe('100');

        const btn = findButton('Quyên góp ngay');
        await act(async () => { fireEvent.click(btn!); });

        assertText('Xác nhận quyên góp');

        const confirmBtn = findButton('Xác nhận');
        await act(async () => {
          fireEvent.click(confirmBtn!);
          await vi.advanceTimersByTimeAsync(100);
        });

        // Confirm modal should close immediately (UX fix: not waiting in finally)
        expect(document.body.textContent ?? '').not.toContain('Xác nhận quyên góp');
        expect(input.value).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-parse input after confirm modal opens — uses pendingDonationAmount', async () => {
      // Verify fix: guest submit reads pendingDonationAmount, not donationAmountInput
      // by checking that a change AFTER opening confirm does NOT affect the submission
      const mockExecute = vi.fn().mockResolvedValue(true);
      mockGuestWallet({ initStatus: 'READY', remainingDonations: 3 });
      vi.mocked(useGuestWallet).mockReturnValue({
        ...vi.mocked(useGuestWallet)(),
        executeDonation: mockExecute,
      });

      render(<DonationModal campaignItem={mockCampaign} onClose={defaultOnClose} onDonationSuccess={defaultOnSuccess} />);

      const input = screen.getByPlaceholderText(/Từ/) as HTMLInputElement;

      // Step 1: Type 100 → open confirm modal → pendingDonationAmount = 100
      fireEvent.change(input, { target: { value: '100' } });
      const btn = findButton('Quyên góp ngay');
      await act(async () => { fireEvent.click(btn!); });
      assertText('Xác nhận quyên góp');

      // Step 2: Change input to 999 AFTER modal is open — confirm modal still shows 100
      fireEvent.change(input, { target: { value: '999' } });
      expect(input.value).toBe('999');

      // Step 3: Click confirm — should still submit 100 (pendingDonationAmount), not 999
      const confirmBtn = findButton('Xác nhận');
      await act(async () => { fireEvent.click(confirmBtn!); });

      // executeDonation được gọi với amount = 100 (pendingDonationAmount), không phải giá trị input hiện tại
      expect(mockExecute).toHaveBeenCalledWith(mockCampaign.projectId, 100);
    });
  });
});
