/**
 * Hàm redact sensitive data khỏi metadata object trước khi log.
 * Ngăn chặn việc log các thông tin nhạy cảm như tokens, passwords, PII.
 *
 * Các fields cần redact: token, body, deviceFingerprintHash, ipAddress, walletAddress
 * Chỉ redact khi giá trị là string dài (>8 chars để tránh truncate ngắn).
 */
function redactSensitiveData(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const redacted = { ...metadata };

  // Redact token - có thể chứa Bearer tokens hoặc session tokens
  if (redacted.token && typeof redacted.token === 'string' && redacted.token.length > 8) {
    redacted.token = `${redacted.token.substring(0, 8)}...[REDACTED]`;
  }

  // Redact body - có thể chứa passwords, PII - luôn redact vì có thể chứa sensitive data
  if (redacted.body && typeof redacted.body === 'string') {
    redacted.body = `[BODY_LENGTH:${redacted.body.length}][REDACTED]`;
  }

  // Redact deviceFingerprintHash - có thể dùng để track users across sessions
  if (redacted.deviceFingerprintHash && typeof redacted.deviceFingerprintHash === 'string') {
    redacted.deviceFingerprintHash = '[FINGERPRINT_REDACTED]';
  }

  // Redact IP address trong risk context - có thể dùng để track users
  if (redacted.ipAddress && typeof redacted.ipAddress === 'string') {
    redacted.ipAddress = '[IP_REDACTED]';
  }

  // Redact wallet address - có thể link với on-chain activity
  if (redacted.walletAddress && typeof redacted.walletAddress === 'string') {
    redacted.walletAddress = `${redacted.walletAddress.substring(0, 6)}...[REDACTED]`;
  }

  // Redact session ID - có thể dùng để track user sessions
  if (redacted.sessionId && typeof redacted.sessionId === 'string') {
    redacted.sessionId = `[SESSION_REDACTED]`;
  }

  // Redact smart account address - có thể link với on-chain activity
  if (redacted.smartAccountAddress && typeof redacted.smartAccountAddress === 'string') {
    redacted.smartAccountAddress = `${redacted.smartAccountAddress.substring(0, 6)}...[REDACTED]`;
  }

  // Redact guest wallet address - có thể link với on-chain activity
  if (redacted.guestWalletAddress && typeof redacted.guestWalletAddress === 'string') {
    redacted.guestWalletAddress = `${redacted.guestWalletAddress.substring(0, 6)}...[REDACTED]`;
  }

  return redacted;
}

type LogMetadata = {
  sessionId?: string;
  correlationId?: string;
  errorMessage?: string;
  errorStack?: string;
  smartAccountAddress?: string;
  fallbackWalletAddress?: string;
  walletAddress?: string;
  orderCode?: string;
  checksumSource?: string;
  verifyMode?: string;
  finalStatus?: string;
  selector?: string;
  errorName?: string;
  charityTokenAddress?: string;
  approveTransactionHash?: string;
  relayBalance?: string;
  relayAllowance?: string;
  transactionHash?: string;
  onChainTransactionHash?: string;
  paymasterErrorMessage?: string;
  donationContractAddress?: string;
  authenticatedUserId?: string;
  projectId?: string;
  performedBy?: string;
  performedByRole?: string;
  reason?: string;
  userId?: string;
  action?: string;
  newRenewalCount?: number;
  expiredSessions?: number;
  purgedSessions?: number;
  newClusters?: number;
  farmingDetected?: boolean;
  hasPendingDonation?: boolean;
  paymasterType?: string;
  sponsorshipId?: string;
  riskScore?: number;
  trustMultiplier?: number;
  newPaymasterType?: string;
  chainId?: number;
  token?: string;
  status?: string | number;
  body?: string;
  ipAddress?: string;
  amount?: number;
  riskLevel?: string;
  context?: Record<string, unknown>;
  factors?: Record<string, number>;
  deviceFingerprintHash?: string;
  originalError?: string;
  donorAddress?: string;
  errorCode?: string;
  userAgent?: string;
  claimNonce?: string;
  claimEOAAddress?: string;
  claimId?: string;
  claimType?: string;
  changeOwnerTxHash?: string;
  donationsMerged?: number;
  guestWalletAddress?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  mintTxHash?: string;
  userOpHash?: string;
  sender?: string;
  donationTxHash?: string;
  requestId?: string;
  disbursementRequestId?: string;
  payosTransferId?: string;
  transferId?: string;
  attemptNumber?: number;
  durationMs?: number;
  transferStatus?: string;
  jobId?: string | number;
  delay?: number;
  removedCount?: number;
  enqueued?: boolean;
  deadline?: string;
  transferIdempotencyKey?: string;
  idempotencyKey?: string;
  finalTransferId?: string;
  bankCode?: string;
  checksumPrefix?: string;
  bodyKeys?: string[];
  relayTxHash?: string;
  hasNestedData?: boolean;
};


const logger = {
  /**
   * Hàm ghi log thông tin.
   * Mục đích: phục vụ theo dõi sự kiện thường nhật.
   */
  info(message: string, metadata?: LogMetadata): void {
    if (metadata) {
      const safeMetadata = redactSensitiveData(metadata);
      console.log(message, safeMetadata);
      return;
    }
    console.log(message);
  },
  /**
   * Hàm ghi log cảnh báo.
   * Mục đích: ghi nhận các tình huống bất thường.
   */
  warn(message: string, metadata?: LogMetadata): void {
    if (metadata) {
      const safeMetadata = redactSensitiveData(metadata);
      console.warn(message, safeMetadata);
      return;
    }
    console.warn(message);
  },
  /**
   * Hàm ghi log lỗi.
   * Mục đích: lưu thông tin lỗi phục vụ điều tra.
   */
  error(message: string, metadata?: LogMetadata): void {
    if (metadata) {
      const safeMetadata = redactSensitiveData(metadata);
      console.error(message, safeMetadata);
      return;
    }
    console.error(message);
  }
};

/**
 * Hàm lấy logger dùng chung.
 * Mục đích: cung cấp logger thống nhất toàn ứng dụng.
 */
export function getLogger() {
  return logger;
}
