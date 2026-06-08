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
export type TransactionStatus = 'idle' | 'processing' | 'submitted' | 'success' | 'failed';

/** Trạng thái hiển thị cho guest donation flow — ánh xạ từ GuestDonationStatus. */
export type GuestTransactionStatus = 'idle' | 'decrypting' | 'building' | 'paymaster' | 'submitting' | 'indexing' | 'success' | 'failed';

/** Props cho DonationModal. */
export type DonationModalProps = {
  campaignItem: DonationCampaignItem;
  onClose: () => void;
  onDonationSuccess: (projectId: string) => Promise<void>;
};
