/**
 * Service chứa business logic cho guest deposit + auto-donate qua ZeroDev Bundler.
 * Luồng: FE build UserOp → sign → send to BE → BE sponsor + submit → EntryPoint executes → msg.sender = guest Smart Wallet.
 *
 * Điểm khác biệt quan trọng so với luồng cũ:
 * - Backend mint token vào guest wallet address (không phải backend signer)
 * - Backend submit signed UserOp lên Bundler/EntryPoint
 * - donate() được gọi từ guest Smart Wallet → msg.sender = guest Smart Wallet ✅
 */
import { ethers } from 'ethers';
import {
  findGuestDepositByOrderCodeRepo,
  updateGuestDepositStatus
} from '../repositories/guestDepositRepository';
import {
  incrementSessionDonationCounters
} from '../repositories/guestWalletSessionRepository';
import { applyDonationToMetrics } from './rankingIncrementalService';
import { getLogger } from '../config/logger';
import { getZeroDevConfig } from '../config/zeroDev';

const logger = getLogger();

/**
 * Gas fee cap mặc định (1.5 Gwei hex) — đủ cho most L2 chains.
 */
const DEFAULT_MAX_FEE_PER_GAS = '0x59682f00';
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = '0x59682f00';

/**
 * Gas limits mặc định khi estimate không khả dụng.
 * Đủ cho donate(uint256,uint256,bool) call + Kernel validation + EntryPoint overhead.
 */
const DEFAULT_CALL_GAS_LIMIT = '0x50000';
const DEFAULT_VERIFICATION_GAS_LIMIT = '0x50000';
const DEFAULT_PRE_VERIFICATION_GAS = '0x50000';

/** ABI interface cho charity token mint function. */
const mintAbi = [
  'function mintFromBackend(address receiver, uint256 amount, string orderCode) external returns (bool)'
];

/**
 * Signed UserOp từ frontend — đã được guest owner key ký.
 * Backend chỉ attach paymasterAndData và submit lên Bundler.
 */
export type SignedUserOp = {
  sender: string;
  nonce: string | number;
  initCode: string;
  callData: string;
  callGasLimit?: string;
  verificationGasLimit?: string;
  preVerificationGas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  paymasterAndData?: string;
  signature: string;
};

/**
 * Request type cho mintAndAutoDonate.
 */
export type MintAndAutoDonateRequest = {
  sessionId: string;
  walletAddress: string;
  amount: number;
  projectId: string;
  orderCode: string;
  signedUserOp: SignedUserOp;
  paymasterAndData: string;
  userOpHash: string;
};

/**
 * Response type cho mintAndAutoDonate.
 */
export type MintAndAutoDonateResult = {
  mintTxHash: string;
  donationTxHash: string;
};

/**
 * Hàm gửi signed UserOp lên ZeroDev Bundler.
 * Backend KHÔNG ký UserOp — chỉ attach paymasterAndData và forward lên Bundler.
 * EntryPoint sẽ verify signature của guest owner key (không phải backend signer).
 *
 * Retry với exponential backoff cho các lỗi tạm thời.
 */
async function submitSignedUserOpToBundler(
  signedUserOp: SignedUserOp,
  paymasterAndData: string
): Promise<string> {
  const config = getZeroDevConfig();
  const bundlerUrl = config.bundlerUrl;
  const entryPointAddress = config.entryPointAddress;

  const normalizedUserOp = {
    sender: String(signedUserOp.sender),
    nonce: String(signedUserOp.nonce),
    initCode: String(signedUserOp.initCode || '0x'),
    callData: String(signedUserOp.callData),
    callGasLimit: String(signedUserOp.callGasLimit || DEFAULT_CALL_GAS_LIMIT),
    verificationGasLimit: String(signedUserOp.verificationGasLimit || DEFAULT_VERIFICATION_GAS_LIMIT),
    preVerificationGas: String(signedUserOp.preVerificationGas || DEFAULT_PRE_VERIFICATION_GAS),
    maxFeePerGas: String(signedUserOp.maxFeePerGas || DEFAULT_MAX_FEE_PER_GAS),
    maxPriorityFeePerGas: String(signedUserOp.maxPriorityFeePerGas || DEFAULT_MAX_PRIORITY_FEE_PER_GAS),
    paymasterAndData: paymasterAndData,
    signature: String(signedUserOp.signature)
  };

  const maxAttempts = 3;
  const baseDelayMs = 1_000;
  const maxDelayMs = 10_000;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${bundlerUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_sendUserOperation',
          params: [normalizedUserOp, entryPointAddress],
          id: 1
        })
      });

      if (!response.ok) {
        const rawBody = await response.text().catch(() => '[unreadable]');
        throw new Error(`Bundler HTTP error: ${response.status} ${rawBody}`);
      }

      const result = (await response.json()) as { result?: string; error?: { message?: string } };
      if (result.error) {
        throw new Error(`Bundler RPC error: ${result.error.message}`);
      }

      if (!result.result || typeof result.result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.result)) {
        throw new Error('Bundler returned invalid transaction hash.');
      }

      return result.result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        logger.warn('Bundler submission failed, retrying.', {
          attempt: attempt + 1,
          maxAttempts,
          delayMs: delay,
          errorMessage: lastError.message
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Bundler submission failed after retries.');
}

/**
 * Hàm mint token và auto-donate cho guest qua ZeroDev Bundler.
 *
 * Luồng:
 * 1. Cập nhật status → MINTING
 * 2. Backend mint token vào guest wallet address (không phải backend signer)
 * 3. Cập nhật status → DONATION_EXECUTING
 * 4. Backend submit signed UserOp lên Bundler/EntryPoint
 * 5. EntryPoint verify signature (của guest owner key) → execute donate() → msg.sender = guest Smart Wallet ✅
 * 6. Cập nhật status → DONATION_COMPLETED
 * 7. Atomic increment session counters
 * 8. Cập nhật project metrics
 *
 * @throws Error nếu validation thất bại hoặc blockchain operations thất bại
 */
export async function mintAndAutoDonate(
  request: MintAndAutoDonateRequest
): Promise<MintAndAutoDonateResult> {
  const {
    sessionId,
    walletAddress,
    amount,
    projectId,
    orderCode,
    signedUserOp,
    paymasterAndData,
    userOpHash
  } = request;

  const blockchainRpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const backendPrivateKey = String(process.env.BACKEND_MINTER_PRIVATE_KEY || '').trim();
  const charityTokenAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();

  if (!blockchainRpcUrl || !backendPrivateKey || !charityTokenAddress) {
    throw new Error(
      'Thiếu cấu hình blockchain để mint. ' +
      'Kiểm tra BLOCKCHAIN_RPC_URL, BACKEND_MINTER_PRIVATE_KEY, CHARITY_TOKEN_CONTRACT_ADDRESS.'
    );
  }

  const normalizedAmount = Math.floor(Number(amount));
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('Số lượng token donation không hợp lệ.');
  }

  // === Idempotency guard: kiểm tra trạng thái trước khi mint ===
  // Nếu đã mint rồi (status != PENDING_PAYMENT), chỉ submit UserOp thôi
  // Ngăn double mint khi submit endpoint được gọi nhiều lần
  const existingDeposit = await findGuestDepositByOrderCodeRepo(orderCode);
  const alreadyMinted = existingDeposit && existingDeposit.status !== 'PENDING_PAYMENT' && existingDeposit.mintTxHash;

  if (alreadyMinted) {
    logger.info('Deposit đã được mint trước đó, bỏ qua bước mint.', { orderCode });
  }

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const backendSigner = new ethers.Wallet(backendPrivateKey, provider);

  logger.info('Bắt đầu mint và auto-donate cho guest.', {
    sessionId,
    walletAddress,
    amount: normalizedAmount,
    projectId,
    orderCode,
    userOpHash: userOpHash ? `${userOpHash.substring(0, 10)}...[REDACTED]` : undefined
  });

  // === Bước 1: Cập nhật trạng thái MINTING ===
  await updateGuestDepositStatus(orderCode, {
    status: 'MINTING',
    userOpHash,
    updatedAt: new Date()
  });

  // === Bước 2: Mint token vào guest wallet address ===
  let mintTxHashValue: string = alreadyMinted ? existingDeposit.mintTxHash! : '';
  if (!alreadyMinted) {
    try {
      const tokenContract = new ethers.Contract(charityTokenAddress, mintAbi, backendSigner);
      const amountBigInt = BigInt(normalizedAmount);

      const mintTx = await tokenContract.mintFromBackend(
        walletAddress,
        amountBigInt,
        `AUTO_DONATE_${orderCode}`
      );
      const receipt = await mintTx.wait(2);

      if (!receipt?.hash) {
        throw new Error('Không lấy được transaction hash sau khi mint token.');
      }

      mintTxHashValue = receipt.hash;
      logger.info('Mint token thành công.', {
        orderCode,
        transactionHash: mintTxHashValue,
        guestWalletAddress: walletAddress,
        amount: normalizedAmount
      });
    } catch (error) {
      logger.error('Mint token thất bại.', {
        orderCode,
        errorMessage: (error as Error).message
      });
      await updateGuestDepositStatus(orderCode, {
        status: 'DONATION_FAILED',
        userOpHash,
        errorMessage: `Mint token thất bại: ${(error as Error).message}`,
        updatedAt: new Date()
      });
      throw error;
    }
  }

  // === Bước 3: Cập nhật trạng thái DONATION_EXECUTING ===
  await updateGuestDepositStatus(orderCode, {
    status: 'DONATION_EXECUTING',
    mintTxHash: mintTxHashValue,
    userOpHash,
    updatedAt: new Date()
  });

  // === Bước 4: Submit signed UserOp lên Bundler ===
  // msg.sender trong donate() sẽ là guest Smart Wallet ✅
  // Backend chỉ forward — không ký UserOp (signature đã có từ FE)
  let donationTxHashValue: string;
  try {
    logger.info('Bắt đầu submit signed UserOp lên Bundler.', {
      orderCode,
      sender: signedUserOp.sender,
      userOpHash
    });

    donationTxHashValue = await submitSignedUserOpToBundler(signedUserOp, paymasterAndData);

    logger.info('Auto-donate thành công qua Bundler.', {
      orderCode,
      transactionHash: donationTxHashValue,
      amount: normalizedAmount
    });
  } catch (error) {
    logger.error('Auto-donate thất bại.', {
      orderCode,
      errorMessage: (error as Error).message
    });
    await updateGuestDepositStatus(orderCode, {
      status: 'DONATION_FAILED',
      mintTxHash: mintTxHashValue,
      userOpHash,
      errorMessage: `Donate thất bại: ${(error as Error).message}`,
      updatedAt: new Date()
    });
    throw error;
  }

  // === Bước 5: Cập nhật trạng thái DONATION_COMPLETED ===
  await updateGuestDepositStatus(orderCode, {
    status: 'DONATION_COMPLETED',
    mintTxHash: mintTxHashValue,
    donationTxHash: donationTxHashValue,
    userOpHash,
    errorMessage: null,
    updatedAt: new Date()
  });

  // === Bước 6: Cập nhật session counters (atomic increment) ===
  try {
    await incrementSessionDonationCounters(sessionId, normalizedAmount);
    logger.info('Session counters đã cập nhật.', {
      sessionId,
      orderCode,
      amount: normalizedAmount
    });
  } catch (error) {
    logger.warn('Không thể cập nhật session counters.', {
      sessionId,
      orderCode,
      errorMessage: (error as Error).message
    });
  }

  // === Bước 7: Cập nhật project metrics ===
  try {
    await applyDonationToMetrics(projectId, normalizedAmount, walletAddress, 1.0);
    logger.info('Project metrics đã cập nhật.', {
      projectId,
      orderCode,
      amount: normalizedAmount
    });
  } catch (error) {
    logger.warn('Không thể cập nhật project metrics.', {
      projectId,
      orderCode,
      errorMessage: (error as Error).message
    });
  }

  return { mintTxHash: mintTxHashValue, donationTxHash: donationTxHashValue };
}
