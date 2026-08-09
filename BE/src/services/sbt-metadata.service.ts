import { getReadOnlyImpactSbtContract, getWritableImpactSbtContract } from '../config/sbtContract';
import { getLogger } from '../config/logger';
import type { Contract } from 'ethers';
import { SBT_MINT_CONFIRMATION_BLOCKS } from '../constants/sbtMint';
import {
  SBT_TERMINAL_STATUSES,
  SBT_TOKEN_STATUS_TO_UINT8,
  type SbtTokenStatusName,
  toSbtTokenStatusName
} from '../constants/sbtTokenStatus';
import {
  countImpactSbtByProjectId,
  findImpactSbtMetadataByProjectId,
  findImpactSbtMetadataByTokenId,
  updateImpactSbtOnChainStatus,
  type ImpactSbtMetadataRecord
} from '../models/impactSbtMetadataModel';
import { ApplicationError } from '../utils/applicationError';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';
import {
  buildIpfsGatewayUrl,
  fetchJsonFromIpfs,
  IpfsGatewayError
} from '../utils/ipfsGateway';
import {
  getSbtTokenCache,
  getSbtTokenNotFoundCache,
  invalidateSbtTokenCache,
  setSbtTokenCache,
  setSbtTokenNotFoundCache
} from './sbtMetadataCacheService';

const logger = getLogger();
const SBT_RPC_READ_TIMEOUT_MS = 5_000;
const MAX_STATUS_UPDATE_GAS = 200_000n;
const MAX_STATUS_REASON_LENGTH = 200;
const MAX_PAGE_NUMBER = 500;
let orphanedRpcPromiseCount = 0;

type NumericValue = bigint | number;

type SbtReadContract = Contract & {
  getTokenMetadata(tokenId: number): Promise<readonly [NumericValue, NumericValue, NumericValue, string, string, NumericValue]>;
  getTokenStatus(tokenId: number): Promise<NumericValue>;
};

interface SbtTransactionReceipt {
  status: number | null;
  blockNumber: number;
}

interface SbtTransactionResponse {
  hash: string;
  wait(confirmations: number): Promise<SbtTransactionReceipt | null>;
}

interface SbtStatusContractMethod {
  (...args: unknown[]): Promise<SbtTransactionResponse>;
  estimateGas(...args: unknown[]): Promise<bigint>;
}

type SbtWriteContract = SbtReadContract & {
  updateTokenStatus: SbtStatusContractMethod;
};

export interface SbtGalleryEntry {
  onChainTokenId: number | null;
  projectId: string;
  milestone: number;
  beneficiaryCount: number;
  imageCid: string;
  imageGatewayUrl: string | null;
  onChainTokenStatus: SbtTokenStatusName | null;
  confirmedAt: Date | null;
}

export interface SbtListResult {
  entries: SbtGalleryEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface SbtTokenDetail {
  onChainTokenId: number;
  onChain: {
    projectId: number;
    milestone: number;
    beneficiaryCount: number;
    gpsCoordinates: string;
    imageCID: string;
    mintedAt: Date;
    tokenStatus: SbtTokenStatusName | null;
  };
  offChain: SbtPublicOffChainDetail | null;
  imageGatewayUrl: string | null;
  ipfsMetadata: unknown;
  ipfsError: string | null;
  cached: boolean;
}

export interface SbtPublicOffChainDetail {
  projectId: string;
  milestone: number;
  beneficiaryCount: number;
  imageCid: string;
  tokenUri: string;
  confirmedAt: Date | null;
}

export interface SbtStatusUpdateResult {
  tokenId: number;
  newStatus: SbtTokenStatusName;
  isIrreversible: boolean;
  transactionHash: string;
  blockNumber: number;
  auditWarning: 'OFF_CHAIN_RECORD_NOT_FOUND' | 'OFF_CHAIN_SYNC_FAILED' | null;
}

/** Chuẩn hóa page/limit ở service để các caller nội bộ không thể vượt giới hạn API. */
function normalizePagination(page: number, limit: number): { page: number; limit: number } {
  const normalizedPage = Number.isInteger(page) && page > 0 ? Math.min(page, MAX_PAGE_NUMBER) : 1;
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 20;
  return { page: normalizedPage, limit: normalizedLimit };
}

/** Dựng URL gateway cho gallery nhưng degrade an toàn nếu dữ liệu CID trong Mongo bị lỗi. */
function tryBuildIpfsGatewayUrl(cid: string): string | null {
  try {
    return buildIpfsGatewayUrl(cid);
  } catch (error) {
    logger.warn('CID IPFS của SBT không hợp lệ, bỏ qua image gateway URL.', {
      errorCode: error instanceof IpfsGatewayError ? error.code : 'IPFS_UNAVAILABLE'
    });
    return null;
  }
}

/** Chuyển metadata record sang DTO gallery, không trả các field lifecycle mint không cần cho màn hình public. */
function toGalleryEntry(record: ImpactSbtMetadataRecord): SbtGalleryEntry {
  return {
    onChainTokenId: record.onChainTokenId ?? null,
    projectId: record.projectId,
    milestone: record.milestone,
    beneficiaryCount: record.beneficiaryCount,
    imageCid: record.imageCid,
    imageGatewayUrl: record.imageCid ? tryBuildIpfsGatewayUrl(record.imageCid) : null,
    onChainTokenStatus: record.onChainTokenStatus ?? null,
    confirmedAt: record.confirmedAt
  };
}

/** Chọn metadata off-chain công khai, loại bỏ ID vận hành, địa chỉ ví và thông tin retry khỏi public API. */
function toOffChainDetail(record: ImpactSbtMetadataRecord | null): SbtPublicOffChainDetail | null {
  if (!record) return null;

  return {
    projectId: record.projectId,
    milestone: record.milestone,
    beneficiaryCount: record.beneficiaryCount,
    imageCid: record.imageCid,
    tokenUri: record.tokenUri,
    confirmedAt: record.confirmedAt
  };
}

/** Kiểm tra object động trước khi đọc cache để không tin mù quáng vào dữ liệu Redis. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Lọc lại phần off-chain từ cache theo đúng allowlist public, kể cả khi cache cũ còn field nội bộ. */
function sanitizeCachedOffChain(value: unknown): SbtPublicOffChainDetail | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;

  const projectId = value.projectId;
  const milestone = value.milestone;
  const beneficiaryCount = value.beneficiaryCount;
  const imageCid = value.imageCid;
  const tokenUri = value.tokenUri;
  const confirmedAtValue = value.confirmedAt;
  if (
    typeof projectId !== 'string'
    || typeof milestone !== 'number'
    || !Number.isSafeInteger(milestone)
    || typeof beneficiaryCount !== 'number'
    || !Number.isSafeInteger(beneficiaryCount)
    || typeof imageCid !== 'string'
    || typeof tokenUri !== 'string'
  ) {
    return null;
  }

  const confirmedAt = confirmedAtValue === null
    ? null
    : new Date(String(confirmedAtValue));
  if (confirmedAt && Number.isNaN(confirmedAt.getTime())) return null;

  return { projectId, milestone, beneficiaryCount, imageCid, tokenUri, confirmedAt };
}

/** Parse và validate cache detail trước khi trả về client hoặc dùng làm nguồn dữ liệu API. */
function parseCachedTokenDetail(cachedJson: string, tokenId: number): SbtTokenDetail | null {
  const parsed: unknown = JSON.parse(cachedJson);
  if (!isRecord(parsed) || parsed.onChainTokenId !== tokenId || !isRecord(parsed.onChain)) {
    return null;
  }

  const onChain = parsed.onChain;
  const mintedAt = new Date(String(onChain.mintedAt));
  const tokenStatus = onChain.tokenStatus;
  const projectId = onChain.projectId;
  const milestone = onChain.milestone;
  const beneficiaryCount = onChain.beneficiaryCount;
  const gpsCoordinates = onChain.gpsCoordinates;
  const imageCID = onChain.imageCID;
  if (
    typeof projectId !== 'number'
    || !Number.isSafeInteger(projectId)
    || typeof milestone !== 'number'
    || !Number.isSafeInteger(milestone)
    || typeof beneficiaryCount !== 'number'
    || !Number.isSafeInteger(beneficiaryCount)
    || typeof gpsCoordinates !== 'string'
    || typeof imageCID !== 'string'
    || Number.isNaN(mintedAt.getTime())
    || (tokenStatus !== null && !['ACTIVE', 'FROZEN', 'REVOKED', 'BURNED'].includes(String(tokenStatus)))
  ) {
    return null;
  }

  const ipfsError = parsed.ipfsError;
  return {
    onChainTokenId: tokenId,
    onChain: {
      projectId,
      milestone,
      beneficiaryCount,
      gpsCoordinates,
      imageCID,
      mintedAt,
      tokenStatus: tokenStatus as SbtTokenStatusName | null
    },
    offChain: sanitizeCachedOffChain(parsed.offChain),
    // Không tin URL đã lưu trong Redis; dựng lại từ CID đã được validate để chống cache poisoning.
    imageGatewayUrl: imageCID ? tryBuildIpfsGatewayUrl(imageCID) : null,
    ipfsMetadata: parsed.ipfsMetadata ?? null,
    ipfsError: typeof ipfsError === 'string' ? ipfsError : null,
    cached: true
  };
}

/** Chuyển giá trị uint256 sang number mà không làm mất độ chính xác silently. */
function toSafeNumber(value: NumericValue, fieldName: string): number {
  const numberValue = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue)) {
    throw new ApplicationError(
      `Giá trị ${fieldName} vượt quá giới hạn số an toàn của backend.`,
      500,
      'INTERNAL_ERROR'
    );
  }
  return numberValue;
}

/** Chuyển Unix seconds sang Date và chặn overflow khi nhân sang milliseconds. */
function toSafeDateFromUnixSeconds(value: NumericValue): Date {
  const seconds = toSafeNumber(value, 'mintedAt');
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new ApplicationError(
      'Giá trị mintedAt vượt quá giới hạn Date an toàn của backend.',
      500,
      'INTERNAL_ERROR'
    );
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new ApplicationError(
      'Giá trị mintedAt không tạo được Date hợp lệ cho backend.',
      500,
      'INTERNAL_ERROR'
    );
  }
  return date;
}

/** Bao timeout cho RPC read để request API không bị treo vô hạn khi provider không phản hồi. */
function withRpcTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      const timeoutError = Object.assign(new Error('RPC read timeout.'), { code: 'TIMEOUT' });
      logger.warn('RPC read SBT đã timeout; promise provider tiếp tục chạy nền.', {
        timeoutMs: SBT_RPC_READ_TIMEOUT_MS,
        orphanedPromiseCount: orphanedRpcPromiseCount += 1
      });
      reject(timeoutError);
    }, SBT_RPC_READ_TIMEOUT_MS);

    promise.then(
      value => {
        clearTimeout(timeout);
        if (timedOut) return;
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        if (timedOut) return;
        reject(error);
      }
    );
  });
}

/** Kiểm tra lỗi ethers có phải custom error TokenNotExists hay không. */
function isTokenNotExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errorRecord = error as Record<string, unknown>;
  const names = [errorRecord.name, errorRecord.errorName, errorRecord.shortMessage, errorRecord.message];
  if (names.some(value => typeof value === 'string' && value.includes('TokenNotExists'))) return true;
  return isTokenNotExistsError(errorRecord.error);
}

/** Kiểm tra mã lỗi RPC ở cả error trực tiếp và object lồng của ethers. */
function isBlockchainUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errorRecord = error as Record<string, unknown>;
  const errorCode = errorRecord.code;
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(String(errorCode))) return true;
  return isBlockchainUnavailableError(errorRecord.error);
}

/** Ánh xạ lỗi đọc blockchain sang mã HTTP ổn định cho controller. */
function mapBlockchainReadError(error: unknown): ApplicationError | null {
  if (isTokenNotExistsError(error)) {
    return new ApplicationError('SBT không tồn tại.', 404, 'NOT_FOUND');
  }
  if (isBlockchainUnavailableError(error)) {
    return new ApplicationError(
      'Blockchain hiện không khả dụng. Vui lòng thử lại sau.',
      503,
      'BLOCKCHAIN_UNAVAILABLE'
    );
  }
  return null;
}

/** Ánh xạ custom error từ transaction update status sang lỗi API ổn định, không để lộ raw RPC error. */
function mapBlockchainWriteError(error: unknown): ApplicationError | null {
  const readError = mapBlockchainReadError(error);
  if (readError) return readError;

  if (isBlockchainErrorNamed(error, 'InvalidTransition')) {
    return new ApplicationError(
      'SBT không còn ở trạng thái hợp lệ để chuyển tiếp.',
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }
  if (isBlockchainErrorNamed(error, 'InvalidStatus')) {
    return new ApplicationError('Trạng thái SBT không hợp lệ trên blockchain.', 400, 'VALIDATION_ERROR');
  }
  return null;
}

/** Tìm tên custom error trong các lớp error lồng nhau mà ethers có thể trả về. */
function isBlockchainErrorNamed(error: unknown, expectedName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const errorRecord = error as Record<string, unknown>;
  const names = [errorRecord.name, errorRecord.errorName, errorRecord.shortMessage, errorRecord.message];
  if (names.some(value => typeof value === 'string' && value.includes(expectedName))) return true;
  return isBlockchainErrorNamed(errorRecord.error, expectedName);
}

/** Chuyển lỗi IPFS thành mã hiển thị ngắn gọn, không đưa raw gateway error cho client. */
function getIpfsErrorCode(error: unknown): string {
  if (error instanceof IpfsGatewayError) return error.code;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'IPFS_TIMEOUT';
  }
  return 'IPFS_UNAVAILABLE';
}

/** Đọc đồng thời metadata và status on-chain với timeout chung của request. */
async function readSbtOnChain(
  tokenId: number
): Promise<{ metadata: readonly [NumericValue, NumericValue, NumericValue, string, string, NumericValue]; status: NumericValue }> {
  const contract = getReadOnlyImpactSbtContract() as SbtReadContract;
  try {
    const [metadata, status] = await withRpcTimeout(Promise.all([
      contract.getTokenMetadata(tokenId),
      contract.getTokenStatus(tokenId)
    ]));
    return { metadata, status };
  } catch (error) {
    const mappedError = mapBlockchainReadError(error);
    if (mappedError) throw mappedError;
    throw error;
  }
}

/** Lấy danh sách SBT public theo project từ MongoDB, không tạo N+1 request tới chain/IPFS. */
export async function getSbtListByProject(
  projectId: string,
  page = 1,
  limit = 20
): Promise<SbtListResult> {
  const pagination = normalizePagination(page, limit);
  const skip = (pagination.page - 1) * pagination.limit;
  const [records, total] = await Promise.all([
    findImpactSbtMetadataByProjectId(projectId, pagination.limit, skip),
    countImpactSbtByProjectId(projectId)
  ]);

  return {
    entries: records.map(toGalleryEntry),
    pagination: {
      ...pagination,
      total,
      totalPages: Math.ceil(total / pagination.limit)
    }
  };
}

/** Lấy detail SBT từ cache hoặc ghép dữ liệu Mongo, blockchain và IPFS theo source of truth on-chain. */
export async function getSbtTokenDetail(tokenId: number): Promise<SbtTokenDetail> {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
    throw new ApplicationError('tokenId không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  const cachedJson = await getSbtTokenCache(tokenId);
  if (cachedJson) {
    try {
      const cachedPayload = parseCachedTokenDetail(cachedJson, tokenId);
      if (cachedPayload) return cachedPayload;
      logger.warn('SBT metadata cache không đúng schema public, bỏ qua cache.', { tokenId });
    } catch (error) {
      logger.warn('SBT metadata cache chứa JSON không hợp lệ, bỏ qua cache.', {
        tokenId,
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  if (await getSbtTokenNotFoundCache(tokenId)) {
    throw new ApplicationError('SBT không tồn tại.', 404, 'NOT_FOUND');
  }

  // DB và RPC là hai nguồn độc lập; chạy song song để giảm latency cache miss mà không đổi source of truth.
  let offChainRecord: ImpactSbtMetadataRecord | null;
  let chainResult: Awaited<ReturnType<typeof readSbtOnChain>>;
  try {
    [offChainRecord, chainResult] = await Promise.all([
      findImpactSbtMetadataByTokenId(tokenId),
      readSbtOnChain(tokenId)
    ]);
  } catch (error) {
    if (error instanceof ApplicationError && error.errorCode === 'NOT_FOUND') {
      try {
        await setSbtTokenNotFoundCache(tokenId);
      } catch (cacheError) {
        logger.warn('Không thể ghi negative cache SBT không tồn tại.', {
          tokenId,
          errorMessage: sanitizeProviderError(cacheError) ?? 'UNKNOWN_ERROR'
        });
      }
    }
    throw error;
  }
  const { metadata, status } = chainResult;
  const [projectId, milestone, beneficiaryCount, gpsCoordinates, imageCID, mintedAtSeconds] = metadata;
  const onChainTokenStatus = toSbtTokenStatusName(toSafeNumber(status, 'tokenStatus'));
  const detail: SbtTokenDetail = {
    onChainTokenId: tokenId,
    onChain: {
      projectId: toSafeNumber(projectId, 'projectId'),
      milestone: toSafeNumber(milestone, 'milestone'),
      beneficiaryCount: toSafeNumber(beneficiaryCount, 'beneficiaryCount'),
      gpsCoordinates,
      imageCID,
      mintedAt: toSafeDateFromUnixSeconds(mintedAtSeconds),
      tokenStatus: onChainTokenStatus
    },
    offChain: toOffChainDetail(offChainRecord),
    imageGatewayUrl: imageCID ? tryBuildIpfsGatewayUrl(imageCID) : null,
    ipfsMetadata: null,
    ipfsError: null,
    cached: false
  };

  if (offChainRecord?.tokenUri) {
    try {
      detail.ipfsMetadata = await fetchJsonFromIpfs(offChainRecord.tokenUri);
    } catch (error) {
      detail.ipfsError = getIpfsErrorCode(error);
      logger.warn('Không thể tải IPFS metadata của SBT, trả detail degrade.', {
        tokenId,
        errorCode: detail.ipfsError
      });
    }
  }

  if (!detail.ipfsError) {
    try {
      await setSbtTokenCache(tokenId, JSON.stringify(detail));
    } catch (error) {
      logger.warn('Không thể ghi cache metadata SBT, vẫn trả response thành công.', {
        tokenId,
        errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
      });
    }
  }

  return detail;
}

/** Gửi transaction cập nhật trạng thái SBT on-chain rồi đồng bộ Mongo và invalidate cache theo đúng thứ tự. */
export async function updateSbtStatus(
  tokenId: number,
  newStatus: string,
  reason: string,
  updatedBy: string
): Promise<SbtStatusUpdateResult> {
  const rawReason = typeof reason === 'string' ? reason.trim() : '';
  const normalizedReason = sanitizeProviderError(rawReason) ?? '';
  const statusValue = Object.prototype.hasOwnProperty.call(SBT_TOKEN_STATUS_TO_UINT8, newStatus)
    ? SBT_TOKEN_STATUS_TO_UINT8[newStatus as SbtTokenStatusName]
    : undefined;
  if (
    statusValue === undefined
    || !Number.isSafeInteger(tokenId)
    || tokenId < 0
    || !rawReason
    || rawReason.length > MAX_STATUS_REASON_LENGTH
    || !normalizedReason
    || normalizedReason.length > MAX_STATUS_REASON_LENGTH
    || typeof updatedBy !== 'string'
    || !updatedBy.trim()
  ) {
    throw new ApplicationError('Dữ liệu cập nhật trạng thái SBT không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  let currentStatus: SbtTokenStatusName | null;
  try {
    const readContract = getReadOnlyImpactSbtContract() as SbtReadContract;
    const status = await withRpcTimeout(readContract.getTokenStatus(tokenId));
    currentStatus = toSbtTokenStatusName(toSafeNumber(status, 'tokenStatus'));
  } catch (error) {
    const mappedError = mapBlockchainReadError(error);
    if (mappedError) throw mappedError;
    throw error;
  }

  if (!currentStatus) {
    throw new ApplicationError('Blockchain trả về trạng thái SBT không được backend hỗ trợ.', 500, 'INTERNAL_ERROR');
  }
  if ((SBT_TERMINAL_STATUSES as readonly string[]).includes(currentStatus)) {
    throw new ApplicationError(
      'SBT đã ở trạng thái terminal và không thể chuyển tiếp.',
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }
  if (currentStatus === newStatus) {
    throw new ApplicationError(
      'SBT đã ở trạng thái này.',
      409,
      'INVALID_STATUS_TRANSITION'
    );
  }

  let transaction: SbtTransactionResponse;
  let receipt: SbtTransactionReceipt | null;
  try {
    const writeContract = getWritableImpactSbtContract() as SbtWriteContract;
    const updateTokenStatusMethod = writeContract.updateTokenStatus;
    const estimatedGas = await updateTokenStatusMethod.estimateGas(tokenId, statusValue, normalizedReason);
    const gasLimit = estimatedGas * 3n + 100_000n < MAX_STATUS_UPDATE_GAS
      ? estimatedGas * 3n + 100_000n
      : MAX_STATUS_UPDATE_GAS;
    transaction = await updateTokenStatusMethod(tokenId, statusValue, normalizedReason, { gasLimit });
    receipt = await transaction.wait(SBT_MINT_CONFIRMATION_BLOCKS);
  } catch (error) {
    const mappedError = mapBlockchainWriteError(error);
    if (mappedError) throw mappedError;
    throw error;
  }

  if (!receipt || receipt.status !== 1) {
    throw new ApplicationError('Transaction cập nhật trạng thái SBT bị revert.', 502, 'TRANSACTION_REVERTED');
  }

  const updatedAt = new Date();
  let auditWarning: SbtStatusUpdateResult['auditWarning'] = null;
  try {
    const updatedRecord = await updateImpactSbtOnChainStatus(tokenId, {
      onChainTokenStatus: newStatus as SbtTokenStatusName,
      reason: normalizedReason,
      updatedBy,
      updatedAt
    });
    if (!updatedRecord) {
      auditWarning = 'OFF_CHAIN_RECORD_NOT_FOUND';
      logger.error('Transaction trạng thái SBT thành công nhưng không tìm thấy record CONFIRMED để audit.', {
        tokenId,
        transactionHash: transaction.hash
      });
    }
  } catch (error) {
    // Transaction đã thành công nên không thể rollback; listener/reconcile sẽ sửa Mongo ở follow-up.
    auditWarning = 'OFF_CHAIN_SYNC_FAILED';
    logger.error('Đồng bộ trạng thái SBT vào Mongo thất bại sau khi tx thành công.', {
      tokenId,
      transactionHash: transaction.hash,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  }

  try {
    await invalidateSbtTokenCache(tokenId);
  } catch (error) {
    // Invalidate lỗi không được biến transaction thành failure; TTL cache sẽ tự dọn sau tối đa một giờ.
    logger.warn('Invalidate cache SBT thất bại sau khi cập nhật trạng thái.', {
      tokenId,
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  }

  logger.info('Cập nhật trạng thái SBT on-chain thành công.', {
    tokenId,
    newStatus,
    updatedBy,
    reason: normalizedReason,
    transactionHash: transaction.hash
  });

  return {
    tokenId,
    newStatus: newStatus as SbtTokenStatusName,
    isIrreversible: newStatus === 'REVOKED' || newStatus === 'BURNED',
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
    auditWarning
  };
}
