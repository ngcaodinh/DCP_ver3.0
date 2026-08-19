import crypto from 'crypto';
import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import { AuthUser, addAuditLog, findUserById, findUserByLegalRegistrationNumber, updateUser } from '../models/authModel';
import {
  OrganizationKycFile,
  OrganizationKycSubmission,
  createOrganizationKycSubmission,
  findExistingBankAccountOwner,
  findFoundationKycSubmissions,
  findLatestSubmissionByOrganizationId,
  findPendingKycSubmissions,
  findSubmissionBySubmissionId,
  findSubmissionsByOrganizationId,
  getLatestSubmissionVersion,
  updateOrganizationKycSubmissionReview
} from '../models/organizationKycModel';
import { changeUserRole, revokeUserAccess } from './authAdminService';

export type OrganizationKycFileInput = {
  fileName: string;
  mimeType: string;
  fileSize: number;
  base64Content: string;
  documentType: string;
};

export type OrganizationKycSubmitPayload = {
  organizationName: string;
  legalRegistrationNumber: string;
  officialWebsite: string;
  organizationDescription: string;
  files: OrganizationKycFileInput[];
};

export type BeneficiaryBankAccountSubmissionPayload = {
  bankName: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName?: string;
};

const maxFileSizeBytes = 10 * 1024 * 1024;
const allowedMimeTypeSet = new Set(['application/pdf', 'image/png', 'image/jpg', 'image/jpeg']);
const pinataPinFileEndpoint = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const pinataRequestTimeoutMilliseconds = 15000;
const pinataMaximumRetryCount = 2;
const donationRankingContractAbi = [
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function projectManagerRole() external view returns (bytes32)',
  'function grantProjectManagerRole(address account) external'
];
const multisigDisbursementContractAbi = [
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function ORG_SIGNER_ROLE() external view returns (bytes32)',
  'function grantOrgSignerRole(address account) external'
];

const logger = getLogger();

/** Hàm lấy contract admin cho donation ranking. Mục đích: phục vụ cấp quyền PROJECT_MANAGER_ROLE cho organization sau khi KYC được duyệt. */
function getDonationRankingAdminContract() {
  const blockchainRpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
  const donationRankingContractAddress = process.env.DONATION_RANKING_CONTRACT_ADDRESS?.trim() || process.env.DONATION_RANKING_ADDRESS?.trim() || '';
  const adminPrivateKey = process.env.DONATION_ADMIN_PRIVATE_KEY?.trim() || '';
  const expectedChainId = Number(process.env.BLOCKCHAIN_CHAIN_ID || 0);

  if (!blockchainRpcUrl || !donationRankingContractAddress || !adminPrivateKey) {
    throw new Error('Thiếu cấu hình cấp quyền blockchain. Cần BLOCKCHAIN_RPC_URL, DONATION_RANKING_CONTRACT_ADDRESS và DONATION_ADMIN_PRIVATE_KEY.');
  }

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const adminSigner = new ethers.Wallet(adminPrivateKey, provider);
  const donationRankingContract = new ethers.Contract(donationRankingContractAddress, donationRankingContractAbi, adminSigner);

  return {
    provider,
    adminSigner,
    donationRankingContract,
    expectedChainId
  };
}

/** Hàm cấp PROJECT_MANAGER_ROLE cho ví organization. Mục đích: đảm bảo tài khoản organizations có quyền tạo project on-chain ngay sau khi KYC approve. */
async function ensureOrganizationWalletProjectManagerRole(walletAddress: string): Promise<{ transactionHash: string | null; wasAlreadyGranted: boolean }> {
  const normalizedWalletAddress = walletAddress.trim();
  if (!normalizedWalletAddress || !ethers.isAddress(normalizedWalletAddress)) {
    throw new Error('Địa chỉ ví organization không hợp lệ để cấp quyền blockchain.');
  }

  const { provider, donationRankingContract, expectedChainId } = getDonationRankingAdminContract();
  const network = await provider.getNetwork();
  if (expectedChainId > 0 && Number(network.chainId) !== expectedChainId) {
    throw new Error('Sai network blockchain của dịch vụ cấp quyền organization.');
  }

  const projectManagerRoleHash = await donationRankingContract.projectManagerRole();
  const hasProjectManagerRole = await donationRankingContract.hasRole(projectManagerRoleHash, normalizedWalletAddress);
  if (hasProjectManagerRole) {
    return { transactionHash: null, wasAlreadyGranted: true };
  }

  const grantRoleTransaction = await donationRankingContract.grantProjectManagerRole(normalizedWalletAddress);
  const grantRoleReceipt = await grantRoleTransaction.wait();

  // Ghi chú logic phức tạp: kiểm tra receipt status để fail-fast khi transaction bị mined nhưng thất bại ở EVM.
  if (grantRoleReceipt && Number(grantRoleReceipt.status) !== 1) {
    throw new Error(`Transaction cấp PROJECT_MANAGER_ROLE thất bại. txHash=${grantRoleTransaction.hash}`);
  }

  const hasProjectManagerRoleAfterGrant = await donationRankingContract.hasRole(projectManagerRoleHash, normalizedWalletAddress);
  if (!hasProjectManagerRoleAfterGrant) {
    throw new Error(`Cấp PROJECT_MANAGER_ROLE thất bại cho ví ${normalizedWalletAddress}. txHash=${grantRoleTransaction.hash}`);
  }

  return { transactionHash: grantRoleTransaction.hash, wasAlreadyGranted: false };
}

/** Hàm lấy contract admin cho MultisigDisbursement. Mục đích: cấp quyền ORG_SIGNER_ROLE cho organization sau khi KYC được duyệt. */
function getMultisigDisbursementAdminContract() {
  const blockchainRpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() || '';
  const multisigDisbursementAddress = process.env.MULTISIG_DISBURSEMENT_ADDRESS?.trim() || '';
  const adminPrivateKey = process.env.DONATION_ADMIN_PRIVATE_KEY?.trim() || '';

  if (!blockchainRpcUrl || !multisigDisbursementAddress || !adminPrivateKey) {
    throw new Error('Thiếu cấu hình cấp quyền blockchain. Cần BLOCKCHAIN_RPC_URL, MULTISIG_DISBURSEMENT_ADDRESS và DONATION_ADMIN_PRIVATE_KEY.');
  }

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const adminSigner = new ethers.Wallet(adminPrivateKey, provider);
  const multisigDisbursementContract = new ethers.Contract(multisigDisbursementAddress, multisigDisbursementContractAbi, adminSigner);

  return { provider, adminSigner, multisigDisbursementContract };
}

/** Hàm cấp ORG_SIGNER_ROLE cho ví organization trên MultisigDisbursement. Mục đích: đảm bảo tổ chức có quyền tạo yêu cầu giải ngân on-chain. */
export async function ensureOrganizationWalletOrgSignerRole(walletAddress: string): Promise<{ transactionHash: string | null; wasAlreadyGranted: boolean }> {
  const normalizedWalletAddress = walletAddress.trim();
  if (!normalizedWalletAddress || !ethers.isAddress(normalizedWalletAddress)) {
    throw new Error('Địa chỉ ví organization không hợp lệ để cấp quyền ORG_SIGNER_ROLE.');
  }

  const { multisigDisbursementContract } = getMultisigDisbursementAdminContract();

  const orgSignerRoleHash = await multisigDisbursementContract.ORG_SIGNER_ROLE();
  const hasOrgSignerRole = await multisigDisbursementContract.hasRole(orgSignerRoleHash, normalizedWalletAddress);
  if (hasOrgSignerRole) {
    return { transactionHash: null, wasAlreadyGranted: true };
  }

  const grantRoleTransaction = await multisigDisbursementContract.grantOrgSignerRole(normalizedWalletAddress);
  const grantRoleReceipt = await grantRoleTransaction.wait();

  if (grantRoleReceipt && Number(grantRoleReceipt.status) !== 1) {
    throw new Error(`Transaction cấp ORG_SIGNER_ROLE thất bại. txHash=${grantRoleTransaction.hash}`);
  }

  const hasOrgSignerRoleAfterGrant = await multisigDisbursementContract.hasRole(orgSignerRoleHash, normalizedWalletAddress);
  if (!hasOrgSignerRoleAfterGrant) {
    throw new Error(`Cấp ORG_SIGNER_ROLE thất bại cho ví ${normalizedWalletAddress}. txHash=${grantRoleTransaction.hash}`);
  }

  return { transactionHash: grantRoleTransaction.hash, wasAlreadyGranted: false };
}

/** Hàm ghi audit log cho KYC review và cấp role on-chain. Mục đích: truy vết đầy đủ reviewer, organization, wallet và transaction blockchain. */
async function addOrganizationKycAuditLog(params: {
  reviewerUserId: string;
  organizationUserId: string;
  organizationEmail: string | null;
  action: OrganizationKycReviewAction;
  walletAddress: string;
  status: 'SUCCESS' | 'FAILED';
  transactionHash: string | null;
  detailMessage: string;
}): Promise<void> {
  await addAuditLog({
    id: crypto.randomUUID(),
    userId: params.organizationUserId,
    email: params.organizationEmail,
    eventType: `ORGANIZATION_KYC_REVIEW_${params.action.toUpperCase()}_${params.status}`,
    ipAddress: 'SYSTEM',
    userAgent: `reviewer:${params.reviewerUserId}`,
    detail: `walletAddress=${params.walletAddress}; txHash=${params.transactionHash || 'N/A'}; detail=${params.detailMessage}`,
    createdAt: new Date()
  });
}


/**
 * Hàm kiểm tra dữ liệu hồ sơ KYC đầu vào.
 * Mục đích: chặn dữ liệu sai chuẩn trước khi upload lên Pinata.
 */
function validateOrganizationKycPayload(payload: OrganizationKycSubmitPayload): void {
  if (!payload.organizationName.trim() || !payload.legalRegistrationNumber.trim() || !payload.organizationDescription.trim()) {
    throw new Error('Thông tin tổ chức chưa đầy đủ.');
  }

  if (!Array.isArray(payload.files) || payload.files.length < 1 || payload.files.length > 3) {
    throw new Error('Bộ hồ sơ KYC phải có từ 1 đến 3 file.');
  }

  payload.files.forEach((file) => {
    if (!allowedMimeTypeSet.has(file.mimeType.toLowerCase())) {
      throw new Error(`Định dạng file không hợp lệ: ${file.fileName}`);
    }
    if (file.fileSize <= 0 || file.fileSize > maxFileSizeBytes) {
      throw new Error(`Dung lượng file vượt ngưỡng 10MB: ${file.fileName}`);
    }
    if (!file.base64Content.trim()) {
      throw new Error(`Nội dung file trống: ${file.fileName}`);
    }
  });
}

/**
 * Hàm lấy JWT Pinata từ biến môi trường.
 * Mục đích: đảm bảo chỉ thực hiện upload IPFS khi đã cấu hình chứng thực đầy đủ.
 */
function getPinataJsonWebToken(): string {
  const pinataJsonWebToken = process.env.PINATA_JWT?.trim() || '';
  if (!pinataJsonWebToken) {
    throw new Error('Thiếu cấu hình PINATA_JWT trên backend.');
  }
  return pinataJsonWebToken;
}

/**
 * Hàm upload một file KYC lên Pinata/IPFS.
 * Mục đích: gửi file nhị phân lên Pinata và nhận CID phục vụ lưu metadata.
 */
async function uploadFileToPinata(file: OrganizationKycFileInput): Promise<string> {
  const pinataJsonWebToken = getPinataJsonWebToken();
  const binaryBuffer = Buffer.from(file.base64Content, 'base64');

  if (!binaryBuffer.length) {
    throw new Error(`Nội dung base64 không hợp lệ: ${file.fileName}`);
  }

  const uploadFormData = new FormData();
  const fileBlob = new Blob([binaryBuffer], { type: file.mimeType });
  uploadFormData.append('file', fileBlob, file.fileName);
  uploadFormData.append(
    'pinataMetadata',
    JSON.stringify({
      name: file.fileName,
      keyvalues: {
        documentType: file.documentType,
        mimeType: file.mimeType
      }
    })
  );

  const pinataResponse = await fetch(pinataPinFileEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pinataJsonWebToken}`
    },
    body: uploadFormData,
    signal: AbortSignal.timeout(pinataRequestTimeoutMilliseconds)
  });

  const pinataResponseData = (await pinataResponse.json()) as { IpfsHash?: string; error?: string };
  if (!pinataResponse.ok || !pinataResponseData.IpfsHash) {
    throw new Error(pinataResponseData.error || `Upload Pinata thất bại: ${file.fileName}`);
  }

  return pinataResponseData.IpfsHash;
}

/**
 * Hàm upload file với cơ chế retry giới hạn.
 * Mục đích: tăng độ ổn định khi Pinata timeout hoặc lỗi tạm thời.
 */
export async function uploadFileToPinataWithRetry(file: OrganizationKycFileInput): Promise<string> {
  let latestUploadError: Error | null = null;

  for (let retryAttempt = 1; retryAttempt <= pinataMaximumRetryCount; retryAttempt += 1) {
    try {
      return await uploadFileToPinata(file);
    } catch (error) {
      latestUploadError = error instanceof Error ? error : new Error('Upload Pinata thất bại.');
    }
  }

  throw latestUploadError || new Error('Upload Pinata thất bại.');
}

/**
 * Hàm xử lý nộp hồ sơ KYC của tổ chức.
 * Mục đích: upload file lên IPFS, lưu metadata phiên bản hóa và cập nhật trạng thái tài khoản.
 */
export async function submitOrganizationKyc(
  userId: string,
  payload: OrganizationKycSubmitPayload
): Promise<{ submissionId: string; version: number; status: string }> {
  validateOrganizationKycPayload(payload);

  const organizationUser = await findUserById(userId);
  if (!organizationUser || (organizationUser.role !== 'honor' && organizationUser.role !== 'donor')) {
    throw new Error('Chỉ tài khoản role donor hoặc honor mới được nộp hồ sơ KYC.');
  }

  const existingLegalRegistrationOwner = await findUserByLegalRegistrationNumber(payload.legalRegistrationNumber.trim());
  if (existingLegalRegistrationOwner && existingLegalRegistrationOwner.id !== organizationUser.id) {
    throw new Error('Mã số đăng ký pháp lý đã tồn tại.');
  }

  const nextVersion = (await getLatestSubmissionVersion(organizationUser.id)) + 1;
  const now = new Date();
  const submissionId = crypto.randomUUID();

  const uploadedFiles: OrganizationKycFile[] = await Promise.all(
    payload.files.map(async (file) => ({
      cid: await uploadFileToPinataWithRetry(file),
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.fileSize,
      documentType: file.documentType,
      version: nextVersion,
      uploadedBy: organizationUser.id,
      uploadedAt: now,
      reviewStatus: 'PENDING_REVIEW',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null
    }))
  );

  try {
    await createOrganizationKycSubmission({
      submissionId,
      organizationId: organizationUser.id,
      organizationName: payload.organizationName.trim(),
      legalRegistrationNumber: payload.legalRegistrationNumber.trim(),
      officialWebsite: payload.officialWebsite.trim() || null,
      organizationDescription: payload.organizationDescription.trim(),
      version: nextVersion,
      status: 'PENDING_REVIEW',
      submittedBy: organizationUser.id,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      beneficiaryBankAccount: null,
      files: uploadedFiles
    });

    await updateUser({
      ...organizationUser,
      organizationName: payload.organizationName.trim(),
      legalRegistrationNumber: payload.legalRegistrationNumber.trim(),
      accountStatus: 'INACTIVE_PENDING_KYC'
    } as AuthUser);

    return { submissionId, version: nextVersion, status: 'PENDING_REVIEW' };
  } catch (error) {
    // Ghi chú logic phức tạp: file đã pin thành công nhưng lưu metadata lỗi,
    // cần ghi nhận trạng thái SUBMISSION_ERROR để tránh duyệt nhầm và phục vụ đồng bộ lại.
    await createOrganizationKycSubmission({
      submissionId,
      organizationId: organizationUser.id,
      organizationName: payload.organizationName.trim(),
      legalRegistrationNumber: payload.legalRegistrationNumber.trim(),
      officialWebsite: payload.officialWebsite.trim() || null,
      organizationDescription: payload.organizationDescription.trim(),
      version: nextVersion,
      status: 'SUBMISSION_ERROR',
      submittedBy: organizationUser.id,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: error instanceof Error ? error.message : 'Lỗi lưu metadata sau khi upload Pinata.',
      beneficiaryBankAccount: null,
      files: uploadedFiles
    });

    throw new Error('Đã upload file lên IPFS nhưng lưu metadata thất bại. Hồ sơ ở trạng thái SUBMISSION_ERROR.');
  }
}

export type OrganizationKycReviewAction = 'approve' | 'reject';

export type OrganizationKycReviewPayload = {
  action: OrganizationKycReviewAction;
  rejectionReason?: string;
};

export type OrganizationKycReviewResult = {
  submission: OrganizationKycSubmission;
  accountUpdate: {
    userId: string;
    previousRole: string;
    updatedRole: string;
    previousAccountStatus: AuthUser['accountStatus'];
    updatedAccountStatus: AuthUser['accountStatus'];
    roleUpdated: boolean;
  } | null;
};

/**
 * Review hồ sơ FOUNDATION chỉ cập nhật trạng thái off-chain và audit log.
 * Mục đích: bảo đảm quỹ đại diện không bị tìm user, đổi role hoặc gọi contract.
 */
async function reviewFoundationKycSubmission(
  reviewerUserId: string,
  existingSubmission: OrganizationKycSubmission,
  reviewPayload: OrganizationKycReviewPayload
): Promise<OrganizationKycReviewResult> {
  if (reviewPayload.action !== 'approve' && reviewPayload.action !== 'reject') {
    throw new Error('Hành động review hồ sơ KYC FOUNDATION không hợp lệ.');
  }

  const normalizedRejectionReason = reviewPayload.rejectionReason?.trim() || '';
  if (reviewPayload.action === 'reject' && normalizedRejectionReason.length === 0) {
    throw new Error('Vui lòng nhập lý do từ chối hồ sơ KYC FOUNDATION.');
  }

  const reviewStatus: OrganizationKycFile['reviewStatus'] = reviewPayload.action === 'approve'
    ? 'APPROVED'
    : 'REJECTED';
  const reviewDateTime = new Date();
  const reviewedFiles: OrganizationKycFile[] = existingSubmission.files.map((fileItem) => ({
    ...fileItem,
    reviewStatus,
    reviewedBy: reviewerUserId,
    reviewedAt: reviewDateTime,
    rejectionReason: reviewPayload.action === 'reject' ? normalizedRejectionReason : null
  }));
  const updatedSubmission = await updateOrganizationKycSubmissionReview(existingSubmission.submissionId, {
    status: reviewStatus,
    reviewedBy: reviewerUserId,
    reviewedAt: reviewDateTime,
    rejectionReason: reviewPayload.action === 'reject' ? normalizedRejectionReason : null,
    files: reviewedFiles
  });

  if (!updatedSubmission) {
    throw new Error('Cập nhật trạng thái hồ sơ KYC FOUNDATION thất bại.');
  }

  await addAuditLog({
    id: crypto.randomUUID(),
    userId: null,
    email: null,
    eventType: `FOUNDATION_KYC_REVIEW_${reviewPayload.action.toUpperCase()}_SUCCESS`,
    ipAddress: 'SYSTEM',
    userAgent: `reviewer:${reviewerUserId}`,
    detail: `submissionId=${existingSubmission.submissionId}`,
    createdAt: reviewDateTime
  });

  return { submission: updatedSubmission, accountUpdate: null };
}

/**
 * Hàm lấy danh sách hồ sơ KYC chờ duyệt.
 * Mục đích: cung cấp dữ liệu cho giao diện regulatory xử lý phê duyệt.
 */
export async function getPendingOrganizationKycSubmissions(): Promise<OrganizationKycSubmission[]> {
  return findPendingKycSubmissions();
}

/** Lấy lịch sử hồ sơ pháp nhân đại diện để Regulatory theo dõi đầy đủ trạng thái xử lý. */
export async function getFoundationOrganizationKycSubmissions(): Promise<OrganizationKycSubmission[]> {
  return findFoundationKycSubmissions();
}

/**
 * Hàm lấy danh sách hồ sơ KYC của tổ chức theo user đăng nhập.
 * Mục đích: cung cấp dữ liệu thật để frontend xác định trạng thái duyệt tài khoản thụ hưởng.
 */
export async function getOrganizationKycSubmissionsByUserId(userId: string): Promise<OrganizationKycSubmission[]> {
  const organizationUser = await findUserById(userId);
  if (!organizationUser) {
    throw new Error('Không tìm thấy thông tin tổ chức.');
  }

  return findSubmissionsByOrganizationId(organizationUser.id);
}

/**
 * Hàm lấy profile tổ chức của user hiện tại.
 * Mục đích: trả dữ liệu thật cho tab cài đặt tổ chức, ưu tiên hồ sơ KYC mới nhất.
 */
export async function getMyOrganizationProfile(userId: string): Promise<OrganizationProfileView | null> {
  const organizationUser = await findUserById(userId);
  if (!organizationUser) {
    throw new Error('Không tìm thấy thông tin tổ chức.');
  }

  const latestSubmission = await findLatestSubmissionByOrganizationId(organizationUser.id);
  if (!latestSubmission) {
    return null;
  }

  return {
    organizationName: latestSubmission.organizationName,
    legalRegistrationNumber: latestSubmission.legalRegistrationNumber,
    officialWebsite: latestSubmission.officialWebsite || null,
    organizationDescription: latestSubmission.organizationDescription || null
  };
}


export type OrganizationProfileView = {
  organizationName: string;
  legalRegistrationNumber: string;
  officialWebsite: string | null;
  organizationDescription: string | null;
};

export type BeneficiaryBankAccountSubmissionResult = {
  submissionId: string;
  version: number;
  status: string;
  isExistingPendingSubmission: boolean;
};

/** Hàm nộp thông tin tài khoản ngân hàng thụ hưởng. Mục đích: tạo hồ sơ KYC chờ duyệt theo cơ chế idempotent để tránh tạo trùng request, đồng thời đảm bảo mỗi tài khoản ngân hàng chỉ được liên kết duy nhất với một tổ chức. */
export async function submitBeneficiaryBankAccount(
  userId: string,
  payload: BeneficiaryBankAccountSubmissionPayload
): Promise<BeneficiaryBankAccountSubmissionResult> {
  const organizationUser = await findUserById(userId);
  if (!organizationUser) {
    throw new Error('Không tìm thấy thông tin tổ chức.');
  }

  const normalizedBankName = payload.bankName?.trim() || '';
  const normalizedBankAccountNumber = payload.bankAccountNumber?.trim() || '';
  const normalizedAccountHolderName = payload.accountHolderName?.trim() || '';
  const normalizedBranchName = payload.branchName?.trim() || '';

  if (!normalizedBankName) {
    throw new Error('Tên ngân hàng là bắt buộc.');
  }
  if (!normalizedAccountHolderName) {
    throw new Error('Tên chủ tài khoản là bắt buộc.');
  }
  if (!/^[0-9]{8,20}$/.test(normalizedBankAccountNumber)) {
    throw new Error('Số tài khoản phải là chữ số và có độ dài từ 8 đến 20 ký tự.');
  }

  // Ràng buộc logic: chỉ xem là trùng khi đồng thời trùng số tài khoản và tên ngân hàng.
  // Chỉ kiểm tra các bản ghi APPROVED hoặc PENDING_REVIEW — bản ghi REJECTED thì cho phép tái sử dụng.
  const existingBankAccountOwner = await findExistingBankAccountOwner(
    normalizedBankAccountNumber,
    normalizedBankName,
    organizationUser.id
  );
  if (existingBankAccountOwner) {
    const existingStatusLabel = existingBankAccountOwner.status === 'APPROVED'
      ? 'đã được phê duyệt'
      : 'đang chờ phê duyệt';
    throw new Error(`Tài khoản ngân hàng này đã được liên kết với tổ chức khác và ${existingStatusLabel}. Mỗi tài khoản ngân hàng chỉ được liên kết duy nhất với một tổ chức.`);
  }

  const existingSubmissionList = await findSubmissionsByOrganizationId(organizationUser.id);
  const latestPendingSubmission = existingSubmissionList.find(submissionItem => submissionItem.status === 'PENDING_REVIEW');

  if (latestPendingSubmission) {
    // Logic idempotent: khi đã có request chờ duyệt thì trả lại bản ghi hiện có, không tạo thêm bản ghi mới.
    return {
      submissionId: latestPendingSubmission.submissionId,
      version: latestPendingSubmission.version,
      status: latestPendingSubmission.status,
      isExistingPendingSubmission: true
    };
  }

  const nextVersion = (await getLatestSubmissionVersion(organizationUser.id)) + 1;
  const now = new Date();
  const submissionId = crypto.randomUUID();

  await createOrganizationKycSubmission({
    submissionId,
    organizationId: organizationUser.id,
    organizationName: organizationUser.organizationName || organizationUser.fullName,
    legalRegistrationNumber: organizationUser.legalRegistrationNumber || '',
    officialWebsite: null,
    organizationDescription: 'Beneficiary bank account submission',
    version: nextVersion,
    status: 'PENDING_REVIEW',
    submittedBy: organizationUser.id,
    submittedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    beneficiaryBankAccount: {
      bankName: normalizedBankName,
      bankAccountNumber: normalizedBankAccountNumber,
      accountHolderName: normalizedAccountHolderName,
      branchName: normalizedBranchName || null
    },
    files: []
  });

  return { submissionId, version: nextVersion, status: 'PENDING_REVIEW', isExistingPendingSubmission: false };
}


/**
 * Hàm xử lý phê duyệt hoặc từ chối hồ sơ KYC.
 * Mục đích: cập nhật đồng bộ trạng thái hồ sơ và trạng thái tài khoản theo kết quả review.
 */
export async function reviewOrganizationKycSubmission(
  reviewerUserId: string,
  payload: { submissionId: string; reviewPayload: OrganizationKycReviewPayload }
): Promise<OrganizationKycReviewResult> {
  const existingSubmission = await findSubmissionBySubmissionId(payload.submissionId);
  if (!existingSubmission) {
    throw new Error('Không tìm thấy hồ sơ KYC cần xử lý.');
  }

  if (existingSubmission.status !== 'PENDING_REVIEW') {
    throw new Error('Hồ sơ này không còn ở trạng thái chờ duyệt.');
  }

  if (existingSubmission.organizationCategory === 'FOUNDATION') {
    return reviewFoundationKycSubmission(reviewerUserId, existingSubmission, payload.reviewPayload);
  }

  const organizationUser = await findUserById(existingSubmission.organizationId);
  if (!organizationUser) {
    throw new Error('Không tìm thấy tài khoản tổ chức tương ứng hồ sơ KYC.');
  }

  const normalizedAction = payload.reviewPayload.action;
  const normalizedRejectionReason = payload.reviewPayload.rejectionReason?.trim() || '';

  if (normalizedAction === 'reject' && normalizedRejectionReason.length === 0) {
    throw new Error('Vui lòng nhập lý do từ chối hồ sơ KYC.');
  }

  const reviewStatus: OrganizationKycFile['reviewStatus'] = normalizedAction === 'approve' ? 'APPROVED' : 'REJECTED';
  const reviewDateTime = new Date();
  const nextRole = normalizedAction === 'approve' ? 'organizations' : organizationUser.role;
  const nextAccountStatus = normalizedAction === 'approve' ? 'ACTIVE' : 'INACTIVE_PENDING_KYC';

  const reviewedFiles: OrganizationKycFile[] = existingSubmission.files.map((fileItem) => ({
    ...fileItem,
    reviewStatus,
    reviewedBy: reviewerUserId,
    reviewedAt: reviewDateTime,
    rejectionReason: normalizedAction === 'reject' ? normalizedRejectionReason : null
  }));

  const updatedSubmission = await updateOrganizationKycSubmissionReview(existingSubmission.submissionId, {
    status: reviewStatus,
    reviewedBy: reviewerUserId,
    reviewedAt: reviewDateTime,
    rejectionReason: normalizedAction === 'reject' ? normalizedRejectionReason : null,
    files: reviewedFiles
  });

  if (!updatedSubmission) {
    throw new Error('Cập nhật trạng thái hồ sơ KYC thất bại.');
  }

  try {
    let updatedOrganizationUser: AuthUser;
    if (nextRole !== organizationUser.role) {
      await changeUserRole(organizationUser.id, nextRole, reviewerUserId);
      const roleUpdatedUser = await findUserById(organizationUser.id);
      if (!roleUpdatedUser) {
        throw new Error('Không tìm thấy tài khoản sau khi cập nhật role.');
      }
      updatedOrganizationUser = await updateUser({
        ...roleUpdatedUser,
        accountStatus: nextAccountStatus
      });
    } else {
      updatedOrganizationUser = await updateUser({
        ...organizationUser,
        accountStatus: nextAccountStatus
      });
      if (organizationUser.accountStatus !== nextAccountStatus) {
        await revokeUserAccess(
          organizationUser.id,
          `Organization KYC ${normalizedAction}`,
          reviewerUserId
        );
        const accessUpdatedUser = await findUserById(organizationUser.id);
        if (!accessUpdatedUser) {
          throw new Error('Không tìm thấy tài khoản sau khi thu hồi phiên.');
        }
        updatedOrganizationUser = accessUpdatedUser;
      }
    }

    if (normalizedAction === 'approve' && updatedOrganizationUser.role !== 'organizations') {
      throw new Error('Đã phê duyệt hồ sơ nhưng không thể cập nhật role tài khoản thành organizations.');
    }

    if (normalizedAction === 'approve') {
      try {
        const grantRoleResult = await ensureOrganizationWalletProjectManagerRole(updatedOrganizationUser.walletAddress);

        // Cấp ORG_SIGNER_ROLE trên MultisigDisbursement để organization có quyền tạo yêu cầu giải ngân on-chain.
        const grantOrgSignerResult = await ensureOrganizationWalletOrgSignerRole(updatedOrganizationUser.walletAddress);

        const projectManagerMessage = grantRoleResult.wasAlreadyGranted
          ? 'PROJECT_MANAGER_ROLE đã có từ trước.'
          : 'PROJECT_MANAGER_ROLE đã cấp thành công.';
        const orgSignerMessage = grantOrgSignerResult.wasAlreadyGranted
          ? 'ORG_SIGNER_ROLE đã có từ trước.'
          : 'ORG_SIGNER_ROLE đã cấp thành công.';
        const detailMessage = `KYC approve thành công. ${projectManagerMessage} ${orgSignerMessage}`;

        logger.info('KYC approve + grant role success.', {
          performedBy: reviewerUserId,
          userId: updatedOrganizationUser.id,
          walletAddress: updatedOrganizationUser.walletAddress,
          transactionHash: grantRoleResult.transactionHash || 'N/A',
          orgSignerTransactionHash: grantOrgSignerResult.transactionHash || 'N/A'
        });

        await addOrganizationKycAuditLog({
          reviewerUserId,
          organizationUserId: updatedOrganizationUser.id,
          organizationEmail: updatedOrganizationUser.email,
          action: normalizedAction,
          walletAddress: updatedOrganizationUser.walletAddress,
          status: 'SUCCESS',
          transactionHash: grantRoleResult.transactionHash,
          detailMessage
        });
      } catch (error) {
        // Ghi chú logic phức tạp: rollback role/accountStatus nếu cấp quyền on-chain thất bại để tránh "đã duyệt KYC nhưng chưa có quyền tạo project".
        await updateUser({
          ...updatedOrganizationUser,
          role: organizationUser.role,
          accountStatus: organizationUser.accountStatus
        });

        logger.error('KYC approve + grant role failed.', {
          performedBy: reviewerUserId,
          userId: updatedOrganizationUser.id,
          walletAddress: updatedOrganizationUser.walletAddress,
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });

        await addOrganizationKycAuditLog({
          reviewerUserId,
          organizationUserId: updatedOrganizationUser.id,
          organizationEmail: updatedOrganizationUser.email,
          action: normalizedAction,
          walletAddress: updatedOrganizationUser.walletAddress,
          status: 'FAILED',
          transactionHash: null,
          detailMessage: error instanceof Error ? error.message : 'Cấp PROJECT_MANAGER_ROLE thất bại.'
        });

        throw error;
      }
    }

    if (normalizedAction === 'reject') {
      logger.info('KYC reject success.', {
        performedBy: reviewerUserId,
        userId: updatedOrganizationUser.id,
        walletAddress: updatedOrganizationUser.walletAddress
      });

      await addOrganizationKycAuditLog({
        reviewerUserId,
        organizationUserId: updatedOrganizationUser.id,
        organizationEmail: updatedOrganizationUser.email,
        action: normalizedAction,
        walletAddress: updatedOrganizationUser.walletAddress,
        status: 'SUCCESS',
        transactionHash: null,
        detailMessage: 'KYC bị từ chối bởi reviewer.'
      });
    }

    return {
      submission: updatedSubmission,
      accountUpdate: {
        userId: organizationUser.id,
        previousRole: organizationUser.role,
        updatedRole: updatedOrganizationUser.role,
        previousAccountStatus: organizationUser.accountStatus,
        updatedAccountStatus: updatedOrganizationUser.accountStatus,
        roleUpdated: organizationUser.role !== updatedOrganizationUser.role
      }
    };
  } catch (error) {
    // Ghi chú logic phức tạp: rollback trạng thái submission về PENDING_REVIEW khi cập nhật account thất bại,
    // nhằm tránh sai lệch dữ liệu kiểu "hồ sơ đã approve nhưng role chưa đổi".
    await updateOrganizationKycSubmissionReview(existingSubmission.submissionId, {
      status: existingSubmission.status,
      reviewedBy: existingSubmission.reviewedBy,
      reviewedAt: existingSubmission.reviewedAt,
      rejectionReason: existingSubmission.rejectionReason,
      files: existingSubmission.files
    });

    throw new Error(error instanceof Error ? error.message : 'Phê duyệt hồ sơ thất bại do lỗi cập nhật role tài khoản.');
  }
}
