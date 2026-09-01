/**
 * Các types dùng chung trong DonationModal và các file liên quan.
 * Tách riêng để tránh circular import và tái sử dụng type ở test files.
 */

/** Item campaign trong danh sách hiển thị. */
export type DonationCampaignItem = {
  projectId: string;
  name: string;
  status: string;
  deadline?: string;
  minDonation: number;
  maxDonation: number;
};

/** Item trong lịch sử donation hiển thị trong modal. */
export type DonationHistoryItem = {
  transactionHash: string;
  donorAddress: string;
  amount: number;
  timestamp: string;
  isAnonymous: boolean;
};

/** Trạng thái giao dịch cho authenticated user donation flow. */
export type TransactionStatus = 'idle' | 'processing' | 'submitted' | 'finalizing' | 'success' | 'failed';

/** Reference certificate trả từ backend sau khi record event on-chain. */
export type DonationCertificateReference = { certificateId: string; issuanceStatus: 'PENDING_FINALITY' | 'ISSUED' | 'REVOKED' | 'BLOCKED'; finalityMode: 'RPC_FINALIZED' | 'CONFIRMATION_FALLBACK'; fallbackConfirmations: 12; verificationUrl: string; };

/** Response record donation dùng cho UX finality thay vì fire-and-forget API. */
export type RecordDonationResponse = { transactionHash: string; projectId: string; amount: number; timestamp: string; isAnonymous: boolean; certificate: DonationCertificateReference | null; };

/** Trạng thái hiển thị cho guest donation flow — ánh xạ từ GuestDonationStatus. */
export type GuestTransactionStatus = 'idle' | 'decrypting' | 'building' | 'paymaster' | 'submitting' | 'indexing' | 'success' | 'failed';

/** Props cho DonationModal. */
export type DonationModalProps = {
  campaignItem: DonationCampaignItem;
  onClose: () => void;
  onDonationSuccess: (projectId: string) => Promise<void>;
};
