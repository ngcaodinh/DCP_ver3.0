import { ethers } from 'ethers';
import crypto from 'crypto';
import { getBlockchainRpcUrl } from '../config/blockchainRpc';
import { getLogger } from '../config/logger';
import { findGeofenceByProjectId, findProjectIdsWithGeofence } from '../models/projectGeofenceModel';
import { countActiveAuditors, findUserById, findUsersByRole } from '../models/authModel';
import { ADMIN_ROLE } from '../constants/governanceRoles';
import { findSubmissionsByOrganizationId } from '../models/organizationKycModel';
import { ProjectStatus } from '../models/projectModel';
import type { ProjectEvidenceFileRecord, ProjectMilestonePlanItem } from '../models/projectModel';
import { getChallengeWindowMs } from '../constants/projectListingPolicy';
import {
  countActiveProjectsByOrganizationIdFromRepository,
  createProject,
  CreateProjectDataAccessPayload,
  findProjectById,
  findProjectByOrganizationAndName,
  findProjectsByOrganizationIdFromRepository,
  findProjectsByStatusFromRepository,
  findProjectsByStatusListFromRepository,
  findPublicSupportProjectDetailFromRepository,
  findPublicSupportProjectsFromRepository,
  updateProject
} from '../repositories/projectRepository';
import { findLatestDonationTimestampByProjectIdFromRepository } from '../repositories/donationRepository';
import { ApplicationError } from '../utils/applicationError';
import { createInMemoryCache } from '../utils/inMemoryCache';
import { createUserNotification } from './notificationService';

export type CreateProjectPayload = {
  name: string;
  description: string;
  goalAmount: number;
  deadline: string;
  evidenceCids: string[];
  evidenceFiles?: ProjectEvidenceFileRecord[];
  milestonePlan?: ProjectMilestonePlanItem[];
};

export type CreateProjectResult = {
  projectId: string;
  organizationId: string;
  name: string;
  description: string;
  goalAmount: number;
  deadline: Date;
  status: ProjectStatus;
  evidenceCids: string[];
  evidenceFiles: ProjectEvidenceFileRecord[];
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  hasGeofence: boolean;
  milestonePlan?: ProjectMilestonePlanItem[];
  listedAt: Date | null;
  activationEligibleAt: Date | null;
  activationState: 'NOT_STARTED' | 'SYNCED' | 'FAILED';
  activationAttemptCount: number;
  activationLastError: string | null;
  warning?: 'NO_ACTIVE_AUDITOR' | null;
  createdAt: Date;
};

export type UploadProjectEvidenceFilePayload = {
  fileName: string;
  mimeType: string;
  contentBase64: string;
};

export type UploadProjectEvidencesPayload = {
  files: UploadProjectEvidenceFilePayload[];
};

export type UpdateProjectPayload = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  deadline: string;
  evidenceCids: string[];
  evidenceFiles?: ProjectEvidenceFileRecord[];
  milestonePlan: ProjectMilestonePlanItem[];
};

export type CreateProjectEligibilityResult = {
  isEligibleToCreateProject: boolean;
  blockReason: string | null;
};

export type PublicSupportProjectResult = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  deadline: Date;
  status: ProjectStatus;
  evidenceCids: string[];
  evidenceFiles: ProjectEvidenceFileRecord[];
  updatedAt: Date;
  createdAt: Date;
};

export type PublicSupportProjectDetailResult = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  status: ProjectStatus;
  lastDonationAt: Date | null;
  evidenceCids: string[];
  evidenceFiles: ProjectEvidenceFileRecord[];
  creatorName: string | null;
};

type UploadedProjectEvidenceItem = ProjectEvidenceFileRecord;

const logger = getLogger();
const pinataPinFileEndpoint = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const pinataUnpinFileEndpoint = 'https://api.pinata.cloud/pinning/unpin';
const pinataRequestTimeoutMilliseconds = 15000;
const pinataMaximumRetryCount = 2;
const projectEvidenceMaximumFileCount = 10;
const projectEvidenceAllowedMimeTypeSet = new Set([
  'application/pdf',
  'image/png',
  'image/jpg',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

const publicSupportProjectsCache = createInMemoryCache<PublicSupportProjectResult[]>();
const donationRankingContractAbi = [
  'function createProject(uint256 projectId) external',
  'function setProjectStatus(uint256 projectId, uint8 newStatus) external',
  'function getProjectSnapshot(uint256 projectId) external view returns (bool exists, uint8 projectStatus, uint256 totalDonationAmount, uint256 donorCount, uint256 donationTransactionCount)',
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function projectManagerRole() external view returns (bytes32)',
  'function grantProjectManagerRole(address account) external',
  'error ProjectNotFound()'
];

/** Hàm lấy TTL cache cho public-support. Mục đích: đọc env và đảm bảo TTL luôn trong khoảng 30-60 giây. */
function getPublicSupportCacheTimeToLiveSeconds(): number {
  const defaultTimeToLiveSeconds = 45;
  const configuredTimeToLive = Number(process.env.PUBLIC_SUPPORT_CACHE_TTL_SECONDS || defaultTimeToLiveSeconds);

  if (!Number.isFinite(configuredTimeToLive)) {
    return defaultTimeToLiveSeconds;
  }

  return Math.max(30, Math.min(60, Math.floor(configuredTimeToLive)));
}

/** Hàm tạo cache key cho danh sách public-support. Mục đích: tránh trả sai dữ liệu khi query param khác nhau. */
function createPublicSupportCacheKey(limitCount: number): string {
  return `public-support:limit=${limitCount}`;
}

/** Hàm làm sạch chuỗi đầu vào. Mục đích: giảm rủi ro chèn script vào dữ liệu text. */
function sanitizeTextInput(inputText: string): string {
  return inputText.replace(/<[^>]*>/g, '').split('').filter(character => character.charCodeAt(0) >= 32).join('').trim();
}

/** Hàm làm sạch metadata file minh chứng IPFS. Mục đích: giữ đồng bộ cid-fileName-mimeType và chặn text bẩn trước khi lưu DB. */
function sanitizeProjectEvidenceFiles(
  evidenceFiles: ProjectEvidenceFileRecord[] | undefined,
  evidenceCids: string[]
): ProjectEvidenceFileRecord[] {
  if (!Array.isArray(evidenceFiles) || evidenceFiles.length === 0) {
    return evidenceCids.map(cid => ({ cid, fileName: '', mimeType: '' }));
  }

  // Ghi chú logic phức tạp: map theo CID giúp tương thích payload cũ/mới và tránh lệch thứ tự khi FE xử lý lại danh sách.
  const evidenceFileByCidMap = new Map(
    evidenceFiles.map(fileItem => [sanitizeTextInput(fileItem.cid), {
      cid: sanitizeTextInput(fileItem.cid),
      fileName: sanitizeTextInput(fileItem.fileName),
      mimeType: sanitizeTextInput(fileItem.mimeType).toLowerCase()
    }])
  );

  return evidenceCids.map(cid => evidenceFileByCidMap.get(cid) || { cid, fileName: '', mimeType: '' });
}

/** Hàm map project record về output. Mục đích: tái sử dụng format response giữa các API project. */
function mapProjectRecordToResult(
  projectRecord: CreateProjectDataAccessPayload,
  hasGeofence = false
): CreateProjectResult {
  return {
    projectId: projectRecord.projectId,
    organizationId: projectRecord.organizationId,
    name: projectRecord.name,
    description: projectRecord.description,
    goalAmount: projectRecord.goalAmount,
    deadline: projectRecord.deadline,
    status: projectRecord.status,
    evidenceCids: projectRecord.evidenceCids,
    evidenceFiles: projectRecord.evidenceFiles || [],
    submittedAt: projectRecord.submittedAt,
    reviewedAt: projectRecord.reviewedAt,
    reviewedBy: projectRecord.reviewedBy,
    rejectionReason: projectRecord.rejectionReason,
    hasGeofence,
    milestonePlan: projectRecord.milestonePlan || [],
    listedAt: projectRecord.listedAt || null,
    activationEligibleAt: projectRecord.activationEligibleAt || null,
    activationState: projectRecord.activationState || 'NOT_STARTED',
    activationAttemptCount: projectRecord.activationAttemptCount || 0,
    activationLastError: projectRecord.activationLastError || null,
    createdAt: projectRecord.createdAt
  };
}

/** Hàm lấy JWT Pinata từ biến môi trường. Mục đích: đảm bảo upload IPFS chỉ chạy khi đã cấu hình đầy đủ. */
function getPinataJsonWebToken(): string {
  const pinataJsonWebToken = process.env.PINATA_JWT?.trim() || '';
  if (!pinataJsonWebToken) {
    throw new ApplicationError('Thiếu cấu hình PINATA_JWT trên backend.', 500, 'INTERNAL_ERROR');
  }

  return pinataJsonWebToken;
}

/** Hàm lấy contract và signer để đồng bộ project lên blockchain. Mục đích: tái sử dụng cấu hình RPC/PK/contract cho các thao tác create và đổi trạng thái dự án on-chain. */
function getDonationRankingContractForProjectSync() {
  const blockchainRpcUrl = getBlockchainRpcUrl();
  const donationRankingContractAddress = process.env.DONATION_RANKING_CONTRACT_ADDRESS?.trim() || process.env.DONATION_RANKING_ADDRESS?.trim() || '';
  const projectManagerPrivateKey = process.env.PROJECT_MANAGER_PRIVATE_KEY?.trim() || process.env.DONATION_RELAYER_PRIVATE_KEY?.trim() || '';
  const adminPrivateKey = process.env.DONATION_ADMIN_PRIVATE_KEY?.trim() || process.env.DEPLOYER_PRIVATE_KEY?.trim() || '';
  const expectedChainId = Number(process.env.BLOCKCHAIN_CHAIN_ID || 0);

  if (!blockchainRpcUrl || !donationRankingContractAddress || !projectManagerPrivateKey) {
    throw new ApplicationError(
      'Thiếu cấu hình đồng bộ project on-chain. Cần BLOCKCHAIN_RPC_URL, DONATION_RANKING_CONTRACT_ADDRESS (hoặc DONATION_RANKING_ADDRESS), PROJECT_MANAGER_PRIVATE_KEY (hoặc DONATION_RELAYER_PRIVATE_KEY).',
      503,
      'BLOCKCHAIN_UNAVAILABLE'
    );
  }

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const walletSigner = new ethers.Wallet(projectManagerPrivateKey, provider);
  const donationRankingContract = new ethers.Contract(donationRankingContractAddress, donationRankingContractAbi, walletSigner);

  const adminSigner = adminPrivateKey ? new ethers.Wallet(adminPrivateKey, provider) : null;
  const donationRankingAdminContract = adminSigner
    ? new ethers.Contract(donationRankingContractAddress, donationRankingContractAbi, adminSigner)
    : null;

  return {
    provider,
    walletSigner,
    donationRankingContract,
    donationRankingAdminContract,
    donationRankingContractAddress,
    expectedChainId
  };
}

/** Hàm kiểm tra và tự cấp quyền project manager cho signer vận hành. Mục đích: đảm bảo mỗi lần tạo project đều tự phục hồi quyền nếu relayer bị thiếu role. */
async function ensureProjectManagerRolePermission(
  donationRankingContract: ethers.Contract,
  donationRankingAdminContract: ethers.Contract | null,
  walletAddress: string
): Promise<void> {
  const projectManagerRoleHash = await donationRankingContract.projectManagerRole();
  const hasProjectManagerPermission = await donationRankingContract.hasRole(projectManagerRoleHash, walletAddress);
  if (hasProjectManagerPermission) {
    return;
  }

  if (!donationRankingAdminContract) {
    throw new ApplicationError(
      `Ví vận hành ${walletAddress} chưa có PROJECT_MANAGER_ROLE và thiếu DONATION_ADMIN_PRIVATE_KEY để tự cấp quyền.`,
      500,
      'INTERNAL_ERROR'
    );
  }

  const grantRoleTransaction = await donationRankingAdminContract.grantProjectManagerRole(walletAddress);
  await grantRoleTransaction.wait();
  logger.info('Auto-granted PROJECT_MANAGER_ROLE for relayer wallet.', {
    walletAddress,
    transactionHash: grantRoleTransaction.hash
  });

  // Ghi chú logic phức tạp: cần verify lại role sau khi grant để tránh trạng thái mined nhưng không cấp quyền thành công.
  const hasProjectManagerPermissionAfterGrant = await donationRankingContract.hasRole(projectManagerRoleHash, walletAddress);
  if (!hasProjectManagerPermissionAfterGrant) {
    throw new ApplicationError(
      `Tự động cấp PROJECT_MANAGER_ROLE thất bại cho ví vận hành ${walletAddress}.`,
      500,
      'INTERNAL_ERROR'
    );
  }
}

/** Hàm đồng bộ tạo project lên blockchain. Mục đích: đảm bảo project tồn tại on-chain ngay khi vừa tạo off-chain để tránh donate bị ProjectNotFound. */
async function createProjectOnBlockchain(projectId: string): Promise<void> {
  const normalizedProjectId = projectId.trim();
  if (!/^[0-9]+$/.test(normalizedProjectId)) {
    throw new ApplicationError('Mã dự án phải là số để đồng bộ lên blockchain.', 400, 'VALIDATION_ERROR');
  }

  const { provider, walletSigner, donationRankingContract, donationRankingAdminContract, expectedChainId } = getDonationRankingContractForProjectSync();
  let network: ethers.Network;
  try {
    network = await provider.getNetwork();
  } catch {
    throw new ApplicationError('Không thể kết nối blockchain để đồng bộ dự án. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
  }
  if (expectedChainId > 0 && Number(network.chainId) !== expectedChainId) {
    throw new ApplicationError('Sai network blockchain của dịch vụ đồng bộ dự án.', 400, 'CHAIN_MISMATCH');
  }

  try {
    await ensureProjectManagerRolePermission(donationRankingContract, donationRankingAdminContract, walletSigner.address);
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }

    throw new ApplicationError('Không thể xác minh quyền đồng bộ dự án trên blockchain. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
  }

  try {
    const createProjectTransaction = await donationRankingContract.createProject(BigInt(normalizedProjectId));
    await createProjectTransaction.wait();
    logger.info(`Project synced to blockchain successfully. projectId=${normalizedProjectId} txHash=${createProjectTransaction.hash}`);
  } catch (error) {
    logger.error('Create project on blockchain failed.', {
      projectId: normalizedProjectId,
      errorMessage: (error as Error)?.message || 'Unknown error'
    });
    throw new ApplicationError('Không thể đồng bộ dự án lên blockchain. Vui lòng thử lại sau.', 502, 'INTERNAL_ERROR');
  }
}

/** Hàm kiểm tra lỗi contract có phải do project chưa tồn tại hay không để chỉ tự tạo lại trong đúng trường hợp đó. */
function isProjectNotFoundContractError(error: unknown, donationRankingContract: ethers.Contract): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const contractError = error as {
    data?: unknown;
    info?: { error?: { data?: unknown } };
  };
  const errorData = typeof contractError.data === 'string'
    ? contractError.data
    : typeof contractError.info?.error?.data === 'string'
      ? contractError.info.error.data
      : null;

  if (!errorData) {
    return false;
  }

  try {
    return donationRankingContract.interface.parseError(errorData)?.name === 'ProjectNotFound';
  } catch {
    return false;
  }
}

/** Hàm đồng bộ trạng thái project ACTIVE lên blockchain. Mục đích: mở trạng thái nhận donate on-chain ngay khi reviewer approve dự án. */
export async function activateProjectOnBlockchain(projectId: string): Promise<void> {
  const normalizedProjectId = projectId.trim();
  if (!/^[0-9]+$/.test(normalizedProjectId)) {
    throw new ApplicationError('Mã dự án phải là số để cập nhật trạng thái on-chain.', 400, 'VALIDATION_ERROR');
  }

  const activeProjectStatus = 1;
  const { provider, walletSigner, donationRankingContract, donationRankingAdminContract, expectedChainId } = getDonationRankingContractForProjectSync();
  let network: ethers.Network;
  try {
    network = await provider.getNetwork();
  } catch {
    throw new ApplicationError('Không thể kết nối blockchain để kích hoạt dự án. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
  }
  if (expectedChainId > 0 && Number(network.chainId) !== expectedChainId) {
    throw new ApplicationError('Sai network blockchain của dịch vụ đồng bộ trạng thái dự án.', 400, 'CHAIN_MISMATCH');
  }

  try {
    await ensureProjectManagerRolePermission(donationRankingContract, donationRankingAdminContract, walletSigner.address);
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }

    throw new ApplicationError('Không thể xác minh quyền kích hoạt dự án trên blockchain. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
  }

  let projectSnapshot: { exists: boolean; projectStatus: bigint };
  try {
    projectSnapshot = await donationRankingContract.getProjectSnapshot(BigInt(normalizedProjectId));
  } catch (error) {
    if (!isProjectNotFoundContractError(error, donationRankingContract)) {
      throw new ApplicationError('Không thể kiểm tra trạng thái dự án trên blockchain. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
    }

    // Chỉ dữ liệu legacy chưa có project on-chain mới được tự phục hồi bằng thao tác tạo project.
    await createProjectOnBlockchain(normalizedProjectId);
    projectSnapshot = { exists: true, projectStatus: 0n };
  }

  if (!projectSnapshot.exists) {
    await createProjectOnBlockchain(normalizedProjectId);
    projectSnapshot = { exists: true, projectStatus: 0n };
  }

  if (Number(projectSnapshot.projectStatus) === activeProjectStatus) {
    return;
  }

  if (Number(projectSnapshot.projectStatus) !== 0) {
    throw new ApplicationError('Trạng thái dự án trên blockchain không thể chuyển sang ACTIVE.', 409, 'INVALID_STATUS_TRANSITION');
  }

  try {
    const updateStatusTransaction = await donationRankingContract.setProjectStatus(BigInt(normalizedProjectId), activeProjectStatus);
    await updateStatusTransaction.wait();
    logger.info(`Project status activated on blockchain successfully. projectId=${normalizedProjectId} txHash=${updateStatusTransaction.hash}`);
  } catch {
    throw new ApplicationError('Không thể kích hoạt dự án trên blockchain. Vui lòng thử lại sau.', 502, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

/** Hàm validate payload upload file minh chứng. Mục đích: chặn dữ liệu sai chuẩn trước khi upload Pinata. */
function validateUploadProjectEvidencesPayload(payload: UploadProjectEvidencesPayload): void {
  if (!Array.isArray(payload.files) || payload.files.length < 1) {
    throw new ApplicationError('Vui lòng tải lên ít nhất 1 file minh chứng.', 400, 'VALIDATION_ERROR');
  }

  if (payload.files.length > projectEvidenceMaximumFileCount) {
    throw new ApplicationError('Bạn chỉ được tải lên tối đa 10 file minh chứng.', 400, 'VALIDATION_ERROR');
  }

  payload.files.forEach((fileItem, index) => {
    const normalizedMimeType = fileItem.mimeType.trim().toLowerCase();
    if (!fileItem.fileName.trim()) {
      throw new ApplicationError(`Tên file tại vị trí ${index + 1} không hợp lệ.`, 400, 'VALIDATION_ERROR');
    }

    if (!projectEvidenceAllowedMimeTypeSet.has(normalizedMimeType)) {
      throw new ApplicationError(`Định dạng file không hỗ trợ: ${fileItem.fileName}`, 400, 'VALIDATION_ERROR');
    }

    if (!fileItem.contentBase64.trim()) {
      throw new ApplicationError(`Nội dung file trống: ${fileItem.fileName}`, 400, 'VALIDATION_ERROR');
    }
  });
}

/** Hàm upload một file minh chứng lên Pinata. Mục đích: nhận CID IPFS để đưa vào payload tạo dự án. */
async function uploadProjectEvidenceFileToPinata(file: UploadProjectEvidenceFilePayload): Promise<UploadedProjectEvidenceItem> {
  const pinataJsonWebToken = getPinataJsonWebToken();
  const binaryBuffer = Buffer.from(file.contentBase64, 'base64');

  if (!binaryBuffer.length) {
    throw new ApplicationError(`Nội dung file không hợp lệ: ${file.fileName}`, 400, 'VALIDATION_ERROR');
  }

  const uploadFormData = new FormData();
  const fileBlob = new Blob([binaryBuffer], { type: file.mimeType });
  uploadFormData.append('file', fileBlob, file.fileName);
  uploadFormData.append(
    'pinataMetadata',
    JSON.stringify({
      name: file.fileName,
      keyvalues: {
        module: 'projectEvidence',
        mimeType: file.mimeType
      }
    })
  );

  const pinataResponse = await fetch(pinataPinFileEndpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataJsonWebToken}` },
    body: uploadFormData,
    signal: AbortSignal.timeout(pinataRequestTimeoutMilliseconds)
  });

  const pinataResponseData = (await pinataResponse.json()) as { IpfsHash?: string; error?: string };
  if (!pinataResponse.ok || !pinataResponseData.IpfsHash) {
    throw new ApplicationError(pinataResponseData.error || `Upload Pinata thất bại: ${file.fileName}`, 502, 'INTERNAL_ERROR');
  }

  return {
    cid: pinataResponseData.IpfsHash,
    fileName: sanitizeTextInput(file.fileName),
    mimeType: sanitizeTextInput(file.mimeType).toLowerCase()
  };
}

/** Hàm upload file với retry giới hạn. Mục đích: tăng ổn định khi Pinata lỗi tạm thời hoặc timeout. */
export async function uploadProjectEvidenceFileToPinataWithRetry(file: UploadProjectEvidenceFilePayload): Promise<UploadedProjectEvidenceItem> {
  let latestUploadError: unknown = null;

  for (let retryAttempt = 1; retryAttempt <= pinataMaximumRetryCount; retryAttempt += 1) {
    try {
      return await uploadProjectEvidenceFileToPinata(file);
    } catch (error) {
      latestUploadError = error;
    }
  }

  throw latestUploadError || new ApplicationError('Upload file minh chứng thất bại.', 500, 'INTERNAL_ERROR');
}

/** Hàm gỡ pin một CID trên Pinata. Mục đích: xóa file minh chứng cũ khi dự án cập nhật ảnh mới. */
async function unpinProjectEvidenceCidFromPinata(cid: string): Promise<void> {
  const pinataJsonWebToken = getPinataJsonWebToken();
  const unpinResponse = await fetch(`${pinataUnpinFileEndpoint}/${cid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${pinataJsonWebToken}` },
    signal: AbortSignal.timeout(pinataRequestTimeoutMilliseconds)
  });

  // Pinata có thể trả 404 nếu CID không còn tồn tại ở workspace hiện tại, trường hợp này xem như đã sạch dữ liệu cũ.
  if (unpinResponse.ok || unpinResponse.status === 404) {
    return;
  }

  const unpinResponseText = await unpinResponse.text();
  throw new ApplicationError(unpinResponseText || `Xóa CID Pinata thất bại: ${cid}`, 502, 'INTERNAL_ERROR');
}

/** Hàm gỡ pin CID với retry giới hạn. Mục đích: tăng độ tin cậy khi thao tác cleanup Pinata. */
async function unpinProjectEvidenceCidFromPinataWithRetry(cid: string): Promise<void> {
  let latestUnpinError: unknown = null;

  for (let retryAttempt = 1; retryAttempt <= pinataMaximumRetryCount; retryAttempt += 1) {
    try {
      await unpinProjectEvidenceCidFromPinata(cid);
      return;
    } catch (error) {
      latestUnpinError = error;
    }
  }

  throw latestUnpinError || new ApplicationError('Xóa CID Pinata thất bại.', 500, 'INTERNAL_ERROR');
}

/** Hàm validate payload dự án dùng chung. Mục đích: tái sử dụng rule validate cho luồng tạo và cập nhật dự án. */
function validateProjectPayload(
  payload: Pick<CreateProjectPayload, 'name' | 'description' | 'goalAmount' | 'deadline' | 'evidenceCids'>,
  minimumEvidenceCidCount: number
): void {
  if (!payload.name || payload.name.trim().length < 3 || payload.name.trim().length > 120) {
    throw new ApplicationError('Tên dự án phải từ 3 đến 120 ký tự.', 400, 'VALIDATION_ERROR');
  }

  if (!payload.description || payload.description.trim().length < 10 || payload.description.trim().length > 2000) {
    throw new ApplicationError('Mô tả dự án phải từ 10 đến 2000 ký tự.', 400, 'VALIDATION_ERROR');
  }

  if (!Number.isFinite(payload.goalAmount) || payload.goalAmount <= 0) {
    throw new ApplicationError('Mục tiêu gây quỹ phải lớn hơn 0.', 400, 'VALIDATION_ERROR');
  }

  const parsedDeadline = new Date(payload.deadline);
  if (Number.isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) {
    throw new ApplicationError('Hạn dự án phải là thời gian trong tương lai.', 400, 'VALIDATION_ERROR');
  }

  if (!Array.isArray(payload.evidenceCids) || payload.evidenceCids.length < minimumEvidenceCidCount || payload.evidenceCids.length > 10) {
    throw new ApplicationError(`Dự án phải có từ ${minimumEvidenceCidCount} đến 10 CID bằng chứng IPFS.`, 400, 'VALIDATION_ERROR');
  }
}

/** Hàm validate payload tạo dự án. Mục đích: chặn dữ liệu sai chuẩn ngay tại service cho luồng tạo mới. */
function validateCreateProjectPayload(payload: CreateProjectPayload): void {
  validateProjectPayload(payload, 3);

  if (payload.evidenceFiles && payload.evidenceFiles.length !== payload.evidenceCids.length) {
    throw new ApplicationError('Danh sách metadata minh chứng không khớp với số lượng CID.', 400, 'VALIDATION_ERROR');
  }
}

/** Hàm validate payload cập nhật dự án. Mục đích: chặn dữ liệu sai chuẩn ngay tại service cho luồng cập nhật. */
function validateUpdateProjectPayload(payload: UpdateProjectPayload): void {
  validateProjectPayload(payload, 1);

  if (payload.evidenceFiles && payload.evidenceFiles.length !== payload.evidenceCids.length) {
    throw new ApplicationError('Danh sách metadata minh chứng không khớp với số lượng CID.', 400, 'VALIDATION_ERROR');
  }
}

/** Hàm kiểm tra quyền tổ chức hợp lệ. Mục đích: tái sử dụng cho các API thao tác project. */
async function ensureOrganizationUser(organizationUserId: string) {
  const organizationUser = await findUserById(organizationUserId);
  if (!organizationUser) {
    throw new ApplicationError('Không tìm thấy tài khoản người dùng.', 401, 'UNAUTHENTICATED');
  }

  if (organizationUser.role !== 'organizations') {
    throw new ApplicationError('Bạn không có quyền thao tác dự án.', 403, 'FORBIDDEN');
  }

  if (organizationUser.accountStatus !== 'ACTIVE') {
    throw new ApplicationError('Tài khoản tổ chức chưa đạt trạng thái hoạt động.', 403, 'FORBIDDEN');
  }

  return organizationUser;
}

/** Hàm kiểm tra quyền reviewer. Mục đích: giới hạn review cho admin hoặc regulatory. */
async function ensureReviewerUser(reviewerUserId: string) {
  const reviewerUser = await findUserById(reviewerUserId);
  if (!reviewerUser) {
    throw new ApplicationError('Không tìm thấy tài khoản reviewer.', 401, 'UNAUTHENTICATED');
  }

  if (reviewerUser.role !== 'regulatory') {
    throw new ApplicationError('Bạn không có quyền review dự án.', 403, 'FORBIDDEN');
  }

  return reviewerUser;
}

/** Hàm kiểm tra điều kiện tài khoản thụ hưởng trước khi tạo dự án. Mục đích: bắt buộc tổ chức có trạng thái đã duyệt/verified mới được phép tạo dự án. */
async function ensureOrganizationHasApprovedBeneficiaryBankAccount(organizationId: string): Promise<void> {
  const organizationSubmissionList = await findSubmissionsByOrganizationId(organizationId);

  // Logic tạm thời dùng KYC APPROVED làm nguồn kiểm tra do hệ thống hiện tại chưa có model runtime cho organizationBankAccounts.
  const hasApprovedBeneficiaryBankAccount = organizationSubmissionList.some(submissionItem => submissionItem.status === 'APPROVED');
  if (!hasApprovedBeneficiaryBankAccount) {
    throw new ApplicationError(
      'Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án. Vui lòng vào Cài đặt để thiết lập ngân hàng.',
      403,
      'FORBIDDEN'
    );
  }
}

/** Hàm tạo mã projectId dạng số. Mục đích: đảm bảo tương thích uint256 khi đồng bộ blockchain. */
function generateNumericProjectId(): string {
  const createdTimestamp = Date.now();
  // Dùng crypto.randomBytes thay Math.random() — entropy đủ lớn, không đoán được.
  const randomSuffix = parseInt(crypto.randomBytes(3).toString('hex'), 16) % 1_000_000;
  return `${createdTimestamp}${randomSuffix.toString().padStart(6, '0')}`;
}

/** Hàm xử lý nghiệp vụ tạo dự án mới. Mục đích: kiểm tra quyền, chặn trùng tên và lưu DRAFT có evidence. */
export async function createProjectForOrganization(organizationUserId: string, payload: CreateProjectPayload): Promise<CreateProjectResult> {
  validateCreateProjectPayload(payload);
  const organizationUser = await ensureOrganizationUser(organizationUserId);
  await ensureOrganizationHasApprovedBeneficiaryBankAccount(organizationUser.id);

  const sanitizedName = sanitizeTextInput(payload.name);
  const sanitizedDescription = sanitizeTextInput(payload.description);
  const sanitizedEvidenceCids = payload.evidenceCids.map(cid => sanitizeTextInput(cid));
  const sanitizedEvidenceFiles = sanitizeProjectEvidenceFiles(payload.evidenceFiles, sanitizedEvidenceCids);

  const existingProject = await findProjectByOrganizationAndName(organizationUser.id, sanitizedName);
  if (existingProject) {
    throw new ApplicationError('Tên dự án đã tồn tại trong tổ chức của bạn.', 409, 'CONFLICT');
  }

  const now = new Date();
  const parsedDeadline = new Date(payload.deadline);
  const projectPayload: CreateProjectDataAccessPayload = {
    projectId: generateNumericProjectId(),
    organizationId: organizationUser.id,
    name: sanitizedName,
    description: sanitizedDescription,
    goalAmount: payload.goalAmount,
    deadline: parsedDeadline,
    status: 'DRAFT',
    evidenceCids: sanitizedEvidenceCids,
    evidenceFiles: sanitizedEvidenceFiles,
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    milestonePlan: payload.milestonePlan || [],
    listedAt: null,
    activationEligibleAt: null,
    activationClaimedAt: null,
    activationState: 'NOT_STARTED',
    activationAttemptCount: 0,
    activationLastAttemptAt: null,
    activationLastError: null,
    listingRound: 0,
    createdAt: now,
    updatedAt: now
  };

  const createdProject = await createProject(projectPayload);
  // Dự án DRAFT chưa thể nhận quyên góp; chỉ đồng bộ on-chain khi reviewer duyệt ACTIVE để lỗi RPC không làm thất bại việc lưu bản nháp.
  logger.info('Project created successfully.', { correlationId: organizationUser.correlationId });
  return mapProjectRecordToResult(createdProject);
}

/** Báo admin khi hệ thống đang niêm yết không có auditor, nhưng không chặn giao dịch nghiệp vụ chính. */
async function notifyNoActiveAuditor(projectId: string): Promise<void> {
  try {
    const admins = (await findUsersByRole([ADMIN_ROLE])).filter(user => !user.isSybil);
    await Promise.all(admins.map(admin => createUserNotification({
      userId: admin.id,
      notificationType: 'SYSTEM',
      title: 'Cảnh báo: chưa có Kiểm toán viên',
      content: `Dự án ${projectId} vừa được niêm yết trong khi không có Kiểm toán viên hoạt động.`,
      metadata: { projectId, warning: 'NO_ACTIVE_AUDITOR' },
      priority: 'HIGH',
      enqueuedBy: 'system'
    })));
  } catch (error) {
    logger.error('Không thể tạo thông báo NO_ACTIVE_AUDITOR.', { projectId, errorMessage: (error as Error).message });
  }
}

/** Hàm lấy trạng thái đủ điều kiện tạo dự án. Mục đích: trả thông tin để frontend chủ động khóa nút tạo dự án theo nghiệp vụ ngân hàng thụ hưởng. */
export async function getCreateProjectEligibilityForOrganization(organizationUserId: string): Promise<CreateProjectEligibilityResult> {
  const organizationUser = await ensureOrganizationUser(organizationUserId);
  const organizationSubmissionList = await findSubmissionsByOrganizationId(organizationUser.id);

  // Logic này đồng bộ đúng với rule tạo dự án ở backend để tránh lệch hành vi giữa pre-check và create API.
  const hasApprovedBeneficiaryBankAccount = organizationSubmissionList.some(submissionItem => submissionItem.status === 'APPROVED');
  if (!hasApprovedBeneficiaryBankAccount) {
    return {
      isEligibleToCreateProject: false,
      blockReason: 'Bạn cần liên kết và được duyệt tài khoản ngân hàng thụ hưởng trước khi tạo dự án. Vui lòng vào Cài đặt để thiết lập ngân hàng.'
    };
  }

  return {
    isEligibleToCreateProject: true,
    blockReason: null
  };
}

/** Hàm upload danh sách file minh chứng dự án. Mục đích: nhận CID từ Pinata để frontend dùng khi tạo dự án. */
export async function uploadProjectEvidencesForOrganization(
  organizationUserId: string,
  payload: UploadProjectEvidencesPayload
): Promise<{ evidenceCids: string[]; evidenceFiles: UploadedProjectEvidenceItem[] }> {
  await ensureOrganizationUser(organizationUserId);
  validateUploadProjectEvidencesPayload(payload);

  // Logic này upload song song nhiều file để giảm thời gian chờ cho người dùng khi chọn nhiều minh chứng.
  const evidenceFiles = await Promise.all(payload.files.map(fileItem => uploadProjectEvidenceFileToPinataWithRetry(fileItem)));
  return {
    evidenceCids: evidenceFiles.map(fileItem => fileItem.cid),
    evidenceFiles
  };
}

/** Hàm lấy danh sách dự án của tổ chức. Mục đích: trả dữ liệu thật cho trang "Dự án của tôi" theo user đăng nhập. */
export async function getProjectsForOrganization(organizationUserId: string): Promise<CreateProjectResult[]> {
  const organizationUser = await ensureOrganizationUser(organizationUserId);
  const projectRecords = await findProjectsByOrganizationIdFromRepository(organizationUser.id);
  const geofenceProjectIdSet = await findProjectIdsWithGeofence(projectRecords.map(projectRecord => projectRecord.projectId));
  return projectRecords.map(projectRecord => mapProjectRecordToResult(
    projectRecord,
    geofenceProjectIdSet.has(projectRecord.projectId)
  ));
}

/** Hàm lấy danh sách dự án active public cho trang chủ. Mục đích: cung cấp dữ liệu thật từ MongoDB cho section “Dự án đang cần hỗ trợ”. */
export async function getPublicSupportProjects(limitCount = 6): Promise<PublicSupportProjectResult[]> {
  const sanitizedLimitCount = Number.isFinite(limitCount) ? Math.max(1, Math.min(12, Math.floor(limitCount))) : 6;
  const cacheKey = createPublicSupportCacheKey(sanitizedLimitCount);

  try {
    const cachedProjects = publicSupportProjectsCache.get(cacheKey);
    if (cachedProjects) {
      logger.info(`public-support cache_hit: ${cacheKey}`);
      return cachedProjects;
    }

    logger.info(`public-support cache_miss: ${cacheKey}`);
  } catch (error) {
    // Ghi chú logic phức tạp: cache lỗi không được làm endpoint fail, nên chỉ log cảnh báo và đi tiếp DB path.
    logger.warn(`public-support cache_get_error: ${cacheKey}`, { errorMessage: (error as Error).message });
  }

  const projectRecords = await findPublicSupportProjectsFromRepository(sanitizedLimitCount);
  const mappedProjects = projectRecords.map(projectRecord => ({
    projectId: projectRecord.projectId,
    name: projectRecord.name,
    description: projectRecord.description,
    goalAmount: projectRecord.goalAmount,
    deadline: projectRecord.deadline,
    status: projectRecord.status,
    evidenceCids: projectRecord.evidenceCids,
    evidenceFiles: projectRecord.evidenceFiles || [],
    updatedAt: projectRecord.updatedAt,
    createdAt: projectRecord.createdAt
  }));

  try {
    publicSupportProjectsCache.set(cacheKey, mappedProjects, getPublicSupportCacheTimeToLiveSeconds());
    logger.info(`public-support cache_set: ${cacheKey}`);
  } catch (error) {
    logger.warn(`public-support cache_set_error: ${cacheKey}`, { errorMessage: (error as Error).message });
  }

  return mappedProjects;
}

/** Hàm lấy chi tiết dự án public theo projectId. Mục đích: trả dữ liệu cho modal “Chi tiết” ở trang chủ. */
export async function getPublicSupportProjectDetail(projectId: string): Promise<PublicSupportProjectDetailResult | null> {
  const sanitizedProjectId = sanitizeTextInput(projectId);
  if (!sanitizedProjectId) {
    throw new ApplicationError('ProjectId không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  const projectRecord = await findPublicSupportProjectDetailFromRepository(sanitizedProjectId);
  if (!projectRecord) {
    return null;
  }

  // Lookup tên người tạo dự án từ bảng AuthUser dựa trên organizationId.
  // Ưu tiên fullName, fallback về organizationName nếu fullName trống.
  let creatorName: string | null = null;
  try {
    const creatorUser = await findUserById(projectRecord.organizationId);
    if (creatorUser) {
      creatorName = creatorUser.fullName?.trim() || creatorUser.organizationName || null;
    }
  } catch {
    // Lookup thất bại không làm fail request — log và tiếp tục trả dữ liệu project.
    logger.warn(`Không tìm được thông tin người tạo dự án. projectId=${sanitizedProjectId} organizationId=${projectRecord.organizationId}`);
  }

  // Lookup thời gian donation gần nhất từ bảng Donation thay vì updatedAt của project record.
  // Nếu chưa có donation nào, trả về null và frontend sẽ hiển thị "Chưa có donation".
  let lastDonationAt: Date | null = null;
  try {
    lastDonationAt = await findLatestDonationTimestampByProjectIdFromRepository(sanitizedProjectId);
  } catch {
    logger.warn(`Không tìm được thời gian donation gần nhất. projectId=${sanitizedProjectId}`);
  }

  return {
    projectId: projectRecord.projectId,
    name: projectRecord.name,
    description: projectRecord.description,
    goalAmount: projectRecord.goalAmount,
    status: projectRecord.status,
    lastDonationAt,
    evidenceCids: projectRecord.evidenceCids,
    evidenceFiles: projectRecord.evidenceFiles || [],
    creatorName
  };
}

/** Hàm lấy danh sách dự án chờ duyệt cho reviewer. Mục đích: cung cấp dữ liệu thật cho màn hình “Duyệt dự án mới”. */
export async function getPendingApprovalProjectsForReviewer(reviewerUserId: string): Promise<CreateProjectResult[]> {
  await ensureReviewerUser(reviewerUserId);
  const projectRecords = await findProjectsByStatusFromRepository('PENDING_APPROVAL');
  return projectRecords.map(projectRecord => mapProjectRecordToResult(projectRecord));
}

/** Hàm lấy queue và lịch sử review để Regulatory tra cứu đầy đủ dự án chờ duyệt, đã duyệt và đã từ chối. */
export async function getProjectReviewHistoryForReviewer(reviewerUserId: string): Promise<CreateProjectResult[]> {
  await ensureReviewerUser(reviewerUserId);
  const projectRecords = await findProjectsByStatusListFromRepository([
    'PENDING_APPROVAL',
    'PENDING_ACTIVATION',
    'DISPUTED',
    'ACTIVE',
    'REJECTED'
  ]);
  return projectRecords.map(projectRecord => mapProjectRecordToResult(projectRecord));
}

/** Hàm cập nhật dự án của tổ chức. Mục đích: cho phép sửa nội dung dự án và thay thế minh chứng kèm cleanup CID cũ trên Pinata. */
export async function updateProjectForOrganization(organizationUserId: string, payload: UpdateProjectPayload): Promise<CreateProjectResult> {
  validateUpdateProjectPayload(payload);
  const organizationUser = await ensureOrganizationUser(organizationUserId);

  const existingProject = await findProjectById(payload.projectId);
  if (!existingProject || existingProject.organizationId !== organizationUser.id) {
    throw new ApplicationError('Không tìm thấy dự án thuộc tổ chức của bạn.', 404, 'NOT_FOUND');
  }

  if (existingProject.status !== 'DRAFT' && existingProject.status !== 'PENDING_APPROVAL' && existingProject.status !== 'REJECTED') {
    throw new ApplicationError('Chỉ dự án chưa duyệt hoặc bị từ chối mới được cập nhật.', 409, 'INVALID_STATUS_TRANSITION');
  }

  const sanitizedName = sanitizeTextInput(payload.name);
  const sanitizedDescription = sanitizeTextInput(payload.description);
  const sanitizedEvidenceCids = payload.evidenceCids.map(cid => sanitizeTextInput(cid));
  const sanitizedEvidenceFiles = sanitizeProjectEvidenceFiles(payload.evidenceFiles, sanitizedEvidenceCids);

  const existingProjectWithSameName = await findProjectByOrganizationAndName(organizationUser.id, sanitizedName);
  if (existingProjectWithSameName && existingProjectWithSameName.projectId !== payload.projectId) {
    throw new ApplicationError('Tên dự án đã tồn tại trong tổ chức của bạn.', 409, 'CONFLICT');
  }

  const removedEvidenceCids = existingProject.evidenceCids.filter(existingCid => !sanitizedEvidenceCids.includes(existingCid));

  // Logic này chỉ xóa các CID không còn được sử dụng sau cập nhật để tránh xóa nhầm minh chứng vẫn còn gắn với dự án.
  await Promise.all(removedEvidenceCids.map(cid => unpinProjectEvidenceCidFromPinataWithRetry(cid)));

  const now = new Date();
  const updatedProject = await updateProject(payload.projectId, {
    name: sanitizedName,
    description: sanitizedDescription,
    goalAmount: payload.goalAmount,
    deadline: new Date(payload.deadline),
    evidenceCids: sanitizedEvidenceCids,
    evidenceFiles: sanitizedEvidenceFiles,
    milestonePlan: payload.milestonePlan || [],
    submittedAt: existingProject.status === 'PENDING_APPROVAL' ? null : existingProject.submittedAt,
    status: existingProject.status === 'PENDING_APPROVAL' ? 'DRAFT' : existingProject.status,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    updatedAt: now
  });

  if (!updatedProject) {
    throw new ApplicationError('Không thể cập nhật dự án.', 500, 'INTERNAL_ERROR');
  }

  return mapProjectRecordToResult(updatedProject);
}

/** Cập nhật riêng kế hoạch cột mốc để không unpin lại minh chứng IPFS khi NGO chỉ đổi kế hoạch. */
export async function updateProjectMilestonePlanForOrganization(organizationUserId: string, projectId: string, milestonePlan: ProjectMilestonePlanItem[]): Promise<CreateProjectResult> {
  const organizationUser = await ensureOrganizationUser(organizationUserId);
  const project = await findProjectById(projectId);
  if (!project || project.organizationId !== organizationUser.id) throw new ApplicationError('Không tìm thấy dự án thuộc tổ chức của bạn.', 404, 'NOT_FOUND');
  if (!['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(project.status)) throw new ApplicationError('Dự án không còn cho phép sửa kế hoạch cột mốc.', 409, 'INVALID_STATUS_TRANSITION');
  const updated = await updateProject(projectId, { milestonePlan, status: project.status === 'PENDING_APPROVAL' ? 'DRAFT' : project.status, submittedAt: project.status === 'PENDING_APPROVAL' ? null : project.submittedAt, updatedAt: new Date() });
  if (!updated) throw new ApplicationError('Không thể cập nhật kế hoạch cột mốc.', 500, 'INTERNAL_ERROR');
  return mapProjectRecordToResult(updated);
}

/** Hàm submit dự án để chờ duyệt. Mục đích: chuyển trạng thái DRAFT thành PENDING_APPROVAL. */
export async function submitProjectForApproval(organizationUserId: string, projectId: string): Promise<CreateProjectResult> {
  const organizationUser = await ensureOrganizationUser(organizationUserId);
  const existingProject = await findProjectById(projectId);
  if (!existingProject || existingProject.organizationId !== organizationUser.id) {
    throw new ApplicationError('Không tìm thấy dự án thuộc tổ chức của bạn.', 404, 'NOT_FOUND');
  }

  if (existingProject.status !== 'DRAFT' && existingProject.status !== 'REJECTED') {
    throw new ApplicationError('Chỉ dự án DRAFT hoặc REJECTED mới được submit lại.', 409, 'INVALID_STATUS_TRANSITION');
  }

  if ((existingProject.milestonePlan || []).length !== 3) {
    throw new ApplicationError('Dự án chưa có kế hoạch cột mốc M1, M2, M3 trước khi gửi duyệt.', 409, 'MILESTONE_PLAN_REQUIRED');
  }

  const geofence = await findGeofenceByProjectId(projectId);
  if (!geofence) {
    throw new ApplicationError('Vui lòng thiết lập và lưu vùng địa lý trước khi gửi yêu cầu duyệt.', 409, 'GEOFENCE_REQUIRED');
  }

  const now = new Date();
  const updatedProject = await updateProject(projectId, {
    status: 'PENDING_APPROVAL',
    submittedAt: now,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    updatedAt: now
  });

  if (!updatedProject) {
    throw new ApplicationError('Không thể cập nhật trạng thái dự án.', 500, 'INTERNAL_ERROR');
  }
  return mapProjectRecordToResult(updatedProject, true);
}

/** Hàm review dự án. Mục đích: approve thành ACTIVE hoặc reject với lý do rõ ràng. */
export async function reviewProjectByReviewer(
  reviewerUserId: string,
  projectId: string,
  action: 'APPROVE' | 'REJECT',
  rejectionReason?: string
): Promise<CreateProjectResult> {
  const reviewerUser = await ensureReviewerUser(reviewerUserId);
  const existingProject = await findProjectById(projectId);
  if (!existingProject) {
    throw new ApplicationError('Không tìm thấy dự án.', 404, 'NOT_FOUND');
  }

  if (existingProject.status !== 'PENDING_APPROVAL') {
    throw new ApplicationError('Dự án không ở trạng thái chờ duyệt.', 409, 'INVALID_STATUS_TRANSITION');
  }

  if (action === 'APPROVE') {
    const activeProjectCount = await countActiveProjectsByOrganizationIdFromRepository(existingProject.organizationId);
    if (activeProjectCount >= 5) {
      throw new ApplicationError('Tổ chức đã đạt giới hạn 5 dự án ACTIVE.', 409, 'ACTIVE_PROJECT_LIMIT_EXCEEDED');
    }
  }

  const now = new Date();
  const nextStatus = action === 'APPROVE' ? 'PENDING_ACTIVATION' : 'REJECTED';
  const listedAt = action === 'APPROVE' ? now : null;
  const updatedProject = await updateProject(projectId, {
    status: nextStatus,
    reviewedAt: now,
    reviewedBy: reviewerUser.id,
    rejectionReason: action === 'REJECT' ? sanitizeTextInput(rejectionReason || '') : null,
    listedAt,
    activationEligibleAt: listedAt ? new Date(listedAt.getTime() + getChallengeWindowMs()) : null,
    activationClaimedAt: null,
    activationState: 'NOT_STARTED',
    activationAttemptCount: 0,
    activationLastAttemptAt: null,
    activationLastError: null,
    listingRound: action === 'APPROVE' ? (existingProject.listingRound || 0) + 1 : existingProject.listingRound || 0,
    updatedAt: now
  });

  if (!updatedProject) {
    throw new ApplicationError('Không thể cập nhật kết quả review dự án.', 500, 'INTERNAL_ERROR');
  }
  const warning = action === 'APPROVE' && await countActiveAuditors() === 0 ? 'NO_ACTIVE_AUDITOR' : null;
  if (warning) {
    logger.error('Dự án được niêm yết khi chưa có Kiểm toán viên hoạt động.', { projectId, reviewerUserId });
    await notifyNoActiveAuditor(projectId);
  }
  return { ...mapProjectRecordToResult(updatedProject), warning };
}
