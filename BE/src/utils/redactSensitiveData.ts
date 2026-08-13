import { maskWalletAddress } from './maskWalletAddress';
import { sanitizeProviderError } from './sanitizeProviderError';
import { sanitizeErrorStack } from './sanitizeErrorStack';

/**
 * Metadata dùng chung cho facade logger.
 * Mục đích: giữ nguyên contract metadata hiện có khi tách phần redact khỏi logger.
 */
export type LogMetadata = {
  [key: string]: unknown;
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
  keysDeleted?: number;
  userId?: string;
  notificationId?: string;
  notificationType?: string;
  channels?: string | string[];
  deliveryState?: string;
  attempts?: number;
  priority?: string | number;
  action?: string;
  deliveredChannels?: string | string[];
  requestedChannels?: string | string[];
  failedChannels?: string | string[];
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
  successCount?: number;
  flaggedCount?: number;
  chainId?: number;
  token?: string;
  status?: string | number;
  body?: string;
  ipAddress?: string;
  clientIp?: string;
  amount?: number;
  amountVnd?: number;
  donationAmount?: number;
  totalAmount?: number;
  transferAmount?: number;
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
  checksumPrefix?: string;
  bodyKeys?: string | string[];
  relayTxHash?: string;
  hasNestedData?: boolean;
  auditId?: string;
  sourceIp?: string;
  organizationId?: string;
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
  enqueuedBy?: string;
  deadline?: string;
  transferIdempotencyKey?: string;
  idempotencyKey?: string;
  finalTransferId?: string;
  bankCode?: string;
  // Oracle AI (B1) — EXIF GPS verification
  evidenceCid?: string;
  verificationId?: string;
  overrideRequestId?: string;
  queueJobId?: string | number;
  distanceMeters?: string | number;
  radiusMeters?: number;
  isValid?: boolean | null;
  fileSizeBytes?: number;
  totalFiles?: number;
  enqueuedCount?: number;
  attemptsMade?: number;
  isInRadius?: boolean;
  gpsFoundInImage?: boolean;
  // Oracle B2 — override voting
  commissionerCount?: number;
  voteOutcome?: string;
  pendingVoters?: number;
  totalVoters?: number;
  disbursementAutoApproved?: boolean;
  commissionerSetChanged?: boolean;
  currentStatus?: string;
  // D5 — multisig override log
  operator?: string;
  error?: string;
  // upload-validation.middleware.ts
  fileName?: string;
  originalName?: string;
  fieldName?: string;
  declaredMimeType?: string;
  detectedMimeType?: string;
  detectedExtension?: string;
  actualSize?: string | number;
  sizeLimit?: string | number;
  fileSize?: string | number;
  size?: string | number;
  failedCount?: number;
  failedFiles?: string[];
  types?: string | string[];
  rowCount?: number;
  maxRows?: number;
  // F1 — batch feedback upload
  inputType?: string;
  // SBT Auto-Mint (C2)
  sbtId?: string;
  mintRequestId?: string;
  tokenId?: string | number;
  onChainTokenId?: string | number;
  beneficiaryAddress?: string;
  toAddress?: string;
  gpsCoordinates?: string;
  imageCid?: string;
  tokenUri?: string;
  sbtMintAttemptNumber?: number;
  sbtMaxAttempts?: number;
  sbtMintNextDelayMs?: number;
  sbtMintStatus?: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'DLQ';
  sbtMintErrorMessage?: string;
  sbtReRunBy?: string;
  sbtDlqRecoveredAt?: string;
  activeJobId?: string;
  blockNumber?: number;
  nextAttempt?: number;
  previousAttemptNumber?: number;
  reRunBy?: string;
  reRunAt?: string;
  lastRunAgoMs?: number;
  recoveredAt?: string;
  recoveredBy?: string;
  nextDelayMs?: number;
  previousStatus?: string;
  stuckSeconds?: number;
  candidatesFound?: number;
  enqueuedAt?: string;
  dlqEntryCreated?: boolean;
  thresholdMinutes?: number;
  stuckMs?: number;
  activeJobIdempotencyKey?: string;
  stuckMintTxHash?: string;
  stuckSecondsMs?: number;
  // Additional SBT C2 fields
  olderThanMinutes?: number;
  projectIdNumeric?: number;
  milestone?: number;
  beneficiaryCount?: number;
  tokenIdRaw?: string;
  dlqAt?: string;
  minIntervalMs?: number;
  // Data Mapper (D2) — PayOS + blockchain sync
  utxId?: string;
  latestBlock?: number;
  originalBlock?: number;
  newBlock?: number;
  blockchainSynced?: number;
  payosSynced?: number;
  correlated?: number;
  reorged?: number;
  totalItems?: number;
  chainTxHash?: string;
  oldBlock?: number;
  fromBlock?: number;
  toBlock?: number;
  batchContentHash?: string;
  // G2 — QF Ranking
  roundId?: string;
  cacheKey?: string;
  windowDays?: number;
  hasTimeWindow?: boolean;
  // General
  yearMonth?: string;
  totalDonors?: number;
  totalDonationRecords?: number;
  skippedDonors?: number;
  // Pagination
  page?: number;
  limit?: number;
  // Cache
  cacheHit?: boolean;
  // Time
  startAt?: string;
  endAt?: string;
};

// E6 contract: ba field lõi và bảy field Web3 compatibility dùng chung policy địa chỉ trung tâm.
const E6_ONCHAIN_ADDRESS_FIELDS = [
  'walletAddress',
  'smartAccountAddress',
  'guestWalletAddress',
] as const;

// E6-b đã được promote vào boundary này để không còn call site Web3 nào ghi địa chỉ thô.
const E6B_COMPATIBILITY_ADDRESS_FIELDS = [
  'donorAddress',
  'beneficiaryAddress',
  'toAddress',
  'claimEOAAddress',
  'fallbackWalletAddress',
  'sender',
  'operator'
] as const;

const ONCHAIN_ADDRESS_FIELDS = [
  ...E6_ONCHAIN_ADDRESS_FIELDS,
  ...E6B_COMPATIBILITY_ADDRESS_FIELDS
] as const;

const AMOUNT_FIELDS = [
  'amount',
  'amountVnd',
  'donationAmount',
  'totalAmount',
  'transferAmount'
] as const;
const ERROR_MESSAGE_FIELD_NAMES = new Set([
  'error',
  'errormessage',
  'originalerror',
  'paymastererrormessage',
  'providererrormessage',
  'sbtminterrormessage',
  'lasterrormessage',
  // `reason` có thể đến trực tiếp từ request body; chỉ giữ bản đã sanitize trong log.
  'reason'
]);
const SENSITIVE_FIELD_NAMES = new Set<string>([
  'token',
  'body',
  'deviceFingerprintHash',
  'ipAddress',
  'clientIp',
  'sessionId',
  'errorMessage',
  'errorStack',
  'stack',
  'userAgent',
  'sourceIp',
  'gpsCoordinates',
  ...ONCHAIN_ADDRESS_FIELDS,
  ...AMOUNT_FIELDS
]);
const GENERIC_SENSITIVE_FIELD_NAMES = new Set([
  'apikey',
  'accesstoken',
  'authorization',
  'password',
  'privatekey',
  'secret',
  'secretkey',
  'bearertoken',
  'ip',
  'gps',
  'gpscoordinates',
  'latitude',
  'longitude'
]);
const ONCHAIN_ADDRESS_FIELD_SET = new Set<string>(
  ONCHAIN_ADDRESS_FIELDS.map(fieldName => fieldName.replace(/[-_]/g, '').toLowerCase())
);
const AMOUNT_FIELD_SET = new Set<string>(
  AMOUNT_FIELDS.map(fieldName => fieldName.replace(/[-_]/g, '').toLowerCase())
);
const REDACTED_BODY_PATTERN = /^\[BODY_LENGTH:\d+\]\[REDACTED\]$/;
const PRE_REDACTED_SUFFIX = '...[REDACTED]';
const CIRCULAR_METADATA_MARKER = '[CIRCULAR_REDACTED]';
const OVERSIZED_METADATA_MARKER = '[NESTED_METADATA_REDACTED]';
const OVERSIZED_TOP_LEVEL_METADATA_MARKER = '[METADATA_REDACTED]';
const NON_PLAIN_METADATA_MARKER = '[NON_PLAIN_METADATA_REDACTED]';
export const REDACTED_REASON_MARKER = '[REASON_REDACTED]';
const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_ENTRIES = 256;
const NORMALIZED_SENSITIVE_FIELD_NAMES = new Set(
  [...SENSITIVE_FIELD_NAMES].map(fieldName => fieldName.replace(/[-_]/g, '').toLowerCase())
);

/** Xác định field có thuộc nhóm secret phổ biến của provider hay không. */
function isSensitiveFieldName(fieldName: string): boolean {
  const normalizedFieldName = fieldName.replace(/[-_]/g, '').toLowerCase();
  return SENSITIVE_FIELD_NAMES.has(fieldName)
    || NORMALIZED_SENSITIVE_FIELD_NAMES.has(normalizedFieldName)
    || GENERIC_SENSITIVE_FIELD_NAMES.has(normalizedFieldName)
    || ERROR_MESSAGE_FIELD_NAMES.has(normalizedFieldName);
}

/**
 * Redact một field theo đúng policy của field đó, kể cả khi field nằm trong object lồng nhau.
 * Mục đích: bảo đảm metadata được tạo từ context động không bypass policy redact ở top-level.
 */
function redactFieldValue(fieldName: string, value: unknown): unknown {
  const normalizedFieldName = fieldName.replace(/[-_]/g, '').toLowerCase();
  if (normalizedFieldName === 'reason') {
    return value === undefined || value === null || value === '' ? value : REDACTED_REASON_MARKER;
  }
  if (normalizedFieldName === 'ip') {
    return value === undefined || value === null || value === '' ? value : '[IP_REDACTED]';
  }
  if (['gps', 'gpscoordinates', 'latitude', 'longitude'].includes(normalizedFieldName)) {
    return value === undefined || value === null || value === '' ? value : '[GPS_REDACTED]';
  }
  if (GENERIC_SENSITIVE_FIELD_NAMES.has(normalizedFieldName)) {
    return value === undefined || value === null || value === '' ? value : '[REDACTED]';
  }

  if (normalizedFieldName === 'token' && typeof value === 'string' && value) {
    return value.length > 8 ? `${value.substring(0, 8)}...[REDACTED]` : '[TOKEN_REDACTED]';
  }

  if (normalizedFieldName === 'body' && typeof value === 'string' && value && !REDACTED_BODY_PATTERN.test(value)) {
    return `[BODY_LENGTH:${value.length}][REDACTED]`;
  }

  if (normalizedFieldName === 'devicefingerprinthash' && typeof value === 'string') {
    return '[FINGERPRINT_REDACTED]';
  }

  if (['ipaddress', 'clientip', 'sourceip'].includes(normalizedFieldName)) {
    return typeof value === 'string' && value ? '[IP_REDACTED]' : value;
  }

  if (normalizedFieldName === 'sessionid' && typeof value === 'string' && value) {
    return '[SESSION_REDACTED]';
  }

  if (ERROR_MESSAGE_FIELD_NAMES.has(normalizedFieldName)) {
    return value === undefined || value === null || value === ''
      ? value
      : sanitizeProviderError(value) ?? '[ERROR_REDACTED]';
  }

  if (normalizedFieldName === 'errorstack' && typeof value === 'string' && value) {
    return sanitizeErrorStack(value) ?? '[STACK_REDACTED]';
  }

  if (normalizedFieldName === 'stack' && typeof value === 'string' && value) {
    return sanitizeErrorStack(value) ?? '[STACK_REDACTED]';
  }

  if (normalizedFieldName === 'useragent' && typeof value === 'string' && value) {
    return '[USER_AGENT_REDACTED]';
  }

  if (normalizedFieldName === 'gpscoordinates' && typeof value === 'string' && value) {
    return '[GPS_REDACTED]';
  }

  if (ONCHAIN_ADDRESS_FIELD_SET.has(normalizedFieldName)
    && typeof value === 'string'
    && value
    && !value.endsWith(PRE_REDACTED_SUFFIX)) {
    return maskWalletAddress(value);
  }

  if (AMOUNT_FIELD_SET.has(normalizedFieldName)
    && (typeof value === 'number' || (value && typeof value === 'string'))) {
    return '***VND';
  }

  return value;
}

/**
 * Duyệt metadata lồng nhau bằng bản sao mới và chặn circular reference.
 * Mục đích: không mutate object đầu vào nhưng vẫn redact được context sâu trong log.
 */
function redactNestedValue(value: unknown, ancestors: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return value instanceof Error
      ? sanitizeProviderError(value) ?? '[ERROR_REDACTED]'
      : NON_PLAIN_METADATA_MARKER;
  }
  if (ancestors.has(value)) return CIRCULAR_METADATA_MARKER;
  if (depth >= MAX_REDACTION_DEPTH) return OVERSIZED_METADATA_MARKER;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_REDACTION_ENTRIES) return OVERSIZED_METADATA_MARKER;
      return value.map(item => redactNestedValue(item, ancestors, depth + 1));
    }

    const nested = value as Record<string, unknown>;
    const entries = Object.entries(nested);
    if (entries.length > MAX_REDACTION_ENTRIES) return OVERSIZED_METADATA_MARKER;

    const redactedNested: Record<string, unknown> = {};
    for (const [fieldName, fieldValue] of entries) {
      const copiedValue = redactNestedValue(fieldValue, ancestors, depth + 1);
      redactedNested[fieldName] = isSensitiveFieldName(fieldName)
        ? redactFieldValue(fieldName, copiedValue)
        : copiedValue;
    }
    return redactedNested;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Redact metadata trước khi ghi log.
 * Mục đích: loại bỏ secret/PII và rút gọn dữ liệu public mà không mutate input.
 * Hàm được gọi đúng một lần ở facade logger; các format Winston không được redact lại.
 */
export function redactSensitiveData(
  metadata?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (Object.keys(metadata).length > MAX_REDACTION_ENTRIES) {
    return { _redaction: OVERSIZED_TOP_LEVEL_METADATA_MARKER };
  }

  const redacted = { ...metadata };
  const ancestors = new WeakSet<object>();

  for (const [fieldName, fieldValue] of Object.entries(redacted)) {
    const copiedValue = redactNestedValue(fieldValue, ancestors);
    redacted[fieldName] = isSensitiveFieldName(fieldName)
      ? redactFieldValue(fieldName, copiedValue)
      : copiedValue;
  }

  return redacted;
}
