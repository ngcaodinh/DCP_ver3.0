import { EventEmitter } from 'events';

/**
 * EventEmitter cho SBT mint lifecycle events.
 * Mục đích: bridge giữa worker (mint on-chain) và socket server (real-time UI)
 * + notification service (gửi notification cho donor khi mint thành công).
 * Pattern giống oracleEvents/webhookEvents.
 */
export const sbtEvents = new EventEmitter();
sbtEvents.setMaxListeners(100);

/** Loại sự kiện SBT. */
export type SbtEventType = 'sbt.minted' | 'sbt.mint-failed' | 'sbt.mint-dlq' | 'sbt.mint-blocked';

/**
 * Payload cho sbt.minted — phát ra khi worker nhận receipt on-chain với tokenId.
 * Mục đích: socket server forward tới admin/organization room, notification service
 * gửi notification cho donor.
 */
export type SbtMintedEventPayload = {
  sbtId: string;
  mintRequestId: string;
  projectId: string;
  organizationId: string;
  beneficiaryAddress: string;
  onChainTokenId: number;
  transactionHash: string;
  blockNumber: number;
  imageCid: string;
  tokenUri: string;
  milestone?: number;
  mintedAt: Date;
};

/**
 * Payload cho sbt.mint-failed — phát ra khi 1 attempt fail (sẽ retry).
 * Mục đích: notification service gửi alert cho admin nếu cần.
 * Khác với sbt.mint-dlq — failed chỉ là 1 attempt, vẫn còn retry.
 */
export type SbtMintFailedEventPayload = {
  sbtId: string;
  mintRequestId: string;
  projectId: string;
  organizationId: string;
  attemptNumber: number;
  errorMessage: string;
  failedAt: Date;
};

/**
 * Payload cho sbt.mint-dlq — phát ra khi hết 6 retry.
 * Mục đích: notification service gửi email cho admin (Q5 — SBT_MINT_FAILED thuộc allowlist).
 */
export type SbtMintDlqEventPayload = {
  sbtId: string;
  mintRequestId: string;
  projectId: string;
  organizationId: string;
  beneficiaryAddress: string;
  attemptNumber: number;
  lastErrorMessage: string;
  dlqAt: Date;
};

/**
 * Payload cho sbt.mint-blocked — phát ra khi mint bị chặn (không có donor address).
 * Mục đích: alert cho admin để xử lý — cần implement C4 (lookup donor wallet) trước.
 */
export type SbtMintBlockedEventPayload = {
  mintRequestId: string | null;
  verificationId: string;
  projectId: string;
  organizationId: string;
  reason: 'NO_DONOR_ADDRESS';
  blockedAt: Date;
};
