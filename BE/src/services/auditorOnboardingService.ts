import crypto from 'node:crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { ethers } from 'ethers';
import {
  getReadOnlyAuditorStakingContract,
  getReadOnlyAuditorStakingProvider
} from '../config/auditorStakingContract';
import {
  createAuditorPayoutAccount,
  deleteAuditorPayoutAccountById,
  findAuditorPayoutAccountByBankIdentity,
  findAuditorPayoutAccountByUserId,
  updateAuditorPayoutAccount,
  type AuditorPayoutAccount
} from '../models/auditorPayoutAccountModel';
import {
  createAuditorStakeIntent,
  findAuditorStakeIntentById,
  findLatestAuditorStakeIntentByUserId,
  updateAuditorStakeIntent,
  type AuditorStakeIntent
} from '../models/auditorStakeIntentModel';
import { createUser, deleteUserById, findUserByEmail, findUserById, updateUser, type AuthUser } from '../models/authModel';
import { resolveAuditorPayoutBankCode, type AuditorPayoutAccountInput } from '../validators/auditorPayoutAccountValidator';
import { ApplicationError } from '../utils/applicationError';
import { createZeroDevSmartAccount } from './zeroDevService';
import { createKernelClientFromEncryptedOwnerKey } from './zeroDevService';
import { getZeroDevConfig } from '../config/zeroDev';
import { reconcileAuditorStakeForWallet, suspendAuditorRole } from './auditorRoleActivationService';
import { AUDITOR_STAKE_CONFIRMATION_BLOCKS, AUDITOR_STAKE_FAST_PATH_TIMEOUT_MS } from '../constants/auditorStaking';
import { cancelAuditorPayout } from '../models/auditorPayoutModel';
import {
  acquireAuditorUnstakeLock,
  acquireAuditorPartialUnstakeLock,
  acquireAuditorPartialWithdrawalLock,
  acquireAuditorPayoutAccountUpdateLock,
  acquireAuditorWithdrawalLock,
  hasAuditorWalletLock,
  initializeAuditorStakeGuard,
  releaseAuditorUnstakeLock,
  releaseAuditorWalletLock
} from '../models/auditorStakeGuardModel';
import { confirmStakeWithdrawalPayout, createStakeWithdrawalPayout } from './auditorPayoutCreationService';
import { evaluateAuditorFullExitEligibility, type AuditorExitEligibilityResult } from './auditorStakeEligibility.service';
import { getLogger } from '../config/logger';

let googleOAuthClient: OAuth2Client | null = null;
const erc20BalanceAbi = ['function balanceOf(address account) view returns (uint256)'] as const;
const erc20ApprovalAbi = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
] as const;
const logger = getLogger();

interface KernelTransactionCall {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

interface KernelTransactionClient {
  account?: { address?: `0x${string}` };
  sendTransaction(payload: {
    calls: KernelTransactionCall[];
    entryPointAddress: `0x${string}`;
  }): Promise<string>;
}

export interface RegisterAuditorIntentInput {
  identityToken: string;
  fullName?: string;
  payoutAccount: AuditorPayoutAccountInput;
  ipAddress: string;
  userAgent: string;
}

export interface ResumeAuditorIntentInput {
  identityToken: string;
  ipAddress: string;
  userAgent: string;
}

export interface RegisterAuditorIntentResult {
  intentId: string;
  minimumStakeThreshold: string;
  currentTokenBalance: string;
  walletAddress: string;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  refreshSessionId: string;
  expiresAt: Date;
  correlationId: string;
}

export interface ExecuteAuditorStakeResult {
  status: 'VERIFYING';
  txHash: string;
}

export interface WithdrawAuditorStakeResult {
  txHash: string;
  payoutId: string;
}

export interface RequestAuditorUnstakeResult {
  txHash: string;
  releaseAt: Date;
  previousReleaseAt: Date | null;
}

/** Thay tài khoản ngân hàng khi ví không có thao tác tài sản để mọi payout mới chụp đúng một phiên bản dữ liệu. */
export async function updateAuditorPayoutAccountForUser(
  userId: string,
  input: AuditorPayoutAccountInput
): Promise<AuditorPayoutAccount> {
  const user = await findUserById(userId);
  if (!user || user.role !== 'auditor') {
    throw new ApplicationError('Chỉ tài khoản Kiểm toán viên mới có thể cập nhật tài khoản ngân hàng.', 403, 'FORBIDDEN');
  }

  const lockRefId = crypto.randomUUID();
  await initializeAuditorStakeGuard(user.id);
  if (!await acquireAuditorPayoutAccountUpdateLock(user.id, lockRefId)) {
    throw new ApplicationError('Ví đang có giao dịch cọc hoặc chi trả; chưa thể đổi tài khoản ngân hàng.', 409, 'CONFLICT');
  }

  try {
    const bankName = input.bankName.trim();
    const bankAccountNumber = input.bankAccountNumber.trim();
    const conflictingAccount = await findAuditorPayoutAccountByBankIdentity(bankName, bankAccountNumber);
    if (conflictingAccount && conflictingAccount.auditorUserId !== user.id) {
      throw new ApplicationError('Tài khoản ngân hàng này đã được liên kết với một Kiểm toán viên khác.', 409, 'CONFLICT');
    }
    const updated = await updateAuditorPayoutAccount(user.id, {
      bankName,
      bankCode: resolveAuditorPayoutBankCode(bankName),
      bankAccountNumber,
      accountHolderName: input.accountHolderName.trim(),
      branchName: input.branchName?.trim() || null
    });
    if (!updated) {
      throw new ApplicationError('Không tìm thấy tài khoản ngân hàng để cập nhật.', 404, 'NOT_FOUND');
    }
    return updated;
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      throw new ApplicationError('Tài khoản ngân hàng này đã được liên kết với một Kiểm toán viên khác.', 409, 'CONFLICT');
    }
    throw error;
  } finally {
    await releaseAuditorWalletLock(user.id, lockRefId, 'ACCOUNT_UPDATING');
  }
}

/** Khởi tạo OAuth client muộn để fail-fast config của app luôn chạy trước dependency đăng ký Auditor. */
async function getOAuthClient(): Promise<{ client: OAuth2Client; clientId: string; tokenIssuers: string[] }> {
  // Dynamic import giữ module googleAuth ngoài dependency graph bootstrap cho đến khi endpoint thật sự được gọi.
  const { getGoogleAuthConfig } = await import('../config/googleAuth');
  const googleAuthConfig = getGoogleAuthConfig();
  if (!googleOAuthClient) {
    googleOAuthClient = new OAuth2Client(googleAuthConfig.clientId);
  }
  return {
    client: googleOAuthClient,
    clientId: googleAuthConfig.clientId,
    tokenIssuers: googleAuthConfig.tokenIssuers
  };
}

/** Nạp authService đúng lúc cần phát token để bootstrap không bị Google OAuth config chặn trước fail-fast của app. */
async function loginRegisteredAuditor(identityToken: string, ipAddress: string, userAgent: string): Promise<Awaited<ReturnType<typeof import('./authService').loginWithGoogle>>> {
  const { loginWithGoogle } = await import('./authService');
  return loginWithGoogle(identityToken, 'donor', ipAddress, userAgent);
}

/** Kiểm tra lỗi duplicate-key Mongo để đổi thành lỗi nghiệp vụ không lộ dữ liệu người dùng khác. */
function isMongoDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11_000;
}

/** Xác thực Google identity token cho entry point Auditor độc lập mà không mở rộng loginWithGoogle. */
async function verifyAuditorGoogleIdentity(identityToken: string): Promise<TokenPayload> {
  const oauthClient = await getOAuthClient();
  const ticket = await oauthClient.client.verifyIdToken({
    idToken: identityToken,
    audience: oauthClient.clientId
  });
  const payload = ticket.getPayload();
  if (!payload || !oauthClient.tokenIssuers.includes(payload.iss ?? '')) {
    throw new ApplicationError('Google identity token không hợp lệ.', 401, 'UNAUTHENTICATED');
  }
  if (!payload.email) {
    throw new ApplicationError('Tài khoản Google không cung cấp email.', 400, 'VALIDATION_ERROR');
  }
  return payload;
}

/** Tạo Smart Account phục vụ luồng one-click; production không được fallback ví giả. */
async function createAuditorSmartAccount(): Promise<{
  walletAddress: string;
  ownerAddress: string;
  encryptedOwnerPrivateKey: string;
}> {
  const smartAccount = await createZeroDevSmartAccount();
  return {
    walletAddress: smartAccount.smartAccountAddress.toLowerCase(),
    ownerAddress: smartAccount.ownerAddress.toLowerCase(),
    encryptedOwnerPrivateKey: smartAccount.encryptedOwnerPrivateKey
  };
}

/** Đọc ngưỡng cọc và số dư DCT từ chain trước khi tạo dữ liệu onboarding không thể đảo ngược. */
async function readInitialStakeSnapshot(walletAddress: string): Promise<{
  minimumStakeThreshold: bigint;
  currentTokenBalance: bigint;
}> {
  const tokenAddress = process.env.CHARITY_TOKEN_CONTRACT_ADDRESS?.trim() ?? '';
  if (!ethers.isAddress(tokenAddress)) {
    throw new ApplicationError('Cấu hình token cọc chưa sẵn sàng.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  const provider = getReadOnlyAuditorStakingProvider();
  const token = new ethers.Contract(tokenAddress, erc20BalanceAbi, provider);
  const [minimumStakeThreshold, currentTokenBalance] = await Promise.all([
    getReadOnlyAuditorStakingContract().minimumStakeThreshold() as Promise<bigint>,
    token.balanceOf(walletAddress) as Promise<bigint>
  ]);
  return { minimumStakeThreshold, currentTokenBalance };
}

/** Tạo AuthUser ở trạng thái chờ cọc, tuyệt đối không lấy role hoặc walletAddress từ HTTP body. */
function buildPendingAuditorUser(
  googlePayload: TokenPayload,
  smartAccount: Awaited<ReturnType<typeof createAuditorSmartAccount>>,
  ipAddress: string,
  userAgent: string
): AuthUser {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    email: String(googlePayload.email).toLowerCase(),
    fullName: googlePayload.name || 'Google User',
    role: 'donor',
    walletAddress: smartAccount.walletAddress,
    smartAccountOwnerAddress: smartAccount.ownerAddress,
    smartAccountOwnerEncryptedPrivateKey: smartAccount.encryptedOwnerPrivateKey,
    socialProvider: 'google',
    socialAccountId: googlePayload.sub || '',
    isEmailVerified: Boolean(googlePayload.email_verified),
    accountStatus: 'PENDING_STAKE_VERIFICATION',
    suspendedReasonCode: null,
    organizationName: null,
    legalRegistrationNumber: null,
    isSybil: false,
    lastLoginAt: now,
    lastLoginIp: ipAddress,
    lastLoginUserAgent: userAgent,
    correlationId: crypto.randomUUID(),
    fcmDeviceToken: null,
    phoneNumber: null,
    authVersion: 1
  };
}

/** Tạo account payout trước user và bù trừ khi lỗi để không giữ số tài khoản ngân hàng mồ côi. */
async function createPayoutAccountForAuditor(
  auditorUserId: string,
  input: AuditorPayoutAccountInput
): Promise<AuditorPayoutAccount> {
  const normalizedBankName = input.bankName.trim();
  const normalizedAccountNumber = input.bankAccountNumber.trim();
  const existingAccount = await findAuditorPayoutAccountByBankIdentity(normalizedBankName, normalizedAccountNumber);
  if (existingAccount) {
    throw new ApplicationError('Tài khoản ngân hàng này đã được liên kết với một Kiểm toán viên khác.', 409, 'CONFLICT');
  }

  try {
    return await createAuditorPayoutAccount({
      payoutAccountId: crypto.randomUUID(),
      auditorUserId,
      bankName: normalizedBankName,
      bankCode: resolveAuditorPayoutBankCode(normalizedBankName),
      bankAccountNumber: normalizedAccountNumber,
      accountHolderName: input.accountHolderName.trim(),
      branchName: input.branchName?.trim() || null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      throw new ApplicationError('Tài khoản ngân hàng này đã được liên kết với một Kiểm toán viên khác.', 409, 'CONFLICT');
    }
    throw error;
  }
}

/** Đăng ký Auditor kèm tài khoản nhận tiền, snapshot ngưỡng cọc và token pair nhưng chưa cấp role auditor. */
export async function registerAuditorIntent(input: RegisterAuditorIntentInput): Promise<RegisterAuditorIntentResult> {
  const googlePayload = await verifyAuditorGoogleIdentity(input.identityToken);
  const email = String(googlePayload.email).toLowerCase();
  if (await findUserByEmail(email)) {
    throw new ApplicationError('Email này đã tồn tại. Vui lòng đăng nhập bằng tài khoản hiện có.', 409, 'EMAIL_EXISTS');
  }

  const smartAccount = await createAuditorSmartAccount();
  const stakeSnapshot = await readInitialStakeSnapshot(smartAccount.walletAddress);
  const pendingUser = buildPendingAuditorUser(googlePayload, smartAccount, input.ipAddress, input.userAgent);
  const payoutAccount = await createPayoutAccountForAuditor(pendingUser.id, input.payoutAccount);

  try {
    await createUser(pendingUser);
  } catch (error) {
    await deleteAuditorPayoutAccountById(payoutAccount.payoutAccountId);
    if (isMongoDuplicateKeyError(error)) {
      throw new ApplicationError('Email này đã tồn tại. Vui lòng đăng nhập bằng tài khoản hiện có.', 409, 'EMAIL_EXISTS');
    }
    throw error;
  }

  try {
    // Tái dùng API public để phát token/session; user đã tồn tại nên authService không thể tự thay đổi role/status.
    const tokenPair = await loginRegisteredAuditor(input.identityToken, input.ipAddress, input.userAgent);
    const now = new Date();
    const intent = await createAuditorStakeIntent({
      id: crypto.randomUUID(),
      userId: pendingUser.id,
      walletAddress: pendingUser.walletAddress,
      minimumStakeThreshold: stakeSnapshot.minimumStakeThreshold.toString(),
      status: 'PENDING_TX',
      txHash: null,
      failureReason: null,
      correlationId: tokenPair.correlationId,
      createdAt: now,
      updatedAt: now
    });
    return {
      intentId: intent.id,
      minimumStakeThreshold: stakeSnapshot.minimumStakeThreshold.toString(),
      currentTokenBalance: stakeSnapshot.currentTokenBalance.toString(),
      walletAddress: pendingUser.walletAddress,
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      csrfToken: tokenPair.csrfToken,
      refreshSessionId: tokenPair.refreshSessionId,
      expiresAt: tokenPair.expiresAt,
      correlationId: tokenPair.correlationId
    };
  } catch (error) {
    await Promise.all([deleteUserById(pendingUser.id), deleteAuditorPayoutAccountById(payoutAccount.payoutAccountId)]);
    throw error;
  }
}

/**
 * Khôi phục duy nhất hồ sơ Auditor đang chờ nạp/cọc sau khi chủ tài khoản xác thực lại Google.
 * Việc đối chiếu cả email và Google subject ngăn tài khoản khác cùng/đổi email truy cập intent cũ.
 */
export async function resumeAuditorIntent(input: ResumeAuditorIntentInput): Promise<RegisterAuditorIntentResult> {
  const googlePayload = await verifyAuditorGoogleIdentity(input.identityToken);
  const email = String(googlePayload.email).toLowerCase();
  const user = await findUserByEmail(email);
  const googleSubject = googlePayload.sub || '';

  if (!user || user.socialProvider !== 'google' || !googleSubject || user.socialAccountId !== googleSubject) {
    throw new ApplicationError('Không tìm thấy hồ sơ Kiểm toán viên đang chờ kích hoạt cho tài khoản Google này.', 404, 'AUDITOR_ONBOARDING_NOT_FOUND');
  }
  if (user.role === 'auditor') {
    throw new ApplicationError('Tài khoản Google này đã là Kiểm toán viên. Vui lòng đăng nhập để sử dụng quyền hiện có.', 409, 'ALREADY_AUDITOR');
  }
  if (user.accountStatus === 'ACTIVE') {
    throw new ApplicationError('Không tìm thấy hồ sơ Kiểm toán viên đang chờ kích hoạt cho tài khoản Google này.', 404, 'AUDITOR_ONBOARDING_NOT_FOUND');
  }
  if (user.accountStatus !== 'PENDING_STAKE_VERIFICATION') {
    throw new ApplicationError('Hồ sơ Kiểm toán viên hiện không thể tiếp tục kích hoạt.', 409, 'ONBOARDING_RESUME_UNAVAILABLE');
  }

  const intent = await findLatestAuditorStakeIntentByUserId(user.id);
  if (!intent) {
    throw new ApplicationError('Hồ sơ Kiểm toán viên thiếu yêu cầu đặt cọc để tiếp tục kích hoạt.', 409, 'ONBOARDING_RESUME_UNAVAILABLE');
  }
  if (intent.status === 'ACTIVATED') {
    throw new ApplicationError('Hồ sơ Kiểm toán viên đã được kích hoạt. Vui lòng đăng nhập lại.', 409, 'ALREADY_AUDITOR');
  }
  if (intent.status === 'VERIFYING') {
    throw new ApplicationError('Giao dịch đặt cọc đang được xác minh. Vui lòng đăng nhập lại sau ít phút để kiểm tra trạng thái.', 409, 'ALREADY_SUBMITTED');
  }

  const stakeSnapshot = await readInitialStakeSnapshot(user.walletAddress);
  const tokenPair = await loginRegisteredAuditor(input.identityToken, input.ipAddress, input.userAgent);
  return {
    intentId: intent.id,
    minimumStakeThreshold: stakeSnapshot.minimumStakeThreshold.toString(),
    currentTokenBalance: stakeSnapshot.currentTokenBalance.toString(),
    walletAddress: user.walletAddress,
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    csrfToken: tokenPair.csrfToken,
    refreshSessionId: tokenPair.refreshSessionId,
    expiresAt: tokenPair.expiresAt,
    correlationId: tokenPair.correlationId
  };
}

/** Đọc trạng thái intent tối thiểu và kiểm tra ownership để tránh lộ tiến trình onboarding của người khác. */
export async function getAuditorOnboardingStatus(
  intentId: string,
  userId: string
): Promise<Pick<AuditorStakeIntent, 'status' | 'failureReason' | 'createdAt' | 'updatedAt'>> {
  const intent = await findAuditorStakeIntentById(intentId);
  if (!intent) {
    throw new ApplicationError('Không tìm thấy yêu cầu đặt cọc.', 404, 'INTENT_NOT_FOUND');
  }
  if (intent.userId !== userId) {
    throw new ApplicationError('Bạn không có quyền xem yêu cầu đặt cọc này.', 403, 'FORBIDDEN');
  }
  return {
    status: intent.status,
    failureReason: intent.failureReason,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt
  };
}

/** Dựng Kernel client từ owner key đã mã hóa và kiểm tra smart account có địa chỉ hợp lệ. */
async function createAuditorKernelClient(user: AuthUser): Promise<KernelTransactionClient> {
  if (!user.smartAccountOwnerEncryptedPrivateKey) {
    throw new ApplicationError('Tài khoản chưa sẵn sàng để thực hiện giao dịch đặt cọc.', 400, 'VALIDATION_ERROR');
  }
  const kernelClient = await createKernelClientFromEncryptedOwnerKey(user.smartAccountOwnerEncryptedPrivateKey) as unknown as KernelTransactionClient;
  if (!kernelClient.account?.address) {
    throw new ApplicationError('Không thể khởi tạo ví đặt cọc. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  return kernelClient;
}

/** Đồng bộ ví trong DB với Kernel account suy ra từ owner key để không ký giao dịch bằng ví khác. */
async function synchronizeAuditorWalletAddress(user: AuthUser, kernelAddress: string): Promise<AuthUser> {
  if (user.walletAddress.toLowerCase() === kernelAddress.toLowerCase()) return user;
  return updateUser({ ...user, walletAddress: kernelAddress.toLowerCase(), updatedAt: new Date() });
}

/** Thu thập các thông điệp lỗi lồng nhau để nhận diện lỗi RPC mà không đưa nội dung thô ra client. */
function collectErrorMessages(error: unknown, visitedErrors: Set<object> = new Set<object>()): string[] {
  if (typeof error === 'string') return [error];
  if (!error || typeof error !== 'object' || visitedErrors.has(error)) return [];

  visitedErrors.add(error);
  const typedError = error as {
    message?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  const messages = [typedError.message, typedError.shortMessage, typedError.details]
    .filter((message): message is string => typeof message === 'string');

  return [...messages, ...collectErrorMessages(typedError.cause, visitedErrors)];
}

/** Nhận diện lỗi policy Paymaster trong cả lỗi RPC lồng nhau để client chỉ nhận thông điệp nghiệp vụ an toàn. */
function isPaymasterPolicyMismatch(error: unknown): boolean {
  const normalizedMessages = collectErrorMessages(error).join(' ').toLowerCase();
  return normalizedMessages.includes('pm_getpaymasterstubdata')
    || normalizedMessages.includes('did not match any gas sponsoring policies')
    || normalizedMessages.includes('no erc20 gas token data present');
}

/** Gửi UserOperation đặt cọc; nếu không truyền amount thì cọc đúng phần thiếu của luồng onboarding. */
export async function executeAuditorStake(userId: string, requestedAmount?: bigint): Promise<ExecuteAuditorStakeResult> {
  const user = await findUserById(userId);
  if (!user) throw new ApplicationError('Không tìm thấy người dùng đăng nhập.', 404, 'NOT_FOUND');
  if (user.accountStatus !== 'PENDING_STAKE_VERIFICATION' && user.accountStatus !== 'SUSPENDED' && user.accountStatus !== 'ACTIVE') {
    throw new ApplicationError('Tài khoản hiện không ở trạng thái có thể đặt cọc.', 409, 'INVALID_STATUS_TRANSITION');
  }
  if (user.accountStatus === 'ACTIVE' && user.role !== 'auditor') {
    throw new ApplicationError('Chỉ tài khoản Kiểm toán viên đang hoạt động mới có thể đặt cọc thêm.', 403, 'FORBIDDEN');
  }
  if (requestedAmount !== undefined && requestedAmount <= 0n) {
    throw new ApplicationError('Số tiền đặt cọc phải lớn hơn 0.', 400, 'AMOUNT_INVALID');
  }
  const isOnboardingStake = user.accountStatus !== 'ACTIVE';
  const canReactivateByRestaking = user.suspendedReasonCode === 'STAKE_BELOW_THRESHOLD'
    || user.suspendedReasonCode === 'CHALLENGE_REJECTED';
  if (user.accountStatus === 'SUSPENDED' && !canReactivateByRestaking) {
    throw new ApplicationError('Tài khoản đang bị đình chỉ và không thể tự kích hoạt lại bằng cách đặt cọc.', 403, 'FORBIDDEN');
  }

  if (await hasAuditorWalletLock(user.id)) {
    throw new ApplicationError('Ví đang có giao dịch chi trả chờ đốt DCT; bạn chưa thể đặt cọc lúc này.', 409, 'CONFLICT');
  }
  const intent = await findLatestAuditorStakeIntentByUserId(user.id);
  if (isOnboardingStake && !intent) throw new ApplicationError('Không tìm thấy yêu cầu đặt cọc.', 404, 'INTENT_NOT_FOUND');
  if (intent?.status === 'VERIFYING') {
    throw new ApplicationError('Yêu cầu đặt cọc đang được xác minh.', 409, 'ALREADY_SUBMITTED');
  }

  const kernelClient = await createAuditorKernelClient(user);
  const kernelAddress = kernelClient.account?.address;
  if (!kernelAddress) throw new ApplicationError('Không thể lấy địa chỉ ví đặt cọc.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  const synchronizedUser = await synchronizeAuditorWalletAddress(user, kernelAddress);
  const stakingContract = getReadOnlyAuditorStakingContract();
  const tokenAddress = process.env.CHARITY_TOKEN_CONTRACT_ADDRESS?.trim() ?? '';
  if (!ethers.isAddress(tokenAddress)) {
    throw new ApplicationError('Cấu hình token cọc chưa sẵn sàng.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  const provider = getReadOnlyAuditorStakingProvider();
  const tokenContract = new ethers.Contract(tokenAddress, erc20ApprovalAbi, provider);
  const [minimumStakeThreshold, currentStakedBalance, currentTokenBalance] = await Promise.all([
    stakingContract.minimumStakeThreshold() as Promise<bigint>,
    stakingContract.stakedBalance(kernelAddress) as Promise<bigint>,
    tokenContract.balanceOf(kernelAddress) as Promise<bigint>
  ]);
  if (requestedAmount === undefined && currentStakedBalance >= minimumStakeThreshold) {
    await reconcileAuditorStakeForWallet(kernelAddress);
    throw new ApplicationError('Số cọc hiện tại đã đạt ngưỡng xác minh.', 409, 'ALREADY_SUBMITTED');
  }
  const stakeAmount = requestedAmount ?? (minimumStakeThreshold - currentStakedBalance);
  if (stakeAmount <= 0n) {
    throw new ApplicationError('Số tiền đặt cọc phải lớn hơn 0.', 400, 'AMOUNT_INVALID');
  }
  if (currentTokenBalance < stakeAmount) {
    const shortfall = stakeAmount - currentTokenBalance;
    throw new ApplicationError(
      `Số dư DCT không đủ để đặt cọc. Bạn cần nạp thêm ${shortfall.toString()} DCT.`,
      400,
      'INSUFFICIENT_TOKEN_BALANCE'
    );
  }

  const stakingAddress = (await stakingContract.getAddress()) as `0x${string}`;
  const allowance = await tokenContract.allowance(kernelAddress, stakingAddress) as bigint;
  const calls: KernelTransactionCall[] = [];
  if (allowance < stakeAmount) {
    calls.push({
      to: ethers.getAddress(tokenAddress) as `0x${string}`,
      // Chỉ cấp đúng phần cọc còn thiếu để giảm quyền token và đáp ứng policy tài trợ gas giới hạn amount.
      data: tokenContract.interface.encodeFunctionData('approve', [stakingAddress, stakeAmount]) as `0x${string}`,
      value: 0n
    });
  }
  calls.push({
    to: stakingAddress,
    data: stakingContract.interface.encodeFunctionData('stake', [stakeAmount]) as `0x${string}`,
    value: 0n
  });

  let txHash: string;
  try {
    txHash = await kernelClient.sendTransaction({ calls, entryPointAddress: getZeroDevConfig().entryPointAddress });
  } catch (error) {
    if (isPaymasterPolicyMismatch(error)) {
      throw new ApplicationError('Hệ thống chưa thể tài trợ phí gas cho giao dịch. Vui lòng thử lại sau.', 400, 'PAYMASTER_POLICY_MISMATCH');
    }
    throw error;
  }

  if (isOnboardingStake && intent) {
    await updateAuditorStakeIntent({
      ...intent,
      walletAddress: synchronizedUser.walletAddress,
      status: 'VERIFYING',
      txHash,
      failureReason: null,
      updatedAt: new Date()
    });
    // Fast path không được await: endpoint phải trả ngay sau khi bundler chấp nhận UserOperation.
    void runFastPathVerification(intent.id, txHash);
  }
  return { status: 'VERIFYING', txHash };
}

/** Chờ confirmation ngắn cho UX; timeout chỉ log để worker nền vẫn có thể kích hoạt muộn. */
async function runFastPathVerification(intentId: string, txHash: string): Promise<void> {
  try {
    const receipt = await getReadOnlyAuditorStakingProvider().waitForTransaction(
      txHash,
      AUDITOR_STAKE_CONFIRMATION_BLOCKS,
      AUDITOR_STAKE_FAST_PATH_TIMEOUT_MS
    );
    if (!receipt) {
      // Timeout không khẳng định UserOperation revert; worker event projection vẫn có thể xác nhận muộn.
      return;
    }
    if (receipt.status !== 1) {
      const intent = await findAuditorStakeIntentById(intentId);
      if (intent) {
        await updateAuditorStakeIntent({
          ...intent,
          status: 'FAILED',
          failureReason: 'TX_REVERTED_OR_TIMEOUT',
          updatedAt: new Date()
        });
      }
      return;
    }
    const intent = await findAuditorStakeIntentById(intentId);
    if (intent) {
      await reconcileAuditorStakeForWallet(intent.walletAddress);
    }
  } catch (error) {
    logger.warn('Fast path AuditorStaking chưa hoàn tất; worker nền sẽ tiếp tục reconcile.', {
      intentId,
      errorMessage: error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    });
  }
}

/** Dựng lỗi thoát vai trò kèm đủ mọi lý do để người dùng biết hết việc phải làm trong một lần. */
function buildFullExitNotEligibleError(eligibility: AuditorExitEligibilityResult): ApplicationError {
  return new ApplicationError(
    `Chưa đủ điều kiện rút hết toàn bộ cọc: ${eligibility.reasons.map(reason => reason.message).join('; ')}`,
    409,
    'FULL_EXIT_NOT_ELIGIBLE'
  );
}

/**
 * Gửi yêu cầu unbonding. Số cọc còn lại chỉ được phép bằng 0 (thoát hẳn vai trò) hoặc từ ngưỡng tối
 * thiểu trở lên; khoảng lửng lơ ở giữa bị chặn cứng thay vì cho rút rồi âm thầm thu quyền.
 */
export async function requestAuditorUnstake(userId: string, amount: bigint): Promise<RequestAuditorUnstakeResult> {
  const user = await findUserById(userId);
  if (!user || user.role !== 'auditor' || (user.accountStatus !== 'ACTIVE' && user.accountStatus !== 'SUSPENDED')) {
    throw new ApplicationError('Chỉ tài khoản Kiểm toán viên mới có thể yêu cầu rút cọc.', 403, 'FORBIDDEN');
  }
  if (amount <= 0n) throw new ApplicationError('Số tiền rút phải lớn hơn 0.', 400, 'AMOUNT_INVALID');
  if (!await findAuditorPayoutAccountByUserId(user.id)) {
    throw new ApplicationError('Bạn cần đăng ký tài khoản ngân hàng nhận tiền trước khi rút cọc.', 409, 'CONFLICT');
  }

  // Đọc trạng thái on-chain trước khi giành khóa: loại khóa phụ thuộc vào việc đây là rút một phần
  // hay thoát hẳn vai trò, mà điều đó chỉ biết được sau khi có stakedBalance.
  const kernelClient = await createAuditorKernelClient(user);
  const kernelAddress = kernelClient.account?.address;
  if (!kernelAddress) throw new ApplicationError('Không thể lấy địa chỉ ví đặt cọc.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  const synchronizedUser: AuthUser = await synchronizeAuditorWalletAddress(user, kernelAddress);
  const contract = getReadOnlyAuditorStakingContract();
  const [stakedBalance, minimumStakeThreshold, unbondingPeriodSeconds, previousReleaseAt] = await Promise.all([
    contract.stakedBalance(kernelAddress) as Promise<bigint>,
    contract.minimumStakeThreshold() as Promise<bigint>,
    contract.unbondingPeriodSeconds() as Promise<bigint>,
    contract.unbondingReleaseAt(kernelAddress) as Promise<bigint>
  ]);
  if (amount > stakedBalance) {
    throw new ApplicationError('Số tiền yêu cầu rút vượt quá số cọc hiện có.', 400, 'AMOUNT_INVALID');
  }

  const remaining = stakedBalance - amount;
  if (remaining > 0n && remaining < minimumStakeThreshold) {
    throw new ApplicationError(
      `Số cọc còn lại sau khi rút phải đạt tối thiểu ${minimumStakeThreshold.toLocaleString('vi-VN')} VNĐ, hoặc chọn rút toàn bộ để thoát vai trò Kiểm toán viên.`,
      400,
      'AMOUNT_BELOW_MINIMUM_FLOOR'
    );
  }

  const isFullExit = remaining === 0n;
  if (isFullExit) {
    const eligibility = await evaluateAuditorFullExitEligibility(synchronizedUser.id);
    if (!eligibility.eligible) throw buildFullExitNotEligibleError(eligibility);
  }

  const lockRefId = crypto.randomUUID();
  await initializeAuditorStakeGuard(user.id);
  const acquiredLock = isFullExit
    ? await acquireAuditorUnstakeLock(user.id, lockRefId)
    : await acquireAuditorPartialUnstakeLock(user.id, lockRefId);
  if (!acquiredLock) {
    throw new ApplicationError('Ví đang bị khóa do có vụ việc, nợ phạt hoặc giao dịch cọc/chi trả đang xử lý.', 409, 'CONFLICT');
  }

  let txHash = '';
  try {
    txHash = await kernelClient.sendTransaction({
      calls: [{
        to: (await contract.getAddress()) as `0x${string}`,
        data: contract.interface.encodeFunctionData('requestUnstake', [amount]) as `0x${string}`,
        value: 0n
      }],
      entryPointAddress: getZeroDevConfig().entryPointAddress
    });
  } catch (error) {
    await releaseAuditorUnstakeLock(user.id, lockRefId);
    throw error;
  }
  if (isFullExit) {
    try {
      await suspendAuditorRole(synchronizedUser.id, 'STAKE_BELOW_THRESHOLD');
    } catch (error) {
      logger.error('Không thể thu quyền Auditor sau UserOperation unstake đã được chấp nhận.', {
        userId: synchronizedUser.id,
        errorMessage: error instanceof Error ? error.message : 'UNKNOWN_ERROR'
      });
    }
  }
  return {
    txHash,
    releaseAt: new Date(Date.now() + Number(unbondingPeriodSeconds) * 1_000),
    previousReleaseAt: previousReleaseAt > 0n ? new Date(Number(previousReleaseAt) * 1_000) : null
  };
}

/** Rút cọc đã hết unbonding, rồi tạo đúng một payout để đổi DCT về VNĐ qua PayOS. */
export async function withdrawAuditorStake(userId: string): Promise<WithdrawAuditorStakeResult> {
  const user = await findUserById(userId);
  if (!user || user.role !== 'auditor') {
    throw new ApplicationError('Chỉ tài khoản Kiểm toán viên mới có thể rút cọc.', 403, 'FORBIDDEN');
  }
  if (!await findAuditorPayoutAccountByUserId(user.id)) {
    throw new ApplicationError('Bạn cần đăng ký tài khoản ngân hàng nhận tiền trước khi rút cọc.', 409, 'CONFLICT');
  }
  // Đọc on-chain trước khi giành khóa: chỉ khi stakedBalance đã về 0 thì đây mới là bước nhận lại
  // cuối cùng của một lần thoát vai trò, và mới phải xét lại điều kiện thoát.
  const kernelClient = await createAuditorKernelClient(user);
  const walletAddress = kernelClient.account?.address;
  if (!walletAddress) throw new ApplicationError('Không thể khởi tạo ví để rút cọc.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  await synchronizeAuditorWalletAddress(user, walletAddress);
  const contract = getReadOnlyAuditorStakingContract();
  const [pendingAmount, stakedBalance] = await Promise.all([
    contract.pendingWithdrawAmount(walletAddress) as Promise<bigint>,
    contract.stakedBalance(walletAddress) as Promise<bigint>
  ]);
  if (pendingAmount <= 0n) {
    throw new ApplicationError('Hiện không có khoản cọc nào chờ rút.', 409, 'CONFLICT');
  }

  // Vá khe hở của 7 ngày unbonding: một vụ việc mới có thể mở ra sau lúc gửi yêu cầu rút.
  const isFullExitClaim = stakedBalance === 0n;
  if (isFullExitClaim) {
    const eligibility = await evaluateAuditorFullExitEligibility(user.id);
    if (!eligibility.eligible) throw buildFullExitNotEligibleError(eligibility);
  }

  const payoutId = crypto.randomUUID();
  await initializeAuditorStakeGuard(user.id);
  const acquiredLock = isFullExitClaim
    ? await acquireAuditorWithdrawalLock(user.id, payoutId)
    : await acquireAuditorPartialWithdrawalLock(user.id, payoutId);
  if (!acquiredLock) {
    throw new ApplicationError('Ví đang bị khóa do có vụ việc, nợ phạt hoặc giao dịch cọc/chi trả đang xử lý.', 409, 'CONFLICT');
  }

  let txHash: string | null = null;
  let preparedPayout = false;
  try {
    await createStakeWithdrawalPayout({
      auditorUserId: user.id,
      payoutId,
      sourceRefId: payoutId,
      onchainTxHash: null,
      amount: pendingAmount
    });
    preparedPayout = true;
    txHash = await kernelClient.sendTransaction({
      calls: [{
        to: (await contract.getAddress()) as `0x${string}`,
        data: contract.interface.encodeFunctionData('withdraw', []) as `0x${string}`,
        value: 0n
      }],
      entryPointAddress: getZeroDevConfig().entryPointAddress
    });
  } catch (error) {
    if (preparedPayout) {
      await cancelAuditorPayout(payoutId, error instanceof Error ? error.message : 'Không thể gửi giao dịch rút cọc.');
    }
    await releaseAuditorWalletLock(user.id, payoutId, 'WITHDRAWING');
    throw error;
  }

  const withdrawReceipt = await getReadOnlyAuditorStakingProvider().waitForTransaction(txHash, 1, 120_000);
  if (withdrawReceipt?.status === 0) {
    await cancelAuditorPayout(payoutId, 'Giao dịch rút cọc bị revert trên blockchain.');
    await releaseAuditorWalletLock(user.id, payoutId, 'WITHDRAWING');
    throw new ApplicationError('Giao dịch rút cọc bị revert.', 409, 'TRANSACTION_REVERTED');
  }
  if (withdrawReceipt?.status === 1) {
    await confirmStakeWithdrawalPayout(user.id, payoutId, txHash);
  }
  // Khi timeout, lock và payout PENDING được giữ nguyên; projector Withdrawn sẽ gắn txHash rồi enqueue an toàn.
  return { txHash, payoutId };
}
