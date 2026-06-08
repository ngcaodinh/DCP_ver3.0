/**
 * Mock helpers cho DonationModal integration tests.
 * Tach ra day de tranh Rolldown parse error khi vi.mock() nam trong cung file voi test.
 */
import { vi } from 'vitest';

// Dung vi.hoisted() de tao mock functions tai module level.
// Chi khi dung vi.hoisted(), Vitest moi properly track cac mock nay
// de co the truy cap trong vi.mock() factory VA trong test bodies.
const mockUseGuestWallet = vi.hoisted(() => vi.fn());
const mockReadAuthSession = vi.hoisted(() => vi.fn());
const mockExecuteOneClickDonationRequest = vi.hoisted(() => vi.fn());
const mockRecordDonationByTransactionHash = vi.hoisted(() => vi.fn());

// Mock GuestWalletProvider hook
vi.mock('@/app/components/GuestWalletProvider', () => ({
  useGuestWallet: mockUseGuestWallet,
}));

// Mock authSession
vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: mockReadAuthSession,
}));

// Mock services
vi.mock('@/app/donations/components/DonationModal.services', () => ({
  executeOneClickDonationRequest: mockExecuteOneClickDonationRequest,
  recordDonationByTransactionHash: mockRecordDonationByTransactionHash,
}));

// Mock apiClient
vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: vi.fn((path: string) => `https://api.example.com${path}`),
  fetchApi: vi.fn(),
}));

// Export mocks de test files co the su dung
export {
  mockUseGuestWallet,
  mockReadAuthSession,
  mockExecuteOneClickDonationRequest,
  mockRecordDonationByTransactionHash,
};
