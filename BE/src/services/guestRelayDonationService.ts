/**
 * Service xử lý relay donation cho guest wallet — backend tự build và gửi transaction.
 * Thay thế luồng EIP-4337 (FE sign → ZeroDev Paymaster → Bundler) cho guest/anonymous users.
 *
 * Nguyên tắc Web3 được giữ nguyên:
 * - User tạo key ở browser
 * - 2 lớp mã hóa owner key (FE PBKDF2 → BE AES-256-GCM)
 * - localStorage vẫn giữ bản backup — user có thể khôi phục bất cứ lúc nào
 *
 * Lưu ý: Không ảnh hưởng đến luồng registered user (đã đăng nhập).
 * Hàm executeOneClickDonation() trong donationService.ts giữ nguyên tuyệt đối.
 */
import { ethers } from 'ethers';
import {
  findGuestWalletSessionById,
  reserveDonationSlot,
  incrementSessionDonationCounters
} from '../repositories/guestWalletSessionRepository';
import { findProjectByProjectId } from '../models/projectModel';
import {
  createKernelClientFromEncryptedOwnerKey
} from './zeroDevService';
import { createAuditRecord } from '../repositories/anonymousDonationAuditRepository';
import { getZeroDevConfig } from '../config/zeroDev';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { MAX_DONATIONS_PER_SESSION, MAX_AMOUNT_PER_DONATION, MAX_TOTAL_AMOUNT_PER_SESSION } from '../constants/guestDonation';
import { v4 as uuidv4 } from 'uuid';

const logger = getLogger();

/** ABI cho ERC20 Token (approve + balanceOf + allowance) */
const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

/** ABI cho Donation Contract (charityToken + donate) */
const donationContractAbi = [
  {
    type: 'function',
    name: 'charityToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'donate',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'projectId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'isAnonymous', type: 'bool' }
    ],
    outputs: []
  }
] as const;

/** Kết quả relay donation thành công */
export type RelayDonationResult = {
  transactionHash: string;
  projectId: string;
  amount: number;
  sessionId: string;
};

/** Request type cho relay donation */
export type RelayDonationRequest = {
  sessionId: string;
  projectId: string;
  amount: number;
  walletAddress: string;
  ipAddress: string;
  userAgent: string;
};

/**
 * Chuẩn hóa projectId thành BigInt.
 * Chấp nhận cả numeric string ("123") và mixed string ("project-123").
 */
function normalizeProjectIdToBigInt(projectId: string): bigint {
  const normalizedProjectId = projectId.trim();
  if (/^[0-9]+$/.test(normalizedProjectId)) {
    return BigInt(normalizedProjectId);
  }

  const numericPartMatch = normalizedProjectId.match(/([0-9]+)/);
  if (!numericPartMatch?.[1]) {
    throw new ApplicationError('projectId không hợp lệ để gửi giao dịch.', 400, 'VALIDATION_ERROR');
  }

  return BigInt(numericPartMatch[1]);
}

/**
 * Hàm thực hiện relay donation cho guest wallet.
 *
 * Quy trình:
 * 1. Validate session — đọc từ DB, kiểm tra ACTIVE, expiry, có encryptedOwnerKey
 * 2. Validate project — findProjectById(), check ACTIVE
 * 3. Validate amount
 * 4. Reserve donation slot — atomic check trong MongoDB transaction
 * 5. Decrypt owner key — decryptOwnerPrivateKey(session.smartAccountOwnerEncryptedPrivateKey)
 * 6. Create kernel client không paymaster
 * 7. Check token balance
 * 8. Build approve + donate batch call
 * 9. Send transaction
 * 10. Create audit record + increment counters
 * 11. Return transactionHash
 *
 * @throws ApplicationError nếu validation thất bại
 */
export async function executeGuestRelayedDonation(
  request: RelayDonationRequest
): Promise<RelayDonationResult> {
  const { sessionId, projectId, amount, walletAddress, ipAddress, userAgent } = request;

  // === Bước 1: Validate session ===
  const session = await findGuestWalletSessionById(sessionId);

  if (!session) {
    throw new ApplicationError('Guest session không tồn tại.', 404, 'GUEST_SESSION_NOT_FOUND');
  }

  if (session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new ApplicationError('Wallet address không khớp với session.', 403, 'GUEST_WALLET_MISMATCH');
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError(
      `Session đang ở trạng thái "${session.status}", không thể thực hiện donation.`,
      403,
      'GUEST_SESSION_NOT_ACTIVE'
    );
  }

  if (session.expiresAt < new Date()) {
    throw new ApplicationError('Guest session đã hết hạn. Vui lòng tạo phiên mới.', 401, 'GUEST_SESSION_EXPIRED');
  }

  if (!session.smartAccountOwnerEncryptedPrivateKey) {
    throw new ApplicationError(
      'Session này không hỗ trợ relay donation. Encrypted owner key không tìm thấy.',
      400,
      'RELAY_NOT_AVAILABLE'
    );
  }

  // === Bước 2: Validate amount ===
  const normalizedAmount = Math.floor(Number(amount));
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new ApplicationError('Số token quyên góp phải lớn hơn 0.', 400, 'VALIDATION_ERROR');
  }

  if (normalizedAmount > MAX_AMOUNT_PER_DONATION) {
    throw new ApplicationError(
      `Số token mỗi lần quyên góp không được vượt quá ${MAX_AMOUNT_PER_DONATION / 100} Token.`,
      400,
      'AMOUNT_TOO_LARGE'
    );
  }

  // === Bước 3: Validate project ===
  const projectRecord = await findProjectByProjectId(projectId);
  if (!projectRecord) {
    throw new ApplicationError('Dự án không tồn tại.', 404, 'PROJECT_NOT_FOUND');
  }

  if (projectRecord.status !== 'ACTIVE') {
    throw new ApplicationError('Dự án không còn nhận quyên góp.', 400, 'PROJECT_NOT_ACTIVE');
  }

  const donationContractAddress = String(process.env.DONATION_RANKING_CONTRACT_ADDRESS || '').trim() as `0x${string}`;
  if (!donationContractAddress) {
    throw new ApplicationError('Thiếu cấu hình DONATION_RANKING_CONTRACT_ADDRESS.', 500, 'INTERNAL_ERROR');
  }

  const zeroDevConfig = getZeroDevConfig();

  // === Bước 4: Reserve donation slot (atomic findOneAndUpdate — không cần MongoDB transaction) ===
  const reservedSession = await reserveDonationSlot(
    sessionId,
    walletAddress,
    MAX_TOTAL_AMOUNT_PER_SESSION
  );

  if (!reservedSession) {
    if (session.donationCount >= MAX_DONATIONS_PER_SESSION) {
      throw new ApplicationError(
        `Đã đạt giới hạn ${MAX_DONATIONS_PER_SESSION} lần quyên góp mỗi phiên. Vui lòng tạo phiên mới.`,
        429,
        'DONATION_QUOTA_EXCEEDED'
      );
    }

    if (session.totalDonatedAmount >= MAX_TOTAL_AMOUNT_PER_SESSION) {
      throw new ApplicationError(
        'Đã đạt giới hạn tổng số token có thể quyên góp trong phiên này.',
        429,
        'TOTAL_AMOUNT_EXCEEDED'
      );
    }

    throw new ApplicationError(
      'Đang có donation đang xử lý. Vui lòng đợi và thử lại.',
      429,
      'PENDING_DONATION_EXISTS'
    );
  }

  // === Bước 5 & 6: Decrypt owner key + Create kernel client không paymaster ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kernelClient: Awaited<ReturnType<typeof createKernelClientFromEncryptedOwnerKey>>;
  try {
    kernelClient = await createKernelClientFromEncryptedOwnerKey(
      session.smartAccountOwnerEncryptedPrivateKey
    );
  } catch (keyError) {
    // Reset pending flag khi decrypt key that bai.
    await incrementSessionDonationCounters(sessionId, 0);
    logger.error('Failed to decrypt owner key for relay donation.', {
      sessionId,
      errorMessage: keyError instanceof Error ? keyError.message : String(keyError)
    });
    throw new ApplicationError('Không thể giải mã owner key. Vui lòng liên hệ hỗ trợ.', 500, 'DECRYPTION_ERROR');
  }

  const kernelAccountAddress = (kernelClient as { account?: { address?: `0x${string}` } }).account?.address;
  if (!kernelAccountAddress) {
    await incrementSessionDonationCounters(sessionId, 0);
    throw new ApplicationError('Không thể lấy smart account address.', 500, 'INTERNAL_ERROR');
  }

  const projectIdAsBigInt = normalizeProjectIdToBigInt(projectId);
  const donationAmountAsBigInt = BigInt(normalizedAmount);
  const maxApprovalAmount = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

  // === Bước 7: Check token balance ===
  const readOnlyProvider = new ethers.JsonRpcProvider(zeroDevConfig.rpcUrl);
  const donationContract = new ethers.Contract(donationContractAddress, donationContractAbi, readOnlyProvider);
  const charityTokenAddress = (await donationContract.charityToken()) as `0x${string}`;
  const charityTokenContract = new ethers.Contract(charityTokenAddress, erc20Abi, readOnlyProvider);

  const currentTokenBalance = (await charityTokenContract.balanceOf(kernelAccountAddress)) as bigint;

  if (currentTokenBalance < donationAmountAsBigInt) {
    await incrementSessionDonationCounters(sessionId, 0);
    throw new ApplicationError(
      `Số dư token trong smart account không đủ để quyên góp. Số dư hiện tại: ${currentTokenBalance.toString()} Token.`,
      400,
      'INSUFFICIENT_TOKEN_BALANCE'
    );
  }

  // === Bước 8: Build approve + donate batch call ===
  const currentAllowance = (await charityTokenContract.allowance(kernelAccountAddress, donationContractAddress)) as bigint;

  const callList: Array<{ to: `0x${string}`; data: `0x${string}`; value: bigint }> = [];

  if (currentAllowance < donationAmountAsBigInt) {
    callList.push({
      to: charityTokenAddress,
      data: charityTokenContract.interface.encodeFunctionData('approve', [donationContractAddress, maxApprovalAmount]) as `0x${string}`,
      value: 0n
    });
  }

  callList.push({
    to: donationContractAddress,
    data: donationContract.interface.encodeFunctionData('donate', [projectIdAsBigInt, donationAmountAsBigInt, true]) as `0x${string}`,
    value: 0n
  });

  // === Bước 9: Send transaction ===
  let transactionHash: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionHash = await (kernelClient as any).sendTransaction({
      calls: callList,
      entryPointAddress: zeroDevConfig.entryPointAddress
    });
  } catch (txError) {
    // Reset pending flag khi blockchain tx that bai.
    await incrementSessionDonationCounters(sessionId, 0);
    logger.error('Relay donation transaction failed.', {
      sessionId,
      projectId,
      errorMessage: txError instanceof Error ? txError.message : String(txError)
    });
    throw new ApplicationError('Giao dịch quyên góp thất bại. Vui lòng thử lại.', 500, 'TRANSACTION_FAILED');
  }

  // === Bước 10: Create audit record + increment counters (sau khi tx gửi thành công) ===
  await createAuditRecord({
    auditId: uuidv4(),
    sessionId,
    walletAddress: kernelAccountAddress.toLowerCase(),
    projectId: projectIdAsBigInt.toString(),
    amount: normalizedAmount,
    trustMultiplier: 1.0,
    riskScore: 0,
    userOpHash: transactionHash,
    onChainTxHash: transactionHash,
    onChainBlockNumber: null,
    paymasterSponsoredGas: false,
    claimedByUserId: null,
    isAnonymous: true,
    ipAddress,
    userAgent,
    createdAt: new Date(),
    indexedAt: null,
  });

  await incrementSessionDonationCounters(sessionId, normalizedAmount);

  logger.info('Guest relayed donation completed.', {
    transactionHash,
    sessionId,
    projectId: projectIdAsBigInt.toString(),
    amount: normalizedAmount
  });

  return {
    transactionHash,
    projectId: projectIdAsBigInt.toString(),
    amount: normalizedAmount,
    sessionId
  };
}
