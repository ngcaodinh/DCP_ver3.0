import { ethers } from 'ethers';
import { encodeFunctionData } from 'viem';
import { randomUUID } from 'crypto';
import { getLogger } from '../config/logger';
import { runWithWorkerContext } from '../config/requestContext';
import { ApplicationError } from '../utils/applicationError';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import {
  createDisbursementRecord,
  DisbursementRecord,
  DisbursementStatus,
  findDisbursementByPayosTransferId,
  findDisbursementByRequestId,
  findDisbursementsByOrganizationId,
  findDisbursementsByProjectId,
  findDisbursementsByStatus,
  findLatestDisbursements,
  findPendingDisbursementByBeneficiary,
  updateDisbursementByRequestId,
  updateDisbursementByRequestIdWithCondition
} from '../models/disbursementModel';
import { AuthUser, findUserById, updateUser } from '../models/authModel';
import { findProjectById } from '../repositories/projectRepository';
import { createUserNotification } from './notificationService';
import { webhookEvents, type DisbursementWebhookEventPayload } from '../events/webhookEvents';
import * as eventLoggerService from './event-logger.service';
import { createKernelClientFromEncryptedOwnerKey } from './zeroDevService';
import {
  getPayosTransferStatusByReferenceId,
  verifyPayosTransferWebhookChecksum
} from './payosService';
import { removePendingJobsByRequestId } from '../queues/disbursementTransferQueue';
import { triggerPayosTransferForApprovedDisbursement } from '../workers/payosTransferWorker';
import { openManualReviewQueueForDisbursement } from './manualReviewService';
import { recordBlockchainTransaction } from '../utils/blockchainMetrics';

// ============ ABI ============

const multisigContractAbiEthers = [
  'event RequestCreated(uint256 indexed requestId, uint256 indexed projectId, address indexed beneficiary, uint256 amount, string evidenceCid, uint256 createdAt, uint256 timeoutDeadline, uint8 requestMode, uint256 requiredApprovals, uint256 raisedRatioBpsAtCreation)',
  'function createDisbursementRequest(uint256 projectId, address beneficiary, uint256 amount, uint256 projectGoalAmount, string evidenceCid, uint8 requestMode, string emergencyReason) external returns (uint256 requestId)',
  'function signRequest(uint256 requestId) external',
  'function rejectRequest(uint256 requestId, string reason) external',
  'function finalizeDisbursement(uint256 requestId, uint256 transactionId) external returns (uint256 burnedAmount)',
  'function getRequest(uint256 requestId) external view returns (bool exists, uint256 requestIdOut, uint256 projectId, address beneficiaryAddress, uint256 amount, uint8 status, uint256 approvalCount, uint256 signedCount, uint256 createdAt, uint256 executedAt, uint256 cancelledAt, bool adminSigned, bool orgSigned, bool regulatorySigned, uint256 timeoutDeadline, uint256 maxWithdrawable, uint8 requestMode, uint256 requiredApprovals, uint256 raisedRatioBpsAtCreation, bool adminRoleSignatureCollected, bool orgRoleSignatureCollected, bool regulatoryRoleSignatureCollected)',
  'function getRequestStrings(uint256 requestId) external view returns (string evidenceCid, string rejectReason)',
  'function getMaxWithdrawableAmount(uint256 projectId) external view returns (uint256 maxAmount)',
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function ADMIN_SIGNER_ROLE() external view returns (bytes32)',
  'function ORG_SIGNER_ROLE() external view returns (bytes32)',
  'function REGULATORY_SIGNER_ROLE() external view returns (bytes32)',
  'function grantAdminSignerRole(address account) external',
  'function grantOrgSignerRole(address account) external',
  'function grantRegulatorySignerRole(address account) external'
] as const;

const multisigContractAbiViem = [
  {
    name: 'createDisbursementRequest',
    type: 'function',
    inputs: [
      { name: 'projectId', type: 'uint256' },
      { name: 'beneficiary', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'projectGoalAmount', type: 'uint256' },
      { name: 'evidenceCid', type: 'string' },
      { name: 'requestMode', type: 'uint8' },
      { name: 'emergencyReason', type: 'string' }
    ],
    outputs: [{ name: 'requestId', type: 'uint256' }]
  },
  {
    name: 'signRequest',
    type: 'function',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: []
  },
  {
    name: 'rejectRequest',
    type: 'function',
    inputs: [
      { name: 'requestId', type: 'uint256' },
      { name: 'reason', type: 'string' }
    ],
    outputs: []
  }
] as const;

const requestCreatedEventInterface = new ethers.Interface([
  'event RequestCreated(uint256 indexed requestId, uint256 indexed projectId, address indexed beneficiary, uint256 amount, string evidenceCid, uint256 createdAt, uint256 timeoutDeadline, uint8 requestMode, uint256 requiredApprovals, uint256 raisedRatioBpsAtCreation)'
]);

const logger = getLogger();

const transferStatusSweepIntervalMilliseconds = 60000;
const transferStatusSweepBatchLimitCount = 20;
const FINALIZE_CLAIM_LEASE_MS = 10 * 60 * 1000;
const minimumPayosTransferAmountVnd = readPositiveIntegerEnv(process.env.PAYOS_TRANSFER_MIN_AMOUNT_VND, 10000);
const activeTransferSyncRequestIdSet = new Set<string>();
let isTransferStatusSweepStarted = false;

// ============ TYPES ============

export type CreateDisbursementPayload = {
  projectId: string;
  amount: number;
  usagePurpose: string;
  evidenceCid: string;
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason?: string;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string;
  };
};

export type DisbursementResult = {
  requestId: string;
  onChainRequestId: number;
  projectId: string;
  organizationId: string;
  beneficiaryWalletAddress: string;
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string;
  };
  requestMode: 'NORMAL' | 'EMERGENCY';
  emergencyReason: string | null;
  requiredApprovals: number;
  raisedRatioBpsAtCreation: number;
  amount: number;
  usagePurpose: string;
  evidenceCid: string;
  status: DisbursementStatus;
  approvals: Array<{
    signerRole: string;
    signerUserId: string;
    signerAddress: string;
    transactionHash: string;
    signedAt: Date;
    comment?: string;
  }>;
  rejection: { signerRole: string; signerUserId: string; signerAddress: string; reason: string; rejectedAt: Date } | null;
  timeoutDeadline: Date | null;
  payosTransferId: string | null;
  payosTransferStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date | null;
  completedAt: Date | null;
};

export type DisbursementRequestSummary = {
  id: string;
  projectName: string;
  organizationName: string;
  amount: number;
  requiredSignatures: number;
  currentSignatures: number;
  deadlineTimestamp: number;
  usagePurpose: string;
  ipfsCid: string;
  fileName: string;
  requestMode: 'NORMAL' | 'EMERGENCY';
};

export type DisbursementApprovalLogStatus = 'SIGNED' | 'PENDING' | 'REJECTED';

export type DisbursementApprovalLog = {
  id: string;
  requestId: string;
  transactionHash: string | null;
  amount: number;
  status: DisbursementApprovalLogStatus;
  actor: string;
  actionTimestamp: number;
};

type DisbursementApprovalLogWithSortValue = DisbursementApprovalLog & {
  actionTimestampValue: number;
};

type KernelClientContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kernelClient: any;
  smartAccountAddress: `0x${string}`;
  effectiveUser: AuthUser;
};

type ManagedDisbursementSignerRole = 'admin' | 'organizations' | 'regulatory';

type RequestCreatedEventData = {
  onChainRequestId: number;
  timeoutDeadline: Date;
  requiredApprovals: number;
  requestMode: 'NORMAL' | 'EMERGENCY';
  raisedRatioBpsAtCreation: number;
};

export type DisbursementTransferWebhookPayload = {
  requestId?: string | number;
  transferId?: string | number;
  transactionId?: string | number;
  referenceNumber?: string | number;
  bankReferenceNumber?: string | number;
  status?: string;
  code?: string | number;
  desc?: string;
  data?: Record<string, unknown>;
  signature?: string;
  checksum?: string;
  checksumSource?: 'header' | 'body' | 'missing';
};

type TransferWebhookChecksumCandidate = {
  checksumData: Record<string, unknown>;
  checksumValue: string;
  verifyMode: 'payload_data' | 'payload_top_level';
};

type TransferWebhookIdentifiers = {
  requestId: string | null;
  transferId: string | null;
  providerTransactionId: string | null;
};

type PayosTransferStatusSnapshot = Awaited<ReturnType<typeof getPayosTransferStatusByReferenceId>>;

type ProcessDisbursementTransferWebhookOptions = {
  skipChecksumVerify?: boolean;
  source?: 'external_webhook' | 'internal_poll';
  expectedTransferIdempotencyKey?: string;
};

type DisbursementNotificationData = Pick<
  DisbursementResult,
  'requestId'
  | 'projectId'
  | 'organizationId'
  | 'amount'
  | 'status'
  | 'payosTransferStatus'
  | 'payosTransferId'
>;

// ============ HELPERS ============

/** Hàm đọc số nguyên dương từ biến môi trường. Mục đích: cấu hình polling an toàn với fallback mặc định. */
function readPositiveIntegerEnv(environmentValue: string | undefined, fallbackValue: number): number {
  const parsedValue = Number(environmentValue);
  if (!Number.isFinite(parsedValue)) {
    return fallbackValue;
  }

  const normalizedValue = Math.floor(parsedValue);
  if (normalizedValue <= 0) {
    return fallbackValue;
  }

  return normalizedValue;
}

/** Hàm tạo idempotency key cố định cho mỗi request. Mục đích: chống tạo lệnh chuyển khoản trùng lặp. */
function buildTransferIdempotencyKey(requestId: string): string {
  return `disbursement-${requestId}`;
}

/** Hàm ánh xạ role user sang signer role. Mục đích: thống nhất role lưu trong mảng approvals. */
function mapSignerRole(userRole: string): 'ADMIN_SIGNER' | 'ORG_SIGNER' | 'REGULATORY_SIGNER' | null {
  if (userRole === 'admin') return 'ADMIN_SIGNER';
  if (userRole === 'organizations') return 'ORG_SIGNER';
  if (userRole === 'regulatory') return 'REGULATORY_SIGNER';
  return null;
}

/** Hàm ánh xạ signer role sang nhãn hiển thị trong bảng nhật ký ký duyệt. */
function mapSignerRoleToApprovalActor(signerRole: string): string {
  if (signerRole === 'ADMIN_SIGNER') {
    return 'Admin hệ thống';
  }

  if (signerRole === 'ORG_SIGNER') {
    return 'Đại diện tổ chức từ thiện';
  }

  if (signerRole === 'REGULATORY_SIGNER') {
    return 'Cơ quan giám sát';
  }

  return signerRole;
}

/** Hàm tạo thông báo chữ ký giải ngân cho tổ chức. Mục đích: báo realtime khi admin hoặc kiểm soát viên đã ký request. */
async function createDisbursementSignatureNotification(record: DisbursementRecord, signerRole: string): Promise<void> {
  if (signerRole !== 'ADMIN_SIGNER' && signerRole !== 'REGULATORY_SIGNER') {
    return;
  }

  const signerLabel = signerRole === 'ADMIN_SIGNER' ? 'Quản trị viên' : 'Kiểm soát viên';

  await createUserNotification({
    userId: record.organizationId,
    notificationType: 'DISBURSEMENT_SIGNED',
    title: `${signerLabel} đã ký giải ngân`,
    content: `${signerLabel} đã ký yêu cầu giải ngân ${record.requestId} cho dự án ${record.projectId}.`,
    deduplicationKey: `DISBURSEMENT_SIGNED:${record.requestId}:${signerRole}`,
    metadata: {
      requestId: record.requestId,
      projectId: record.projectId,
      signerRole,
      signerLabel,
      amount: record.amount
    }
  });
}

/**
 * Phát sự kiện thông báo khi trạng thái giải ngân đã chuyển terminal.
 * Chỉ caller thắng cập nhật nguyên tử mới được gọi hàm này để tránh gửi trùng.
 */
export async function emitDisbursementNotification(
  disbursement: DisbursementNotificationData
): Promise<void> {
  try {
    const eventPayload: DisbursementWebhookEventPayload = {
      requestId: disbursement.requestId,
      projectId: disbursement.projectId,
      organizationId: disbursement.organizationId,
      amount: disbursement.amount,
      status: disbursement.status,
      payosTransferStatus: disbursement.payosTransferStatus || 'UNKNOWN',
      payosTransferId: disbursement.payosTransferId,
      transactionHash: null
    };

    if (disbursement.status === 'COMPLETED' && disbursement.payosTransferStatus === 'SUCCESS') {
      webhookEvents.emit('DISBURSEMENT_TRANSFERRED', eventPayload);
      eventLoggerService.logEvent({
        eventType: 'DISBURSEMENT_TRANSFERRED',
        projectId: disbursement.projectId,
        organizationId: disbursement.organizationId,
        amount: disbursement.amount,
        correlationId: disbursement.requestId,
        timestamp: new Date(),
        payload: {
          requestId: disbursement.requestId,
          status: disbursement.status,
          payosTransferStatus: disbursement.payosTransferStatus,
          payosTransferId: disbursement.payosTransferId,
          transactionHash: eventPayload.transactionHash
        }
      });
      return;
    }

    if (disbursement.payosTransferStatus === 'MANUAL_REVIEW' || disbursement.payosTransferStatus === 'FAILED') {
      webhookEvents.emit('DISBURSEMENT_TRANSFER_FAILED', eventPayload);
      eventLoggerService.logEvent({
        eventType: 'DISBURSEMENT_TRANSFER_FAILED',
        projectId: disbursement.projectId,
        organizationId: disbursement.organizationId,
        amount: disbursement.amount,
        correlationId: disbursement.requestId,
        timestamp: new Date(),
        payload: {
          requestId: disbursement.requestId,
          status: disbursement.status,
          payosTransferStatus: disbursement.payosTransferStatus,
          payosTransferId: disbursement.payosTransferId,
          transactionHash: eventPayload.transactionHash
        }
      });
    }
  } catch (error) {
    logger.error('Phát sự kiện notification giải ngân thất bại.', {
      requestId: disbursement.requestId,
      errorMessage: (error as Error)?.message
    });
  }
}

/** Hàm ánh xạ trạng thái request sang trạng thái nhật ký để frontend hiển thị badge thống nhất. */
function mapDisbursementStatusToApprovalLogStatus(status: DisbursementStatus): DisbursementApprovalLogStatus {
  if (status === 'REJECTED') {
    return 'REJECTED';
  }

  if (status === 'PENDING' || status === 'EXPIRED' || status === 'CANCELLED') {
    return 'PENDING';
  }

  return 'SIGNED';
}

/** Hàm lấy tên tổ chức từ cache hoặc MongoDB để tránh truy vấn lặp khi dựng nhật ký ký duyệt. */
async function resolveOrganizationDisplayNameForApprovalLog(
  organizationId: string,
  organizationNameCacheMap: Map<string, string>
): Promise<string> {
  const cachedOrganizationName = organizationNameCacheMap.get(organizationId);
  if (cachedOrganizationName) {
    return cachedOrganizationName;
  }

  const organizationUser = await findUserById(organizationId);
  const organizationDisplayName = organizationUser?.organizationName || organizationUser?.fullName || organizationId;
  organizationNameCacheMap.set(organizationId, organizationDisplayName);
  return organizationDisplayName;
}

/** Hàm ánh xạ trạng thái on-chain sang trạng thái MongoDB. Mục đích: đồng bộ lifecycle FR7/FR8 giữa các tầng. */
function mapOnChainStatusToDisbursementStatus(onChainStatus: number): DisbursementStatus {
  if (onChainStatus === 1) return 'PENDING';
  if (onChainStatus === 2) return 'APPROVED';
  if (onChainStatus === 3) return 'EXECUTING';
  if (onChainStatus === 4) return 'COMPLETED';
  if (onChainStatus === 5) return 'REJECTED';
  if (onChainStatus === 6) return 'CANCELLED';
  if (onChainStatus === 7) return 'EXPIRED';
  return 'PENDING';
}

/** Hàm ánh xạ request mode sang giá trị uint8 của contract. Mục đích: encode đúng ABI khi gọi create request. */
function mapRequestModeToContractValue(requestMode: 'NORMAL' | 'EMERGENCY'): number {
  return requestMode === 'EMERGENCY' ? 1 : 0;
}

/** Hàm chuyển provider transaction id về uint256. Mục đích: truyền tham số finalizeDisbursement đúng kiểu on-chain. */
function mapProviderTransactionIdToUint256(providerTransactionId: string): bigint {
  const normalizedProviderTransactionId = providerTransactionId.trim();
  const digitsOnlyValue = normalizedProviderTransactionId.replace(/\D/g, '');

  if (digitsOnlyValue.length > 0) {
    return BigInt(digitsOnlyValue.slice(0, 60));
  }

  // Ghi chú logic phức tạp: fallback sang keccak256 để luôn có giá trị deterministic
  // ngay cả khi cổng thanh toán trả transaction id dạng chuỗi ký tự không phải số.
  const hashedValue = ethers.keccak256(ethers.toUtf8Bytes(normalizedProviderTransactionId || String(Date.now())));
  return BigInt(hashedValue);
}

/** Hàm chuyển giá trị bất kỳ về chuỗi nullable. Mục đích: tránh lặp logic trim/check rỗng khi parse payload webhook transfer. */
function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedValue = String(value).trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

/** Hàm chuẩn hóa data object từ payload webhook transfer. Mục đích: hỗ trợ cả trường hợp data là object hoặc chuỗi JSON. */
function normalizeTransferWebhookData(rawData: unknown): Record<string, unknown> {
  if (!rawData) {
    return {};
  }

  if (typeof rawData === 'string') {
    try {
      const parsedData = JSON.parse(rawData) as unknown;
      if (parsedData && typeof parsedData === 'object') {
        return parsedData as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  if (typeof rawData === 'object') {
    return rawData as Record<string, unknown>;
  }

  return {};
}

/** Hàm chuẩn hóa danh sách transaction từ payload webhook transfer. Mục đích: hỗ trợ cả dữ liệu dạng array và object map. */
function normalizeTransferWebhookTransactionList(rawTransactions: unknown): Record<string, unknown>[] {
  if (Array.isArray(rawTransactions)) {
    return rawTransactions
      .filter((transactionItem): transactionItem is Record<string, unknown> => Boolean(transactionItem) && typeof transactionItem === 'object');
  }

  if (rawTransactions && typeof rawTransactions === 'object') {
    return Object.values(rawTransactions)
      .filter((transactionItem): transactionItem is Record<string, unknown> => Boolean(transactionItem) && typeof transactionItem === 'object');
  }

  return [];
}

/** Hàm lấy transaction chính từ payload webhook transfer. Mục đích: đồng nhất cách đọc trạng thái và định danh khi PayOS trả cấu trúc payouts lồng nhau. */
function extractPrimaryTransferWebhookTransaction(webhookData: Record<string, unknown>): Record<string, unknown> | null {
  const directTransactionList = normalizeTransferWebhookTransactionList(webhookData.transactions);
  if (directTransactionList.length > 0) {
    return directTransactionList[0];
  }

  const payoutList = Array.isArray(webhookData.payouts) ? webhookData.payouts : [];
  for (const payoutItem of payoutList) {
    if (!payoutItem || typeof payoutItem !== 'object') {
      continue;
    }

    const payoutRecord = payoutItem as Record<string, unknown>;
    const nestedTransactionList = normalizeTransferWebhookTransactionList(payoutRecord.transactions);
    if (nestedTransactionList.length > 0) {
      return nestedTransactionList[0];
    }
  }

  return null;
}

/** Hàm dựng danh sách ứng viên checksum cho webhook transfer. Mục đích: verify linh hoạt giữa payload.data và payload top-level. */
function buildTransferWebhookChecksumCandidates(
  payload: DisbursementTransferWebhookPayload
): TransferWebhookChecksumCandidate[] {
  const webhookData = normalizeTransferWebhookData(payload.data);
  const payloadData = { ...(payload as unknown as Record<string, unknown>) };
  delete payloadData.checksumSource;
  const checksumValue = String(payload.signature || payload.checksum || '').trim();

  if (!checksumValue) {
    return [];
  }

  const checksumCandidateList: TransferWebhookChecksumCandidate[] = [];
  if (Object.keys(webhookData).length > 0) {
    checksumCandidateList.push({
      checksumData: webhookData,
      checksumValue,
      verifyMode: 'payload_data'
    });
  }

  checksumCandidateList.push({
    checksumData: payloadData,
    checksumValue,
    verifyMode: 'payload_top_level'
  });

  return checksumCandidateList;
}

/** Hàm xác thực danh sách checksum candidate của webhook transfer. Mục đích: trả kết quả verify kèm chế độ thành công để phục vụ audit log. */
function verifyTransferWebhookChecksumCandidates(
  checksumCandidateList: TransferWebhookChecksumCandidate[]
): { isValid: boolean; verifyMode: 'payload_data' | 'payload_top_level' | 'none' } {
  for (const checksumCandidate of checksumCandidateList) {
    const isValidChecksum = verifyPayosTransferWebhookChecksum(checksumCandidate.checksumData, checksumCandidate.checksumValue);
    if (isValidChecksum) {
      return { isValid: true, verifyMode: checksumCandidate.verifyMode };
    }
  }

  return { isValid: false, verifyMode: 'none' };
}

/** Hàm trích xuất định danh transfer từ payload webhook. Mục đích: định tuyến webhook đúng request với ưu tiên transferId, sau đó fallback requestId. */
function extractTransferWebhookIdentifiers(payload: DisbursementTransferWebhookPayload): TransferWebhookIdentifiers {
  const webhookData = normalizeTransferWebhookData(payload.data);
  const primaryWebhookTransaction = extractPrimaryTransferWebhookTransaction(webhookData);

  const transferId = toNullableString(
    webhookData.transferId
    || webhookData.id
    || webhookData.transactionId
    || webhookData.payoutId
    || webhookData.referenceId
    || (primaryWebhookTransaction ? primaryWebhookTransaction.id : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.transactionId : undefined)
    || payload.transferId
    || payload.transactionId
  );

  const requestId = toNullableString(
    webhookData.requestId
    || webhookData.referenceId
    || webhookData.orderCode
    || (primaryWebhookTransaction ? primaryWebhookTransaction.requestId : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.referenceId : undefined)
    || payload.requestId
  );

  const providerTransactionId = toNullableString(
    (primaryWebhookTransaction ? primaryWebhookTransaction.transactionId : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.id : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.bankReferenceNumber : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.referenceNumber : undefined)
    || webhookData.transactionId
    || webhookData.bankReferenceNumber
    || webhookData.referenceNumber
    || payload.transactionId
    || payload.bankReferenceNumber
    || payload.referenceNumber
    || transferId
  );

  return {
    requestId,
    transferId,
    providerTransactionId
  };
}

/** Hàm ánh xạ trạng thái webhook transfer sang trạng thái nội bộ. Mục đích: chuẩn hóa nhiều biến thể status/code từ cổng thanh toán. */
function mapTransferWebhookStatus(statusValue: string): 'PROCESSING' | 'SUCCESS' | 'FAILED' {
  const normalizedStatusValue = statusValue.trim().toUpperCase();

  if (['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'DONE', 'PAID', '00', '0'].includes(normalizedStatusValue)) {
    return 'SUCCESS';
  }

  if (
    ['FAILED', 'FAIL', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED', '-1', '02'].includes(normalizedStatusValue)
    || normalizedStatusValue.startsWith('ERR')
  ) {
    return 'FAILED';
  }

  return 'PROCESSING';
}

/** Hàm ánh xạ record MongoDB sang response API. Mục đích: trả dữ liệu nhất quán cho FE. */
function mapDisbursementRecordToResult(record: DisbursementRecord): DisbursementResult {
  return {
    requestId: record.requestId,
    onChainRequestId: record.onChainRequestId,
    projectId: record.projectId,
    organizationId: record.organizationId,
    beneficiaryWalletAddress: record.beneficiaryWalletAddress,
    beneficiaryBankAccount: record.beneficiaryBankAccount,
    requestMode: record.requestMode,
    emergencyReason: record.emergencyReason,
    requiredApprovals: record.requiredApprovals,
    raisedRatioBpsAtCreation: record.raisedRatioBpsAtCreation,
    amount: record.amount,
    usagePurpose: record.usagePurpose,
    evidenceCid: record.evidenceCid,
    status: record.status,
    approvals: record.approvals,
    rejection: record.rejection,
    timeoutDeadline: record.timeoutDeadline,
    payosTransferId: record.payosTransferId,
    payosTransferStatus: record.payosTransferStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiredAt: record.expiredAt,
    completedAt: record.completedAt
  };
}

/** Hàm lấy contract multisig ở chế độ read-only. Mục đích: truy vấn trạng thái on-chain không cần chữ ký. */
function getReadOnlyMultisigContract() {
  const blockchainRpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
  const multisigContractAddress = process.env.MULTISIG_DISBURSEMENT_ADDRESS?.trim() || '';

  if (!blockchainRpcUrl || !multisigContractAddress) {
    throw new ApplicationError('Thiếu cấu hình BLOCKCHAIN_RPC_URL hoặc MULTISIG_DISBURSEMENT_ADDRESS.', 500, 'INTERNAL_ERROR');
  }

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const contract = new ethers.Contract(multisigContractAddress, multisigContractAbiEthers, provider);
  return { provider, contractAddress: multisigContractAddress, contract };
}

/** Hàm lấy contract multisig có quyền ghi bằng ví admin hệ thống. Mục đích: finalize disbursement ở luồng FR8. */
function getAdminWritableMultisigContract() {
  const blockchainRpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
  const multisigContractAddress = process.env.MULTISIG_DISBURSEMENT_ADDRESS?.trim() || '';
  const adminPrivateKey = process.env.DONATION_ADMIN_PRIVATE_KEY?.trim() || '';

  if (!blockchainRpcUrl || !multisigContractAddress || !adminPrivateKey) {
    throw new ApplicationError(
      'Thiếu cấu hình blockchain cho finalize disbursement. Cần BLOCKCHAIN_RPC_URL, MULTISIG_DISBURSEMENT_ADDRESS, DONATION_ADMIN_PRIVATE_KEY.',
      500,
      'INTERNAL_ERROR'
    );
  }

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const adminSigner = new ethers.Wallet(adminPrivateKey, provider);
  const contract = new ethers.Contract(multisigContractAddress, multisigContractAbiEthers, adminSigner);
  return { provider, contractAddress: multisigContractAddress, contract };
}

/** Hàm parse event RequestCreated từ receipt. Mục đích: lấy requestId và policy động trả về bởi contract. */
function parseRequestCreatedEvent(receiptLogs: readonly ethers.Log[]): RequestCreatedEventData {
  for (const eventLog of receiptLogs) {
    try {
      const parsedEventLog = requestCreatedEventInterface.parseLog(eventLog);
      if (!parsedEventLog || parsedEventLog.name !== 'RequestCreated') {
        continue;
      }

      const parsedRequestMode = Number(parsedEventLog.args[7]);
      return {
        onChainRequestId: Number(parsedEventLog.args[0]),
        timeoutDeadline: new Date(Number(parsedEventLog.args[6]) * 1000),
        requestMode: parsedRequestMode === 1 ? 'EMERGENCY' : 'NORMAL',
        requiredApprovals: Number(parsedEventLog.args[8]),
        raisedRatioBpsAtCreation: Number(parsedEventLog.args[9])
      };
    } catch {
      // Bỏ qua log không thuộc event RequestCreated.
    }
  }

  throw new ApplicationError('Không thể đọc RequestCreated event từ receipt.', 502, 'INTERNAL_ERROR');
}

/** Hàm validate payload tạo request. Mục đích: chặn dữ liệu sai trước khi gọi blockchain. */
function validateCreateDisbursementPayload(payload: CreateDisbursementPayload): void {
  if (!payload.projectId?.trim()) {
    throw new ApplicationError('ProjectId không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    throw new ApplicationError('Số tiền rút phải lớn hơn 0.', 400, 'VALIDATION_ERROR');
  }

  if (!Number.isInteger(payload.amount)) {
    throw new ApplicationError('Số tiền rút phải là số nguyên (VNĐ).', 400, 'VALIDATION_ERROR');
  }

  if (!Number.isSafeInteger(payload.amount)) {
    throw new ApplicationError('Số tiền rút vượt quá giới hạn số nguyên an toàn.', 400, 'VALIDATION_ERROR');
  }

  if (payload.amount < minimumPayosTransferAmountVnd) {
    throw new ApplicationError(`Số tiền rút tối thiểu là ${minimumPayosTransferAmountVnd.toLocaleString('vi-VN')} VNĐ để đáp ứng điều kiện giải ngân.`, 400, 'VALIDATION_ERROR');
  }

  if (!payload.usagePurpose?.trim()) {
    throw new ApplicationError('Mục đích sử dụng tiền không được trống.', 400, 'VALIDATION_ERROR');
  }

  if (payload.usagePurpose.trim().length < 10) {
    throw new ApplicationError('Mục đích sử dụng tiền phải tối thiểu 10 ký tự.', 400, 'VALIDATION_ERROR');
  }

  if (!payload.evidenceCid?.trim()) {
    throw new ApplicationError('CID minh chứng sử dụng tiền không được trống.', 400, 'VALIDATION_ERROR');
  }

  if (payload.requestMode !== 'NORMAL' && payload.requestMode !== 'EMERGENCY') {
    throw new ApplicationError('requestMode chỉ chấp nhận NORMAL hoặc EMERGENCY.', 400, 'VALIDATION_ERROR');
  }

  if (payload.requestMode === 'EMERGENCY' && !payload.emergencyReason?.trim()) {
    throw new ApplicationError('Chế độ EMERGENCY bắt buộc có emergencyReason.', 400, 'VALIDATION_ERROR');
  }

  if (!payload.beneficiaryBankAccount?.bankName?.trim()) {
    throw new ApplicationError('Tên ngân hàng không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  const beneficiaryAccountNumber = payload.beneficiaryBankAccount.bankAccountNumber?.trim() || '';
  if (beneficiaryAccountNumber.length < 8 || beneficiaryAccountNumber.length > 20 || !/^\d+$/.test(beneficiaryAccountNumber)) {
    throw new ApplicationError('Số tài khoản phải là chuỗi số dài 8-20 ký tự.', 400, 'VALIDATION_ERROR');
  }

  if (!payload.beneficiaryBankAccount.accountHolderName?.trim()) {
    throw new ApplicationError('Tên chủ tài khoản không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
}

/** Hàm kiểm tra quyền tạo disbursement. Mục đích: chỉ organization active mới được tạo request. */
async function ensureDisbursementCreator(userId: string): Promise<AuthUser> {
  const user = await findUserById(userId);
  if (!user) {
    throw new ApplicationError('Không tìm thấy tài khoản người dùng.', 401, 'UNAUTHENTICATED');
  }

  if (user.role !== 'organizations') {
    throw new ApplicationError('Chỉ tổ chức từ thiện được phép tạo yêu cầu rút tiền.', 403, 'FORBIDDEN');
  }

  if (user.accountStatus !== 'ACTIVE') {
    throw new ApplicationError('Tài khoản chưa được kích hoạt.', 403, 'FORBIDDEN');
  }

  return user;
}

/** Hàm kiểm tra quyền ký duyệt disbursement. Mục đích: giới hạn signer hợp lệ theo FR7. */
async function ensureDisbursementSigner(userId: string): Promise<AuthUser> {
  const user = await findUserById(userId);
  if (!user) {
    throw new ApplicationError('Không tìm thấy tài khoản người dùng.', 401, 'UNAUTHENTICATED');
  }

  const allowedRoleList = ['admin', 'organizations', 'regulatory'];
  if (!allowedRoleList.includes(user.role)) {
    throw new ApplicationError('Bạn không có quyền ký duyệt yêu cầu rút tiền.', 403, 'FORBIDDEN');
  }

  return user;
}

/** Hàm tạo kernel client từ khóa owner đã mã hóa. Mục đích: gửi UserOperation đúng Smart Account của user. */
async function getKernelClientForUser(user: AuthUser) {
  const encryptedOwnerPrivateKey = user.smartAccountOwnerEncryptedPrivateKey;
  if (!encryptedOwnerPrivateKey) {
    throw new ApplicationError('Tài khoản chưa được cấu hình Smart Account owner key.', 500, 'INTERNAL_ERROR');
  }

  try {
    return await createKernelClientFromEncryptedOwnerKey(encryptedOwnerPrivateKey);
  } catch (error) {
    logger.error('Không thể tạo Kernel client.', {
      userId: user.id,
      errorMessage: (error as Error)?.message
    });
    throw new ApplicationError('Không thể khởi tạo Smart Account để ký giao dịch.', 500, 'INTERNAL_ERROR');
  }
}

/** Hàm đồng bộ walletAddress của user với Smart Account address. Mục đích: tránh mismatch dẫn đến lỗi phân quyền on-chain. */
async function syncUserWalletAddressWithKernelAccount(
  user: AuthUser,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kernelClient: any
): Promise<KernelClientContext> {
  const kernelClientAccount = (kernelClient as { account?: { address?: `0x${string}` } }).account;
  const kernelAccountAddress = kernelClientAccount?.address;
  if (!kernelAccountAddress) {
    throw new ApplicationError('Không thể lấy Smart Account address để gửi giao dịch.', 500, 'INTERNAL_ERROR');
  }

  const normalizedKernelAccountAddress = kernelAccountAddress.toLowerCase() as `0x${string}`;
  const normalizedUserWalletAddress = String(user.walletAddress || '').trim().toLowerCase();

  if (!normalizedUserWalletAddress || normalizedUserWalletAddress === normalizedKernelAccountAddress) {
    return {
      kernelClient,
      smartAccountAddress: normalizedKernelAccountAddress,
      effectiveUser: {
        ...user,
        walletAddress: normalizedKernelAccountAddress
      }
    };
  }

  const syncedUser = await updateUser({
    ...user,
    walletAddress: normalizedKernelAccountAddress,
    updatedAt: new Date()
  });

  logger.warn('Đồng bộ walletAddress do SMART_ACCOUNT_MISMATCH.', {
    userId: user.id,
    fallbackWalletAddress: normalizedUserWalletAddress,
    smartAccountAddress: normalizedKernelAccountAddress
  });

  return {
    kernelClient,
    smartAccountAddress: normalizedKernelAccountAddress,
    effectiveUser: syncedUser
  };
}

/** Hàm tạo context Kernel client cho user. Mục đích: gom logic provision + sync địa chỉ ví vào một điểm dùng chung. */
async function getKernelClientContextForUser(user: AuthUser): Promise<KernelClientContext> {
  let userForKernelContext = user;

  if (!user.smartAccountOwnerEncryptedPrivateKey) {
    const { ensureSmartAccountProvisioned } = await import('./authService');
    const userAfterProvision = await ensureSmartAccountProvisioned(user);
    if (!userAfterProvision.smartAccountOwnerEncryptedPrivateKey) {
      throw new ApplicationError('Không thể khởi tạo Smart Account cho người dùng này.', 500, 'INTERNAL_ERROR');
    }

    userForKernelContext = userAfterProvision;
  }

  const kernelClient = await getKernelClientForUser(userForKernelContext);
  return syncUserWalletAddressWithKernelAccount(userForKernelContext, kernelClient);
}

/** Hàm kiểm tra role được quản lý signer on-chain. Mục đích: giới hạn auto-grant cho đúng các role được phép ký FR7. */
function isManagedDisbursementSignerRole(userRole: string): userRole is ManagedDisbursementSignerRole {
  return userRole === 'admin' || userRole === 'organizations' || userRole === 'regulatory';
}

/** Hàm bảo đảm role signer on-chain đã được cấp cho ví. Mục đích: tránh revert InvalidSignerRole khi mô phỏng UserOperation. */
async function ensureDisbursementSignerRoleOnChain(userRole: string, signerWalletAddress: string): Promise<void> {
  if (!isManagedDisbursementSignerRole(userRole)) {
    throw new ApplicationError('Vai trò người dùng không hợp lệ để ký duyệt giải ngân.', 403, 'FORBIDDEN');
  }

  const normalizedSignerWalletAddress = signerWalletAddress.trim();
  if (!normalizedSignerWalletAddress || !ethers.isAddress(normalizedSignerWalletAddress)) {
    throw new ApplicationError('Địa chỉ ví signer không hợp lệ để cấp quyền on-chain.', 400, 'VALIDATION_ERROR');
  }

  try {
    const { contract } = getAdminWritableMultisigContract();

    let roleHash: string;
    let grantRoleTransaction: ethers.ContractTransactionResponse;

    if (userRole === 'admin') {
      roleHash = await contract.ADMIN_SIGNER_ROLE();
      const hasAdminSignerRole = await contract.hasRole(roleHash, normalizedSignerWalletAddress);
      if (hasAdminSignerRole) {
        return;
      }

      grantRoleTransaction = await contract.grantAdminSignerRole(normalizedSignerWalletAddress);
    } else if (userRole === 'organizations') {
      roleHash = await contract.ORG_SIGNER_ROLE();
      const hasOrganizationSignerRole = await contract.hasRole(roleHash, normalizedSignerWalletAddress);
      if (hasOrganizationSignerRole) {
        return;
      }

      grantRoleTransaction = await contract.grantOrgSignerRole(normalizedSignerWalletAddress);
    } else {
      roleHash = await contract.REGULATORY_SIGNER_ROLE();
      const hasRegulatorySignerRole = await contract.hasRole(roleHash, normalizedSignerWalletAddress);
      if (hasRegulatorySignerRole) {
        return;
      }

      grantRoleTransaction = await contract.grantRegulatorySignerRole(normalizedSignerWalletAddress);
    }

    const grantRoleReceipt = await grantRoleTransaction.wait();
    if (grantRoleReceipt && Number(grantRoleReceipt.status) !== 1) {
      throw new Error(`Transaction cấp quyền signer thất bại. role=${userRole} txHash=${grantRoleTransaction.hash}`);
    }

    const hasSignerRoleAfterGrant = await contract.hasRole(roleHash, normalizedSignerWalletAddress);
    if (!hasSignerRoleAfterGrant) {
      throw new Error(`Cấp quyền signer thất bại sau khi mined. role=${userRole}`);
    }

    logger.info('Đã auto-grant signer role on-chain.', {
      role: userRole,
      walletAddress: normalizedSignerWalletAddress,
      transactionHash: grantRoleTransaction.hash
    });
  } catch (error) {
    logger.error('Không thể cấp signer role on-chain.', {
      role: userRole,
      walletAddress: normalizedSignerWalletAddress,
      errorMessage: (error as Error)?.message
    });
    throw new ApplicationError('Không thể cấp quyền giải ngân trên blockchain. Vui lòng liên hệ quản trị viên.', 502, 'INTERNAL_ERROR');
  }
}

/** Hàm map lỗi blockchain sang lỗi nghiệp vụ. Mục đích: trả thông báo rõ ràng cho FE thay vì lỗi kỹ thuật mơ hồ. */
function mapBlockchainErrorToApplicationError(error: unknown): ApplicationError | null {
  const errorMessage = String((error as Error)?.message || '').toLowerCase();

  if (errorMessage.includes('normalmoderequiresemergency') || errorMessage.includes('minimumraisednotmet')) {
    return new ApplicationError('Dự án chưa đạt ngưỡng tạo yêu cầu NORMAL. Vui lòng dùng chế độ EMERGENCY hoặc chờ thêm quyên góp.', 409, 'MINIMUM_RAISED_NOT_MET');
  }

  if (errorMessage.includes('emergencyreasonrequired')) {
    return new ApplicationError('Yêu cầu EMERGENCY bắt buộc có lý do khẩn cấp.', 400, 'VALIDATION_ERROR');
  }

  if (errorMessage.includes('duplicatebeneficiarypending') || errorMessage.includes('duplicateprojectpending')) {
    return new ApplicationError('Đã tồn tại yêu cầu giải ngân đang chờ duyệt cho dự án hoặc tài khoản thụ hưởng này.', 409, 'CONFLICT');
  }

  if (errorMessage.includes('maxwithdrawalexceeded')) {
    return new ApplicationError('Số tiền rút vượt quá hạn mức khả dụng theo chính sách reserve 20%.', 409, 'MAX_WITHDRAWAL_EXCEEDED');
  }

  if (errorMessage.includes('alreadysigned') || errorMessage.includes('rolealreadysigned')) {
    return new ApplicationError('Bạn đã ký hoặc vai trò này đã được ký trước đó.', 409, 'ALREADY_SIGNED');
  }

  if (errorMessage.includes('invalidrequeststate')) {
    return new ApplicationError('Yêu cầu không còn ở trạng thái hợp lệ để thực hiện thao tác này.', 409, 'INVALID_STATUS_TRANSITION');
  }

  if (errorMessage.includes('invalidsignerrole') || errorMessage.includes('0x2fc8c968')) {
    return new ApplicationError('Ví Smart Account của bạn chưa có quyền signer phù hợp trên blockchain. Hệ thống đã từ chối ký duyệt để đảm bảo an toàn.', 403, 'FORBIDDEN');
  }

  return null;
}

/** Hàm gọi finalizeDisbursement on-chain. Mục đích: chốt trạng thái COMPLETED và burn token sau khi chuyển khoản thành công. */
async function finalizeDisbursementOnChain(onChainRequestId: number, providerTransactionId: string): Promise<string> {
  const { contract } = getAdminWritableMultisigContract();
  const transactionIdAsUint256 = mapProviderTransactionIdToUint256(providerTransactionId);

  const submittedAtMs = Date.now();
  const finalizeTransaction = await contract.finalizeDisbursement(BigInt(onChainRequestId), transactionIdAsUint256);
  const finalizeReceipt = await finalizeTransaction.wait();

  if (!finalizeReceipt) {
    throw new Error(`Finalize disbursement không trả về transaction receipt. txHash=${finalizeTransaction.hash}`);
  }

  recordBlockchainTransaction({
    operation: 'finalize_disbursement',
    receipt: finalizeReceipt,
    startedAtMs: submittedAtMs
  });

  if (Number(finalizeReceipt.status) !== 1) {
    throw new Error(`Finalize disbursement thất bại. txHash=${finalizeTransaction.hash}`);
  }

  return String(finalizeTransaction.hash);
}

/** Hàm dựng payload nội bộ cho luồng đồng bộ trạng thái transfer. Mục đích: tái sử dụng logic xử lý webhook mà không phụ thuộc callback ngoài. */
function buildInternalTransferStatusPayload(
  requestId: string,
  transferStatusSnapshot: PayosTransferStatusSnapshot,
  fallbackTransferId: string | null
): DisbursementTransferWebhookPayload {
  const transferId = transferStatusSnapshot.transferId || fallbackTransferId || undefined;
  const transactionId = transferStatusSnapshot.providerTransactionId || transferId || undefined;
  const statusText = transferStatusSnapshot.transferStatus;

  return {
    requestId,
    transferId,
    transactionId,
    status: statusText,
    desc: transferStatusSnapshot.errorMessage || undefined,
    data: {
      requestId,
      transferId,
      transactionId,
      status: statusText,
      message: transferStatusSnapshot.errorMessage || undefined
    }
  };
}

/** Hàm đồng bộ trạng thái transfer từ PayOS theo requestId. Mục đích: chủ động kéo trạng thái payout cho record EXECUTING khi thiếu webhook. */
async function synchronizeDisbursementTransferStatusByReferenceId(requestId: string): Promise<void> {
  if (activeTransferSyncRequestIdSet.has(requestId)) {
    return;
  }

  activeTransferSyncRequestIdSet.add(requestId);
  try {
    const currentRecord = await findDisbursementByRequestId(requestId);
    if (!currentRecord) {
      return;
    }

    const isExecutableStatus = currentRecord.status === 'EXECUTING'
      || (currentRecord.status === 'APPROVED' && currentRecord.payosTransferStatus === 'PROCESSING');
    if (!isExecutableStatus) {
      return;
    }

    let transferStatusSnapshot: PayosTransferStatusSnapshot;
    try {
      transferStatusSnapshot = await getPayosTransferStatusByReferenceId(currentRecord.requestId);
    } catch (error) {
      const errorMessage = (error as Error)?.message || '';
      if (errorMessage.includes('429')) {
        logger.warn(`PayOS giới hạn tần suất query transfer, sẽ thử lại ở lượt polling sau. requestId=${requestId}`);
        return;
      }

      throw error;
    }
    if (!transferStatusSnapshot.found) {
      return;
    }

    const internalPayload = buildInternalTransferStatusPayload(
      currentRecord.requestId,
      transferStatusSnapshot,
      currentRecord.payosTransferId
    );

    await processDisbursementTransferWebhook(internalPayload, {
      skipChecksumVerify: true,
      source: 'internal_poll',
      expectedTransferIdempotencyKey: currentRecord.transferIdempotencyKey || undefined
    });
  } finally {
    activeTransferSyncRequestIdSet.delete(requestId);
  }
}

/** Hàm quét một lượt các record EXECUTING. Mục đích: tự phục hồi trạng thái transfer cho các request tồn đọng sau restart hoặc rớt callback. */
async function sweepExecutingDisbursementsOnce(): Promise<void> {
  const [allExecutingRecordList, allApprovedRecordList] = await Promise.all([
    findDisbursementsByStatus('EXECUTING'),
    findDisbursementsByStatus('APPROVED')
  ]);

  // Ghi chú logic phức tạp: giữ backward compatibility cho dữ liệu cũ có thể còn APPROVED + PROCESSING.
  // Khi đó vẫn phải quét đồng bộ PayOS để tránh request bị kẹt vô thời hạn sau restart.
  const approvedProcessingRecordList = allApprovedRecordList
    .filter(approvedRecord => approvedRecord.payosTransferStatus === 'PROCESSING');
  const recoverableRecordMap = new Map<string, DisbursementRecord>();
  for (const recoverableRecord of [...allExecutingRecordList, ...approvedProcessingRecordList]) {
    recoverableRecordMap.set(recoverableRecord.requestId, recoverableRecord);
  }

  const recoverableRecordList = Array.from(recoverableRecordMap.values());
  const batchLimitCount = readPositiveIntegerEnv(
    process.env.DISBURSEMENT_TRANSFER_SWEEP_BATCH_SIZE,
    transferStatusSweepBatchLimitCount
  );
  const executingRecordList = recoverableRecordList.slice(0, batchLimitCount);

  for (const executingRecord of executingRecordList) {
    await synchronizeDisbursementTransferStatusByReferenceId(executingRecord.requestId);
  }
}

/** Hàm khởi động polling định kỳ cho transfer status. Mục đích: đảm bảo BE luôn tự đồng bộ trạng thái payout ngay cả khi webhook không đến. */
export function startDisbursementTransferStatusSweepPolling(): void {
  if (isTransferStatusSweepStarted) {
    return;
  }

  isTransferStatusSweepStarted = true;
  const sweepIntervalMilliseconds = readPositiveIntegerEnv(
    process.env.DISBURSEMENT_TRANSFER_SWEEP_INTERVAL_MS,
    transferStatusSweepIntervalMilliseconds
  );

  void runWithWorkerContext('disbursement-transfer-sweep', async () => {
    try {
      await sweepExecutingDisbursementsOnce();
    } catch (error) {
      logger.error('Sweep transfer trạng thái thất bại.', { errorMessage: (error as Error)?.message });
    }
  });

  setInterval(() => {
    void runWithWorkerContext('disbursement-transfer-sweep', async () => {
      try {
        await sweepExecutingDisbursementsOnce();
      } catch (error) {
        logger.error('Sweep transfer định kỳ thất bại.', { errorMessage: (error as Error)?.message });
      }
    });
  }, sweepIntervalMilliseconds);
}

/**
 * Claim nguyên tử quyền finalize on-chain cho một transfer đang PROCESSING.
 * Lease cho phép tiến trình khác thu hồi claim bị bỏ dở sau khi process crash.
 */
async function claimDisbursementFinalization(
  requestId: string,
  expectedTransferIdempotencyKey?: string
): Promise<{ claimId: string; disbursement: DisbursementRecord } | null> {
  const claimId = randomUUID();
  const claimedAt = new Date();
  const expiredClaimAt = new Date(claimedAt.getTime() - FINALIZE_CLAIM_LEASE_MS);
  const condition: Record<string, unknown> = {
    status: { $in: ['APPROVED', 'EXECUTING'] },
    payosTransferStatus: { $in: ['PROCESSING', null] },
    $or: [
      { finalizeClaimId: null },
      { finalizeClaimedAt: null },
      { finalizeClaimedAt: { $lte: expiredClaimAt } }
    ]
  };

  if (expectedTransferIdempotencyKey) {
    condition.transferIdempotencyKey = expectedTransferIdempotencyKey;
  }

  const claimedDisbursement = await updateDisbursementByRequestIdWithCondition(
    requestId,
    condition,
    {
      finalizeClaimId: claimId,
      finalizeClaimedAt: claimedAt
    }
  );

  if (!claimedDisbursement) {
    return null;
  }

  return { claimId, disbursement: claimedDisbursement };
}


/** Hàm xử lý webhook chuyển khoản FR8 từ PayOS. Mục đích: xác thực checksum, cập nhật trạng thái transfer, và finalize on-chain khi nhận SUCCESS. */
export async function processDisbursementTransferWebhook(
  payload: DisbursementTransferWebhookPayload,
  options?: ProcessDisbursementTransferWebhookOptions
): Promise<DisbursementResult> {
  const skipChecksumVerify = options?.skipChecksumVerify === true;
  if (!skipChecksumVerify) {
    const checksumCandidateList = buildTransferWebhookChecksumCandidates(payload);
    const checksumVerifyResult = verifyTransferWebhookChecksumCandidates(checksumCandidateList);
    if (checksumCandidateList.length === 0 || !checksumVerifyResult.isValid) {
      logger.warn('Webhook transfer checksum không hợp lệ.', {
        checksumSource: payload.checksumSource || 'missing',
        verifyMode: checksumVerifyResult.verifyMode
      });
      throw new Error('Webhook transfer checksum không hợp lệ.');
    }
  }

  const webhookIdentifiers = extractTransferWebhookIdentifiers(payload);
  if (!webhookIdentifiers.transferId && !webhookIdentifiers.requestId) {
    throw new Error('Webhook transfer thiếu transferId hoặc requestId hợp lệ.');
  }

  let disbursementRecord = webhookIdentifiers.transferId
    ? await findDisbursementByPayosTransferId(webhookIdentifiers.transferId)
    : null;

  if (!disbursementRecord && webhookIdentifiers.requestId) {
    disbursementRecord = await findDisbursementByRequestId(webhookIdentifiers.requestId);
  }

  if (!disbursementRecord) {
    throw new Error('Không tìm thấy disbursement theo transferId hoặc requestId.');
  }

  if (
    disbursementRecord.status !== 'APPROVED'
    && disbursementRecord.status !== 'EXECUTING'
    && disbursementRecord.status !== 'COMPLETED'
  ) {
    return mapDisbursementRecordToResult(disbursementRecord);
  }

  if (disbursementRecord.status === 'COMPLETED' && disbursementRecord.payosTransferStatus === 'SUCCESS') {
    return mapDisbursementRecordToResult(disbursementRecord);
  }

  if (
    options?.expectedTransferIdempotencyKey
    && (
      disbursementRecord.transferIdempotencyKey !== options.expectedTransferIdempotencyKey
      || disbursementRecord.payosTransferStatus !== 'PROCESSING'
      || (disbursementRecord.status !== 'APPROVED' && disbursementRecord.status !== 'EXECUTING')
    )
  ) {
    // Không cho internal poll cũ finalize khi action khác đã rotate key hoặc đổi state.
    logger.warn('Bỏ qua internal transfer result vì idempotency key/state không còn khớp.', {
      requestId: disbursementRecord.requestId,
      source: options.source,
      expectedTransferIdempotencyKey: options.expectedTransferIdempotencyKey
    });
    return mapDisbursementRecordToResult(disbursementRecord);
  }

  const webhookData = normalizeTransferWebhookData(payload.data);
  const primaryWebhookTransaction = extractPrimaryTransferWebhookTransaction(webhookData);
  const rawWebhookStatus = String(
    (primaryWebhookTransaction ? primaryWebhookTransaction.state : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.status : undefined)
    || (primaryWebhookTransaction ? primaryWebhookTransaction.approvalState : undefined)
    || webhookData.state
    || webhookData.status
    || webhookData.approvalState
    || payload.status
    || ''
  );
  const normalizedTransferStatus = mapTransferWebhookStatus(rawWebhookStatus);

  if (normalizedTransferStatus === 'PROCESSING') {
    const processingRecord = await updateDisbursementByRequestId(disbursementRecord.requestId, {
      status: 'EXECUTING',
      payosTransferStatus: 'PROCESSING',
      payosTransferId: webhookIdentifiers.transferId || disbursementRecord.payosTransferId,
      payosTransferLastError: null
    });

    return mapDisbursementRecordToResult(processingRecord || disbursementRecord);
  }

  if (normalizedTransferStatus === 'FAILED') {
    const manualReviewReason = sanitizeProviderError(toNullableString(
      payload.desc
      || webhookData.desc
      || webhookData.message
      || (primaryWebhookTransaction ? primaryWebhookTransaction.message : undefined)
      || (primaryWebhookTransaction ? primaryWebhookTransaction.errorMessage : undefined)
    ))
      || 'PayOS transfer trả về trạng thái thất bại.';
    const manualReviewRecord = await updateDisbursementByRequestIdWithCondition(
      disbursementRecord.requestId,
      {
        status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
        payosTransferStatus: { $nin: ['SUCCESS', 'FAILED'] }
      },
      {
        status: 'APPROVED',
        payosTransferStatus: 'MANUAL_REVIEW',
        payosTransferId: webhookIdentifiers.transferId || disbursementRecord.payosTransferId,
        payosTransferLastError: manualReviewReason,
        transferIdempotencyKey: disbursementRecord.transferIdempotencyKey || buildTransferIdempotencyKey(disbursementRecord.requestId),
        finalizeClaimId: null,
        finalizeClaimedAt: null
      }
    );

    // Dọn dẹp các job đang chờ để tránh duplicate transfer sau khi chuyển manual review
    await removePendingJobsByRequestId(disbursementRecord.requestId);

    if (manualReviewRecord) {
      await emitDisbursementNotification(manualReviewRecord);
      await openManualReviewQueueForDisbursement({
        disbursement: manualReviewRecord,
        reason: manualReviewReason,
        retryCount: manualReviewRecord.payosTransferAttemptCount,
        source: 'payos_webhook_failed'
      });
    }

    return mapDisbursementRecordToResult(manualReviewRecord || disbursementRecord);
  }

  const finalizationClaim = await claimDisbursementFinalization(
    disbursementRecord.requestId,
    options?.expectedTransferIdempotencyKey
  );
  if (!finalizationClaim) {
    const currentRecord = await findDisbursementByRequestId(disbursementRecord.requestId);
    if (currentRecord) {
      logger.warn('Bỏ qua finalize vì disbursement đã có caller khác giữ claim.', {
        requestId: disbursementRecord.requestId,
        source: options?.source
      });
      return mapDisbursementRecordToResult(currentRecord);
    }

    throw new ApplicationError('Không tìm thấy disbursement sau khi claim finalize.', 500, 'INTERNAL_ERROR');
  }

  const { claimId, disbursement: claimedDisbursement } = finalizationClaim;
  const claimedProviderTransactionId = webhookIdentifiers.providerTransactionId
    || claimedDisbursement.payosTransferId
    || claimedDisbursement.requestId;

  try {
    const finalizeTransactionHash = await finalizeDisbursementOnChain(
      claimedDisbursement.onChainRequestId,
      claimedProviderTransactionId
    );

    const completedRecord = await updateDisbursementByRequestIdWithCondition(
      disbursementRecord.requestId,
      {
        status: { $in: ['APPROVED', 'EXECUTING'] },
        payosTransferStatus: 'PROCESSING',
        finalizeClaimId: claimId
      },
      {
        status: 'COMPLETED',
        payosTransferStatus: 'SUCCESS',
        payosTransferId: webhookIdentifiers.transferId || disbursementRecord.payosTransferId,
        transferIdempotencyKey: disbursementRecord.transferIdempotencyKey || buildTransferIdempotencyKey(disbursementRecord.requestId),
        finalizeTransactionHash,
        transactionHash: finalizeTransactionHash,
        completedAt: new Date(),
        payosTransferLastError: null,
        finalizeClaimId: null,
        finalizeClaimedAt: null
      }
    );

    if (!completedRecord) {
      const currentRecord = await findDisbursementByRequestId(disbursementRecord.requestId);
      if (currentRecord) {
        logger.warn('Bỏ qua cập nhật COMPLETED vì disbursement đã được resolve bởi luồng khác.', {
          requestId: disbursementRecord.requestId,
          currentStatus: currentRecord.status,
          currentPayosTransferStatus: currentRecord.payosTransferStatus
        });
        return mapDisbursementRecordToResult(currentRecord);
      }

      throw new ApplicationError('Không thể cập nhật trạng thái COMPLETED sau khi finalize.', 500, 'INTERNAL_ERROR');
    }

    logger.info(
      `Webhook transfer SUCCESS đã finalize on-chain. requestId=${completedRecord.requestId} transferId=${completedRecord.payosTransferId || ''} txHash=${finalizeTransactionHash}`
    );

    // Dọn dẹp các job đang chờ để tránh duplicate transfer sau khi finalize thành công
    await emitDisbursementNotification(completedRecord);
    await removePendingJobsByRequestId(completedRecord.requestId);

    return mapDisbursementRecordToResult(completedRecord);
  } catch (error) {
    const errorMessage = sanitizeProviderError((error as Error)?.message || null) || 'Không xác định';
    const manualReviewRecord = await updateDisbursementByRequestIdWithCondition(
      disbursementRecord.requestId,
      {
        status: { $nin: ['COMPLETED', 'REJECTED', 'CANCELLED'] },
        payosTransferStatus: { $nin: ['SUCCESS', 'FAILED'] },
        finalizeClaimId: claimId
      },
      {
        status: 'APPROVED',
        payosTransferStatus: 'MANUAL_REVIEW',
        payosTransferId: webhookIdentifiers.transferId || disbursementRecord.payosTransferId,
        payosTransferLastError: `Finalize thất bại sau webhook SUCCESS: ${errorMessage}`,
        transferIdempotencyKey: disbursementRecord.transferIdempotencyKey || buildTransferIdempotencyKey(disbursementRecord.requestId),
        finalizeClaimId: null,
        finalizeClaimedAt: null
      }
    );

    if (manualReviewRecord) {
      await emitDisbursementNotification(manualReviewRecord);
      await removePendingJobsByRequestId(manualReviewRecord.requestId);
      await openManualReviewQueueForDisbursement({
        disbursement: manualReviewRecord,
        reason: `Finalize thất bại sau webhook SUCCESS: ${errorMessage}`,
        retryCount: manualReviewRecord.payosTransferAttemptCount,
        source: 'finalize_failed'
      });
      return mapDisbursementRecordToResult(manualReviewRecord);
    }

    const currentRecord = await findDisbursementByRequestId(disbursementRecord.requestId);
    if (currentRecord) {
      logger.warn('Bỏ qua chuyển MANUAL_REVIEW sau finalize failure vì disbursement đã được resolve bởi luồng khác.', {
        requestId: disbursementRecord.requestId,
        currentStatus: currentRecord.status,
        currentPayosTransferStatus: currentRecord.payosTransferStatus
      });
      return mapDisbursementRecordToResult(currentRecord);
    }

    throw new ApplicationError('Không thể cập nhật trạng thái MANUAL_REVIEW sau lỗi finalize.', 500, 'INTERNAL_ERROR');
  }
}

// ============ UC7.1: CREATE REQUEST ============

/** Hàm tạo yêu cầu rút tiền FR7. Mục đích: validate, ghi on-chain theo ABI mới và lưu record off-chain đồng bộ. */
export async function createDisbursementRequest(
  userId: string,
  payload: CreateDisbursementPayload
): Promise<DisbursementResult> {
  validateCreateDisbursementPayload(payload);
  const user = await ensureDisbursementCreator(userId);
  const {
    kernelClient,
    smartAccountAddress: organizationSmartAccountAddress,
    effectiveUser
  } = await getKernelClientContextForUser(user);

  const project = await findProjectById(payload.projectId);
  if (!project) {
    throw new ApplicationError('Không tìm thấy dự án.', 404, 'NOT_FOUND');
  }

  if (project.organizationId !== user.id) {
    throw new ApplicationError('Bạn không có quyền tạo yêu cầu cho dự án này.', 403, 'FORBIDDEN');
  }

  if (project.status !== 'ACTIVE') {
    throw new ApplicationError('Dự án phải ở trạng thái ACTIVE mới được rút tiền.', 409, 'INVALID_STATUS_TRANSITION');
  }

  const { contractAddress, contract: readOnlyContract } = getReadOnlyMultisigContract();
  const onChainProjectId = Number(project.projectId);

  let maxWithdrawableAmountAsBigInt: bigint;
  try {
    maxWithdrawableAmountAsBigInt = await readOnlyContract.getMaxWithdrawableAmount(onChainProjectId);
  } catch {
    throw new ApplicationError('Không thể lấy số dư khả dụng từ blockchain.', 502, 'INTERNAL_ERROR');
  }

  if (BigInt(payload.amount) > maxWithdrawableAmountAsBigInt) {
    throw new ApplicationError(
      `Số tiền vượt quá khả dụng. Tối đa: ${maxWithdrawableAmountAsBigInt.toString()} token.`,
      409,
      'MAX_WITHDRAWAL_EXCEEDED'
    );
  }

  const existingPendingRecord = await findPendingDisbursementByBeneficiary(organizationSmartAccountAddress);
  if (existingPendingRecord) {
    throw new ApplicationError(
      `Tài khoản đã có yêu cầu rút tiền đang chờ duyệt (${existingPendingRecord.requestId}). Vui lòng chờ xử lý hoàn tất.`,
      409,
      'DUPLICATE_BENEFICIARY_PENDING'
    );
  }

  await ensureDisbursementSignerRoleOnChain(effectiveUser.role, organizationSmartAccountAddress);

  let requestCreatedEventData: RequestCreatedEventData;
  try {
    const encodedCallData = encodeFunctionData({
      abi: multisigContractAbiViem,
      functionName: 'createDisbursementRequest',
      args: [
        BigInt(onChainProjectId),
        organizationSmartAccountAddress,
        BigInt(payload.amount),
        BigInt(project.goalAmount),
        payload.evidenceCid,
        mapRequestModeToContractValue(payload.requestMode),
        (payload.emergencyReason || '').trim()
      ]
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transactionHash = await (kernelClient as any).sendTransaction({
      to: contractAddress as `0x${string}`,
      data: encodedCallData,
      value: BigInt(0)
    }) as `0x${string}`;

    const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const receipt = await provider.waitForTransaction(transactionHash);

    if (!receipt) {
      throw new Error('Không nhận được receipt từ blockchain.');
    }

    requestCreatedEventData = parseRequestCreatedEvent(receipt.logs);
  } catch (error) {
    const mappedError = mapBlockchainErrorToApplicationError(error);
    if (mappedError) {
      throw mappedError;
    }

    logger.error('Tạo disbursement on-chain thất bại.', { errorMessage: (error as Error)?.message });
    throw new ApplicationError('Không thể tạo yêu cầu rút tiền trên blockchain.', 502, 'INTERNAL_ERROR');
  }

  const currentTimestamp = new Date();
  const newRecord: DisbursementRecord = {
    requestId: `DS-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`,
    onChainRequestId: requestCreatedEventData.onChainRequestId,
    projectId: payload.projectId,
    onChainProjectId,
    organizationId: effectiveUser.id,
    requestMode: requestCreatedEventData.requestMode,
    emergencyReason: requestCreatedEventData.requestMode === 'EMERGENCY' ? (payload.emergencyReason || '').trim() || null : null,
    requiredApprovals: requestCreatedEventData.requiredApprovals,
    raisedRatioBpsAtCreation: requestCreatedEventData.raisedRatioBpsAtCreation,
    beneficiaryWalletAddress: organizationSmartAccountAddress,
    beneficiaryBankAccount: payload.beneficiaryBankAccount,
    amount: payload.amount,
    usagePurpose: payload.usagePurpose.trim(),
    evidenceCid: payload.evidenceCid,
    status: 'PENDING',
    approvals: [],
    rejection: null,
    timeoutDeadline: requestCreatedEventData.timeoutDeadline,
    payosTransferId: null,
    payosTransferStatus: null,
    payosTransferAttemptCount: 0,
    payosTransferLastError: null,
    transferIdempotencyKey: null,
    transactionHash: null,
    finalizeTransactionHash: null,
    createdAt: currentTimestamp,
    updatedAt: currentTimestamp,
    expiredAt: requestCreatedEventData.timeoutDeadline,
    completedAt: null
  };

  const createdRecord = await createDisbursementRecord(newRecord);
  logger.info(`Đã tạo disbursement record. requestId=${createdRecord.requestId} onChainRequestId=${createdRecord.onChainRequestId}`);
  return mapDisbursementRecordToResult(createdRecord);
}

// ============ UC7.2: SIGN REQUEST ============

/** Hàm ký duyệt request FR7. Mục đích: ghi chữ ký on-chain, đồng bộ trạng thái, và trigger auto-transfer FR8 khi đủ ngưỡng. */
export async function signDisbursementRequest(
  userId: string,
  requestId: string,
  comment?: string
): Promise<DisbursementResult> {
  const user = await ensureDisbursementSigner(userId);
  const {
    kernelClient,
    smartAccountAddress: signerSmartAccountAddress,
    effectiveUser
  } = await getKernelClientContextForUser(user);

  await ensureDisbursementSignerRoleOnChain(effectiveUser.role, signerSmartAccountAddress);

  const record = await findDisbursementByRequestId(requestId);
  if (!record) {
    throw new ApplicationError('Không tìm thấy yêu cầu rút tiền.', 404, 'NOT_FOUND');
  }

  if (record.status !== 'PENDING') {
    throw new ApplicationError('Yêu cầu không còn ở trạng thái chờ duyệt.', 409, 'INVALID_STATUS_TRANSITION');
  }

  if (record.timeoutDeadline && new Date() > record.timeoutDeadline) {
    await updateDisbursementByRequestId(requestId, { status: 'EXPIRED' });
    throw new ApplicationError('Yêu cầu đã hết hạn (7 ngày không đủ chữ ký).', 409, 'REQUEST_EXPIRED');
  }

  const signerRole = mapSignerRole(effectiveUser.role);
  if (!signerRole) {
    throw new ApplicationError('Vai trò không hợp lệ để ký duyệt.', 403, 'FORBIDDEN');
  }

  const wasRoleAlreadySigned = record.approvals.some(approvalItem => approvalItem.signerRole === signerRole);
  if (wasRoleAlreadySigned) {
    throw new ApplicationError('Vai trò của bạn đã ký duyệt yêu cầu này.', 409, 'ALREADY_SIGNED');
  }

  const { contractAddress, contract: readOnlyContract } = getReadOnlyMultisigContract();
  let transactionHash: string;

  try {
    const encodedCallData = encodeFunctionData({
      abi: multisigContractAbiViem,
      functionName: 'signRequest',
      args: [BigInt(record.onChainRequestId)]
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionHash = await (kernelClient as any).sendTransaction({
      to: contractAddress as `0x${string}`,
      data: encodedCallData,
      value: BigInt(0)
    }) as string;

    const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    await provider.waitForTransaction(transactionHash);
  } catch (error) {
    const mappedError = mapBlockchainErrorToApplicationError(error);
    if (mappedError) {
      throw mappedError;
    }

    logger.error('Ký duyệt disbursement on-chain thất bại.', { errorMessage: (error as Error)?.message });
    throw new ApplicationError('Không thể ký duyệt trên blockchain.', 502, 'INTERNAL_ERROR');
  }

  let syncedStatus: DisbursementStatus = record.status;
  let syncedRequiredApprovals = record.requiredApprovals;
  let syncedTimeoutDeadline = record.timeoutDeadline;

  try {
    const onChainRequestData = await readOnlyContract.getRequest(record.onChainRequestId) as unknown[];
    syncedStatus = mapOnChainStatusToDisbursementStatus(Number(onChainRequestData[5]));
    syncedRequiredApprovals = Number(onChainRequestData[17]);
    syncedTimeoutDeadline = new Date(Number(onChainRequestData[14]) * 1000);
  } catch {
    logger.warn('Không thể đọc trạng thái on-chain sau khi ký.', { requestId });
  }

  const updatedApprovals = [
    ...record.approvals,
    {
      signerRole,
      signerUserId: effectiveUser.id,
      signerAddress: signerSmartAccountAddress,
      transactionHash,
      signedAt: new Date(),
      comment
    }
  ];

  const updatedRecord = await updateDisbursementByRequestId(requestId, {
    approvals: updatedApprovals,
    status: syncedStatus,
    requiredApprovals: syncedRequiredApprovals,
    timeoutDeadline: syncedTimeoutDeadline,
    transactionHash
  });

  if (!updatedRecord) {
    throw new ApplicationError('Không thể cập nhật trạng thái ký duyệt.', 500, 'INTERNAL_ERROR');
  }

  await createDisbursementSignatureNotification(updatedRecord, signerRole);

  if (updatedRecord.status === 'APPROVED') {
    void triggerPayosTransferForApprovedDisbursement(updatedRecord.requestId)
      .catch(error => {
        logger.error('Trigger auto-transfer thất bại.', {
          requestId: updatedRecord.requestId,
          errorMessage: (error as Error)?.message
        });
      });
  }

  return mapDisbursementRecordToResult(updatedRecord);
}

/** Hàm từ chối request FR7. Mục đích: gọi reject on-chain và đồng bộ trạng thái REJECTED ở MongoDB. */
export async function rejectDisbursementRequest(
  userId: string,
  requestId: string,
  reason: string
): Promise<DisbursementResult> {
  const user = await ensureDisbursementSigner(userId);
  const {
    kernelClient,
    smartAccountAddress: signerSmartAccountAddress,
    effectiveUser
  } = await getKernelClientContextForUser(user);

  await ensureDisbursementSignerRoleOnChain(effectiveUser.role, signerSmartAccountAddress);

  if (!reason || reason.trim().length < 5) {
    throw new ApplicationError('Lý do từ chối phải tối thiểu 5 ký tự.', 400, 'VALIDATION_ERROR');
  }

  const record = await findDisbursementByRequestId(requestId);
  if (!record) {
    throw new ApplicationError('Không tìm thấy yêu cầu rút tiền.', 404, 'NOT_FOUND');
  }

  if (record.status !== 'PENDING') {
    throw new ApplicationError('Yêu cầu không còn ở trạng thái chờ duyệt.', 409, 'INVALID_STATUS_TRANSITION');
  }

  if (effectiveUser.role === 'organizations' && record.organizationId === effectiveUser.id) {
    throw new ApplicationError('Tổ chức không được tự từ chối yêu cầu rút tiền của chính mình.', 403, 'FORBIDDEN');
  }

  const signerRole = mapSignerRole(effectiveUser.role);
  if (!signerRole) {
    throw new ApplicationError('Vai trò không hợp lệ để từ chối yêu cầu.', 403, 'FORBIDDEN');
  }

  const { contractAddress } = getReadOnlyMultisigContract();
  let transactionHash: string;
  try {
    const encodedCallData = encodeFunctionData({
      abi: multisigContractAbiViem,
      functionName: 'rejectRequest',
      args: [BigInt(record.onChainRequestId), reason.trim()]
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionHash = await (kernelClient as any).sendTransaction({
      to: contractAddress as `0x${string}`,
      data: encodedCallData,
      value: BigInt(0)
    }) as string;

    const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    await provider.waitForTransaction(transactionHash);
  } catch (error) {
    const mappedError = mapBlockchainErrorToApplicationError(error);
    if (mappedError) {
      throw mappedError;
    }

    logger.error('Từ chối disbursement on-chain thất bại.', { errorMessage: (error as Error)?.message });
    throw new ApplicationError('Không thể từ chối trên blockchain.', 502, 'INTERNAL_ERROR');
  }

  const updatedRecord = await updateDisbursementByRequestId(requestId, {
    status: 'REJECTED',
    rejection: {
      signerRole,
      signerUserId: effectiveUser.id,
      signerAddress: signerSmartAccountAddress,
      reason: reason.trim(),
      rejectedAt: new Date()
    },
    transactionHash,
    payosTransferStatus: null,
    payosTransferLastError: null
  });

  if (!updatedRecord) {
    throw new ApplicationError('Không thể cập nhật trạng thái từ chối.', 500, 'INTERNAL_ERROR');
  }

  return mapDisbursementRecordToResult(updatedRecord);
}

// ============ QUERY FUNCTIONS ============

/** Hàm lấy danh sách yêu cầu của tổ chức. Mục đích: cấp dữ liệu thật cho tab quản lý giải ngân phía organization. */
export async function getDisbursementsForOrganization(userId: string): Promise<DisbursementResult[]> {
  const user = await ensureDisbursementCreator(userId);
  const recordList = await findDisbursementsByOrganizationId(user.id);
  return recordList.map(mapDisbursementRecordToResult);
}

/** Hàm lấy danh sách chờ ký duyệt. Mục đích: cấp dữ liệu thật cho dashboard admin/regulatory. */
export async function getDisbursementsForReview(userId: string): Promise<DisbursementResult[]> {
  await ensureDisbursementSigner(userId);
  const recordList = await findDisbursementsByStatus('PENDING');
  return recordList.map(mapDisbursementRecordToResult);
}

/** Hàm lấy summary cho dashboard ký duyệt. Mục đích: FE /admin và /regulatory-bodies hiển thị bảng urgent không dùng mock. */
export async function getDisbursementRequestSummaries(userId: string): Promise<DisbursementRequestSummary[]> {
  await ensureDisbursementSigner(userId);
  const pendingRecordList = await findDisbursementsByStatus('PENDING');

  const summaryList = await Promise.all(pendingRecordList.map(async record => {
    const [project, organizationUser] = await Promise.all([
      findProjectById(record.projectId),
      findUserById(record.organizationId)
    ]);

    const deadlineDate = record.timeoutDeadline || record.expiredAt || new Date(record.createdAt.getTime() + (7 * 24 * 60 * 60 * 1000));
    const firstEvidenceCid = record.evidenceCid.split(',').map(cid => cid.trim()).find(cid => cid.length > 0) || '';

    return {
      id: record.requestId,
      projectName: project?.name || record.projectId,
      organizationName: organizationUser?.organizationName || organizationUser?.fullName || record.organizationId,
      amount: record.amount,
      requiredSignatures: record.requiredApprovals,
      currentSignatures: record.approvals.length,
      deadlineTimestamp: deadlineDate.getTime(),
      usagePurpose: record.usagePurpose,
      ipfsCid: firstEvidenceCid,
      fileName: 'Tài liệu minh chứng giải ngân',
      requestMode: record.requestMode
    };
  }));

  return summaryList;
}

/** Hàm lấy nhật ký ký duyệt gần nhất từ dữ liệu giải ngân thật để hiển thị bảng audit trên dashboard. */
export async function getLatestDisbursementApprovalLogs(
  userId: string,
  limitCount = 20
): Promise<DisbursementApprovalLog[]> {
  await ensureDisbursementSigner(userId);

  const normalizedLimitCount = Number.isFinite(limitCount)
    ? Math.max(1, Math.min(100, Math.floor(limitCount)))
    : 20;

  // Ghi chú logic phức tạp: một request có thể sinh nhiều bản ghi ký duyệt, nên cần fetch rộng hơn
  // để sau khi flatten + sắp xếp vẫn còn đủ số lượng bản ghi theo limit trả về cho frontend.
  const disbursementRecordList = await findLatestDisbursements(Math.max(normalizedLimitCount * 3, 30));
  const organizationNameCacheMap = new Map<string, string>();
  const approvalLogWithSortValueList: DisbursementApprovalLogWithSortValue[] = [];

  for (const disbursementRecord of disbursementRecordList) {
    for (let approvalIndex = 0; approvalIndex < disbursementRecord.approvals.length; approvalIndex += 1) {
      const approvalItem = disbursementRecord.approvals[approvalIndex];
      const approvalTransactionHash = approvalItem.transactionHash || disbursementRecord.transactionHash || null;
      const signedAtDate = new Date(approvalItem.signedAt);
      const signedAtTimestamp = signedAtDate.getTime();
      if (!Number.isFinite(signedAtTimestamp)) {
        continue;
      }

      approvalLogWithSortValueList.push({
        id: `${disbursementRecord.requestId}-sign-${approvalItem.signerRole}-${signedAtTimestamp}-${approvalIndex}`,
        requestId: disbursementRecord.requestId,
        transactionHash: approvalTransactionHash,
        amount: disbursementRecord.amount,
        status: 'SIGNED',
        actor: mapSignerRoleToApprovalActor(approvalItem.signerRole),
        actionTimestamp: signedAtTimestamp,
        actionTimestampValue: signedAtTimestamp
      });
    }

    if (disbursementRecord.rejection) {
      const transactionHash = disbursementRecord.finalizeTransactionHash || disbursementRecord.transactionHash || null;
      const rejectedAtDate = new Date(disbursementRecord.rejection.rejectedAt);
      const rejectedAtTimestamp = rejectedAtDate.getTime();
      if (Number.isFinite(rejectedAtTimestamp)) {
        approvalLogWithSortValueList.push({
          id: `${disbursementRecord.requestId}-reject-${rejectedAtTimestamp}`,
          requestId: disbursementRecord.requestId,
          transactionHash,
          amount: disbursementRecord.amount,
          status: 'REJECTED',
          actor: mapSignerRoleToApprovalActor(disbursementRecord.rejection.signerRole),
          actionTimestamp: rejectedAtTimestamp,
          actionTimestampValue: rejectedAtTimestamp
        });
      }
    }

    if (disbursementRecord.approvals.length === 0 && !disbursementRecord.rejection) {
      const transactionHash = disbursementRecord.finalizeTransactionHash || disbursementRecord.transactionHash || null;
      const createdAtDate = new Date(disbursementRecord.createdAt);
      const createdAtTimestamp = createdAtDate.getTime();

      if (Number.isFinite(createdAtTimestamp)) {
        const organizationDisplayName = await resolveOrganizationDisplayNameForApprovalLog(
          disbursementRecord.organizationId,
          organizationNameCacheMap
        );

        approvalLogWithSortValueList.push({
          id: `${disbursementRecord.requestId}-pending-${createdAtTimestamp}`,
          requestId: disbursementRecord.requestId,
          transactionHash,
          amount: disbursementRecord.amount,
          status: mapDisbursementStatusToApprovalLogStatus(disbursementRecord.status),
          actor: organizationDisplayName,
          actionTimestamp: createdAtTimestamp,
          actionTimestampValue: createdAtTimestamp
        });
      }
    }
  }

  return approvalLogWithSortValueList
    .sort((leftApprovalLogItem, rightApprovalLogItem) => rightApprovalLogItem.actionTimestampValue - leftApprovalLogItem.actionTimestampValue)
    .slice(0, normalizedLimitCount)
    .map((item) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { actionTimestampValue: _actionTimestampValue, ...approvalLogItem } = item;
      return approvalLogItem;
    });
}

/** Hàm lấy chi tiết request. Mục đích: cấp dữ liệu thật cho drawer chi tiết ký duyệt. */
export async function getDisbursementDetail(userId: string, requestId: string): Promise<DisbursementResult> {
  await ensureDisbursementSigner(userId);
  const record = await findDisbursementByRequestId(requestId);

  if (!record) {
    throw new ApplicationError('Không tìm thấy yêu cầu rút tiền.', 404, 'NOT_FOUND');
  }

  return mapDisbursementRecordToResult(record);
}

/** Hàm lấy lịch sử theo project. Mục đích: hỗ trợ trang chi tiết dự án hiển thị các lần giải ngân thật. */
export async function getDisbursementsByProject(projectId: string): Promise<DisbursementResult[]> {
  const recordList = await findDisbursementsByProjectId(projectId);
  return recordList.map(mapDisbursementRecordToResult);
}

/** Hàm lấy hạn mức rút tối đa. Mục đích: FE hiển thị rule reserve 20% đúng dữ liệu blockchain. */
export async function getMaxWithdrawableAmount(projectId: string): Promise<{ projectId: string; maxAmount: string; reserve: string }> {
  const project = await findProjectById(projectId);
  if (!project) {
    throw new ApplicationError('Không tìm thấy dự án.', 404, 'NOT_FOUND');
  }

  const { contract: readOnlyContract } = getReadOnlyMultisigContract();
  const onChainProjectId = Number(project.projectId);

  let maxAmountAsBigInt: bigint;
  try {
    maxAmountAsBigInt = await readOnlyContract.getMaxWithdrawableAmount(onChainProjectId);
  } catch {
    throw new ApplicationError('Không thể lấy số dư khả dụng.', 502, 'INTERNAL_ERROR');
  }

  return {
    projectId,
    maxAmount: maxAmountAsBigInt.toString(),
    reserve: '20%'
  };
}
