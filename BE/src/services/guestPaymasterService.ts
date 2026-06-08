/**
 * Service chứa business logic cho Paymaster sponsorship — tách biệt khỏi HTTP layer.
 * Cung cấp 2 đường dẫn Paymaster dựa trên risk score:
 * - riskScore < 70:  ZeroDev Free Paymaster (sponsor 100% gas)
 * - riskScore >= 70: Custom Token Paymaster (tài trợ gas trước, khấu trừ ~1 CharityToken)
 */
import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { getZeroDevConfig } from '../config/zeroDev';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { findGuestWalletSessionById, reserveDonationSlot } from '../repositories/guestWalletSessionRepository';
import { upsertGuestDonationRisk } from '../repositories/guestDonationRiskRepository';
import { findAuditByUserOpHash, createAuditRecord } from '../repositories/anonymousDonationAuditRepository';
import { evaluateGuestRisk } from './guestRiskService';
import { GuestWalletSession } from '../models/guestWalletSessionModel';
import { findProjectById } from '../repositories/projectRepository';
import mongoose from 'mongoose';
import {
  MAX_TOTAL_AMOUNT_PER_SESSION,
  MAX_AMOUNT_PER_DONATION,
  MIN_AMOUNT_PER_DONATION,
  RISK_THRESHOLD_FOR_TOKEN_PAYMASTER,
  TOKEN_PAYMASTER_GAS_FEE_TOKEN,
  AMOUNT_TOLERANCE
} from '../constants/guestDonation';

const logger = getLogger();

/** Địa chỉ charity token trên Amoy — validate khi module được import đầu tiên. */
const CHARITY_TOKEN_ADDRESS = (() => {
  const addr = process.env.CHARITY_TOKEN_ADDRESS;
  if (!addr || !addr.startsWith('0x')) {
    throw new Error(
      'CHARITY_TOKEN_ADDRESS chưa được cấu hình hợp lệ. ' +
      'Đặt CHARITY_TOKEN_ADDRESS trong .env để Token Paymaster hoạt động cho riskScore >= 70.'
    );
  }
  return addr;
})();

/** Chain ID Polygon Amoy. */
const CHAIN_ID_AMOY = 80002;

/** Timeout cho ZeroDev Paymaster API calls (ms). */
const PAYMASTER_TIMEOUT_MS = 10_000;

/**
 * Kết quả sponsor Paymaster.
 */
export type SponsorPaymasterResult = {
  paymasterAndData: string;
  userOpHash: string;
  sponsorshipId: string;
  paymasterType: 'FREE' | 'TOKEN';
  paymasterSponsoredGas: boolean;
  gasChargeAmount?: number;
  gasChargeWarning?: boolean;
  trustMultiplier: number;
  riskScore: number;
};

/**
 * Payload yêu cầu sponsor Paymaster từ frontend.
 * @remarks field `amount` chỉ dùng để validate giới hạn ở controller.
 * Giá trị thực được trích xuất từ calldata tại service layer để tránh tampering.
 */
export type SponsorPaymasterRequest = {
  unsignedUserOp: {
    sender: string;
    nonce: bigint | string | number;
    initCode: `0x${string}` | string;
    callData: `0x${string}` | string;
    callGasLimit?: bigint | string | number;
    verificationGasLimit?: bigint | string | number;
    preVerificationGas?: bigint | string | number;
    maxFeePerGas?: bigint | string | number;
    maxPriorityFeePerGas?: bigint | string | number;
    paymasterAndData?: `0x${string}` | string;
    signature?: `0x${string}` | string;
  };
  projectId: string;
  amount: number;
  sessionId: string;
};

/** Interface cho Charity contract donate function. */
const CHARITY_INTERFACE = new ethers.Interface([
  'function donate(uint256 projectId, uint256 amount, bool isAnonymous)'
]);

/**
 * Hàm decode calldata để verify donation method và extract parameters.
 * Dùng ethers.Interface để ABI-decode đúng chuẩn EIP-4337.
 * Calldata là ABI-encoded hex, KHÔNG phải comma-separated ASCII.
 *
 * Security: chỉ sponsor các UserOp thực hiện donate() hợp lệ,
 * chống attacker craft calldata gọi function khác.
 */
function decodeDonationCalldata(calldata: string): {
  valid: true;
  data: { projectId: string; amount: number };
} | { valid: false; reason: string } {
  try {
    const cleanCalldata = calldata.startsWith('0x') ? calldata : `0x${calldata}`;

    const parsed = CHARITY_INTERFACE.parseTransaction({ data: cleanCalldata });

    if (!parsed || parsed.name !== 'donate') {
      return { valid: false, reason: 'Calldata không phải donate function.' };
    }

    const [projectIdRaw, amountRaw, isAnonymousRaw] = parsed.args;

    // projectId: convert BigInt → string
    const projectId = projectIdRaw.toString();

    // amount: convert from wei (18 decimals) → token amount
    const amountInToken = Number(ethers.formatUnits(amountRaw, 18));

    // isAnonymous phải là true cho guest flow
    const isAnonymous = Boolean(isAnonymousRaw);
    if (!isAnonymous) {
      return { valid: false, reason: 'Chỉ hỗ trợ donate ẩn danh qua guest flow.' };
    }

    // Validate projectId format
    if (!projectId || projectId.length < 10) {
      return { valid: false, reason: 'ProjectId không hợp lệ.' };
    }

    // Validate amount range (sau khi convert từ wei)
    if (amountInToken < MIN_AMOUNT_PER_DONATION) {
      return { valid: false, reason: `Amount donation phải lớn hơn hoặc bằng ${MIN_AMOUNT_PER_DONATION} Token.` };
    }
    if (amountInToken > MAX_AMOUNT_PER_DONATION) {
      return { valid: false, reason: `Amount donation tối đa ${MAX_AMOUNT_PER_DONATION} Token cho guest.` };
    }

    return {
      valid: true,
      data: { projectId, amount: amountInToken }
    };
  } catch {
    // Lỗi decode → không phải valid donate calldata
    return { valid: false, reason: 'Không thể decode calldata. Calldata không đúng định dạng ABI.' };
  }
}

/**
 * Hàm compute deterministic hash từ unsignedUserOp để tạo unique userOpHash.
 * Mục đích: tạo hash cho duplicate check và audit trail.
 *
 * Dùng ethers.keccak256 (Keccak-256) — standard của Ethereum/EntryPoint.
 * KHÔNG dùng SHA3-256 (FIPS-202 / NIST standard) vì Ethereum dùng Keccak-256.
 *
 * Encoding: RLP-like format (entryPoint + sender + nonce + hash(callData))
 * để tạo deterministic hash mà không phụ thuộc gas fields có thể thay đổi.
 */
function computeUserOpHash(
  userOp: SponsorPaymasterRequest['unsignedUserOp']
): string {
  const sender = ethers.zeroPadValue(
    ethers.isAddress(userOp.sender) ? userOp.sender : '0x0000000000000000000000000000000000000000',
    32
  );
  const nonceValue = BigInt(String(userOp.nonce).replace(/n$/, ''));
  const nonce = ethers.zeroPadValue(ethers.toBeHex(nonceValue, 32), 32);
  const callDataHash = ethers.keccak256(userOp.callData || '0x');
  const initCodeHash = ethers.keccak256(userOp.initCode || '0x');

  // RLP-like concatenation: [sender, nonce, initCodeHash, callDataHash]
  const packed = ethers.concat([sender, nonce, initCodeHash, callDataHash]);
  return ethers.keccak256(packed);
}

/**
 * Hàm normalize UserOp fields thành chuỗi cho ZeroDev API.
 */
function normalizeUserOpForApi(
  userOp: SponsorPaymasterRequest['unsignedUserOp']
): Record<string, string> {
  return {
    sender: String(userOp.sender),
    nonce: String(userOp.nonce).replace(/n$/, ''),
    initCode: String(userOp.initCode || '0x'),
    callData: String(userOp.callData),
    callGasLimit: String(userOp.callGasLimit || '21000'),
    verificationGasLimit: String(userOp.verificationGasLimit || '100000'),
    preVerificationGas: String(userOp.preVerificationGas || '21000'),
    maxFeePerGas: String(userOp.maxFeePerGas || '150000000'),
    maxPriorityFeePerGas: String(userOp.maxPriorityFeePerGas || '150000000'),
    paymasterAndData: String(userOp.paymasterAndData || '0x'),
    signature: String(userOp.signature || '0x')
  };
}

/**
 * Hàm build Paymaster API URL cho ZeroDev v3.
 * ZeroDev v3 dùng cùng RPC URL pattern: https://rpc.zerodev.app/api/v3/{projectId}/chain/{chainId}
 * Paymaster endpoint: https://rpc.zerodev.app/api/v3/{projectId}/paymaster
 */
function buildPaymasterEndpoint(config: ReturnType<typeof getZeroDevConfig>, suffix: string): string {
  return `https://rpc.zerodev.app/api/v3/${config.projectId}${suffix}`;
}

/**
 * Hàm gọi ZeroDev Paymaster API để sponsor gas miễn phí cho low-risk sessions.
 */
async function callFreePaymaster(
  sessionId: string,
  userOp: SponsorPaymasterRequest['unsignedUserOp']
): Promise<{ paymasterAndData: string; userOpHash: string }> {
  const config = getZeroDevConfig();
  const endpoint = buildPaymasterEndpoint(config, '/paymaster');

  const normalizedUserOp = normalizeUserOpForApi(userOp);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(PAYMASTER_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'pm_sponsorUserOperation',
      params: [
        normalizedUserOp,
        {
          entryPoint: config.entryPointAddress,
          chainId: CHAIN_ID_AMOY
        }
      ],
      id: 1
    })
  });

  if (!response.ok) {
    let rawBody = '[unreadable body]';
    try {
      rawBody = await response.text();
    } catch {
      // Non-parseable body — log what we can
    }
    logger.warn('ZeroDev Free Paymaster API error.', {
      status: response.status,
      body: rawBody.length > 200 ? `${rawBody.slice(0, 200)}...` : rawBody,
      sessionId
    });
    throw new ApplicationError(
      `ZeroDev Paymaster từ chối sponsorship. Status: ${response.status}`,
      502,
      'PAYMASTER_POLICY_MISMATCH'
    );
  }

  const result = await response.json();

  if (result.error) {
    throw new ApplicationError(
      `ZeroDev Paymaster error: ${result.error.message || 'Unknown'}`,
      502,
      'PAYMASTER_POLICY_MISMATCH'
    );
  }

  return {
    paymasterAndData: result.result.paymasterAndData,
    userOpHash: result.result.userOpHash
  };
}

/**
 * Hàm gọi ZeroDev Token Paymaster cho high-risk sessions.
 * Tài trợ gas trước, khấu trừ CharityToken từ ví guest sau.
 */
async function callTokenPaymaster(
  sessionId: string,
  userOp: SponsorPaymasterRequest['unsignedUserOp']
): Promise<{ paymasterAndData: string; userOpHash: string }> {
  const config = getZeroDevConfig();
  const endpoint = buildPaymasterEndpoint(config, '/token-paymaster');

  const normalizedUserOp = normalizeUserOpForApi(userOp);
  const tokenAmount = String(TOKEN_PAYMASTER_GAS_FEE_TOKEN * 1e18);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(PAYMASTER_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'pm_sponsorUserOperation',
      params: [
        normalizedUserOp,
        {
          entryPoint: config.entryPointAddress,
          chainId: CHAIN_ID_AMOY,
          token: CHARITY_TOKEN_ADDRESS,
          amount: tokenAmount
        }
      ],
      id: 1
    })
  });

  if (!response.ok) {
    let rawBody = '[unreadable body]';
    try {
      rawBody = await response.text();
    } catch {
      // Non-parseable body — log what we can
    }
    logger.warn('ZeroDev Token Paymaster API error.', {
      status: response.status,
      body: rawBody.length > 200 ? `${rawBody.slice(0, 200)}...` : rawBody
    });
    throw new ApplicationError(
      `ZeroDev Token Paymaster từ chối. Status: ${response.status}`,
      502,
      'PAYMASTER_POLICY_MISMATCH'
    );
  }

  const result = await response.json();

  if (result.error) {
    throw new ApplicationError(
      `ZeroDev Token Paymaster error: ${result.error.message || 'Unknown'}`,
      502,
      'PAYMASTER_POLICY_MISMATCH'
    );
  }

  return {
    paymasterAndData: result.result.paymasterAndData,
    userOpHash: result.result.userOpHash
  };
}

/**
 * Hàm validate session cơ bản trước khi sponsor.
 * Mục đích: kiểm tra wallet match và expiry.
 * Các quota checks (donationCount, hasPendingDonation, totalDonatedAmount)
 * được handle atomically bởi reserveDonationSlot bên trong transaction.
 */
async function validateSessionForSponsorship(
  sessionId: string,
  walletAddress: string
): Promise<GuestWalletSession> {
  const session = await findGuestWalletSessionById(sessionId);

  if (!session) {
    throw new ApplicationError('Guest session không tồn tại.', 401, 'GUEST_SESSION_NOT_FOUND');
  }

  if (session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new ApplicationError('Wallet address không khớp với session.', 403, 'FORBIDDEN');
  }

  if (session.status !== 'ACTIVE') {
    throw new ApplicationError(
      `Session đang ở trạng thái "${session.status}", không thể sponsor.`,
      403,
      'GUEST_SESSION_NOT_ACTIVE'
    );
  }

  if (session.expiresAt < new Date()) {
    throw new ApplicationError(
      'Guest session đã hết hạn. Vui lòng tạo phiên mới.',
      401,
      'GUEST_SESSION_EXPIRED'
    );
  }

  return session;
}

/**
 * Hàm sponsor guest donation Paymaster.
 *
 * Quy trình:
 * 1. Validate session + quota (dùng amount từ request body để check limit)
 * 2. Decode + validate calldata (trích xuất amount thực từ calldata)
 * 3. Cross-check: amount trong calldata phải khớp với request body (±5% tolerance)
 * 4. Check duplicate userOpHash
 * 5. Read risk score từ DB → chọn Paymaster type
 * 6. Gọi Paymaster API tương ứng
 * 7. Tạo AnonymousDonationAudit record + set hasPendingDonation trong 1 transaction
 * 8. Return sponsorship data
 *
 * @throws ApplicationError nếu validation thất bại hoặc Paymaster từ chối
 */
export async function sponsorGuestDonation(
  request: SponsorPaymasterRequest,
  ipAddress: string,
  userAgent: string
): Promise<SponsorPaymasterResult> {
  const { unsignedUserOp, projectId, sessionId } = request;
  const sponsorshipId = uuidv4();

  // Buoc 1: Validate session cơ bản (wallet match, expiry)
  // Session được fetch ở đây và reuse trong suốt function để tránh duplicate DB calls
  // Quota checks (donationCount, hasPendingDonation, totalDonatedAmount) được handle
  // atomically bởi reserveDonationSlot bên trong transaction ở Bước 8.
  const session = await validateSessionForSponsorship(
    sessionId,
    unsignedUserOp.sender
  );

  // Buoc 2: Decode + validate calldata — trích xuất amount thực từ calldata
  const decodedResult = decodeDonationCalldata(unsignedUserOp.callData);
  if (!decodedResult.valid) {
    throw new ApplicationError(decodedResult.reason, 400, 'INVALID_CALLDATA');
  }

  // Buoc 3: Cross-check request body amount vs calldata amount để chống tampering
  // Tolerance = 0.001 (AMOUNT_TOLERANCE), nhỏ hơn đơn vị tối thiểu để ngăn tampering.
  const amountFromCalldata = decodedResult.data.amount;
  const amountFromBody = request.amount;
  if (Math.abs(amountFromCalldata - amountFromBody) > AMOUNT_TOLERANCE) {
    throw new ApplicationError(
      'Số tiền donation không khớp với calldata. Vui lòng thử lại.',
      400,
      'INVALID_CALLDATA'
    );
  }

  // Buoc 4: Validate project tồn tại và đang ACTIVE
  const projectRecord = await findProjectById(projectId);
  if (!projectRecord) {
    throw new ApplicationError('Dự án không tồn tại.', 404, 'PROJECT_NOT_FOUND');
  }
  if (projectRecord.status !== 'ACTIVE') {
    throw new ApplicationError('Dự án không còn nhận donation.', 400, 'PROJECT_NOT_ACTIVE');
  }

  // Buoc 5: Compute userOpHash for duplicate check
  const userOpHash = computeUserOpHash(unsignedUserOp);
  const existingAudit = await findAuditByUserOpHash(userOpHash);
  if (existingAudit) {
    throw new ApplicationError('UserOperation đã được sponsor trước đó.', 409, 'DUPLICATE_USEROP');
  }

  // Buoc 6: Re-evaluate risk score trước mỗi donation để phát hiện thay đổi
  // Fresh evaluation phản ánh tình trạng thực tế tại thời điểm sponsor.
  // Truyền session object thay vì chỉ deviceFingerprintHash — tránh duplicate DB fetch
  // bên trong evaluateGuestRisk → checkDonationPattern → findAuditsBySessionId.
  // Truyền session.createdAt để checkSessionVelocity hoạt động chính xác.
  const freshRisk = await evaluateGuestRisk(session, ipAddress, session.createdAt);
  const riskScore = freshRisk.riskScore;
  const trustMultiplier = freshRisk.trustMultiplier;

  // Luôn cập nhật risk record với kết quả mới nhất
  await upsertGuestDonationRisk(sessionId, {
    sessionId,
    walletAddress: unsignedUserOp.sender.toLowerCase(),
    riskScore: freshRisk.riskScore,
    riskLevel: freshRisk.riskLevel,
    trustMultiplier: freshRisk.trustMultiplier,
    factors: freshRisk.factors,
    blocked: freshRisk.blocked,
    blockedAt: freshRisk.blocked ? new Date() : null,
    blockedReason: freshRisk.blocked ? 'Risk score exceeds CRITICAL threshold' : null
  });

  // Risk >= 70 → Token Paymaster (thu ~1 CharityToken). Không block CRITICAL sessions.
  // Token Paymaster sẽ reject nếu user không đủ token.
  const useTokenPaymaster = riskScore >= RISK_THRESHOLD_FOR_TOKEN_PAYMASTER;

  // Buoc 7: Gọi Paymaster API tương ứng
  let paymasterResult: { paymasterAndData: string; userOpHash: string };

  if (useTokenPaymaster) {
    logger.info('High-risk session — using Token Paymaster.', {
      sessionId,
      riskScore,
      walletAddress: unsignedUserOp.sender
    });
    paymasterResult = await callTokenPaymaster(sessionId, unsignedUserOp);
  } else {
    paymasterResult = await callFreePaymaster(sessionId, unsignedUserOp);
  }

  // Buoc 8: Tạo audit record + reserve donation slot trong 1 MongoDB transaction
  // Dùng reserveDonationSlot thay vì riêng check + set hasPendingDonation
  // để tránh race condition TOCTOU khi nhiều request đồng thời.
  // reserveDonationSlot atomically check tất cả quota conditions và set hasPendingDonation = true.
  // Giới hạn totalDonatedAmount hiện tại để sau khi cộng thêm amountFromCalldata
  // không vượt quá MAX_TOTAL_AMOUNT_PER_SESSION * 100 (đơn vị: 0.01 Token).
  // reserveDonationSlot check: session.totalDonatedAmount <= maxAllowedCurrentTotal.
  // Nếu amountFromCalldata quá lớn (tiệm cận limit), maxAllowedCurrentTotal sẽ âm
  // → MongoDB $lte sẽ không match → reject với CONFLICT.
  const maxAllowedCurrentTotal = MAX_TOTAL_AMOUNT_PER_SESSION * 100 - amountFromCalldata * 100;
  const now = new Date();
  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      // Reserve slot atomically — check-and-set trong một operation
      const reservedSession = await reserveDonationSlot(
        sessionId,
        unsignedUserOp.sender.toLowerCase(),
        maxAllowedCurrentTotal
      );
      if (!reservedSession) {
        throw new ApplicationError(
          'Không thể bắt đầu donation. Quota đã hết hoặc có donation đang chờ.',
          409,
          'CONFLICT'
        );
      }

      await createAuditRecord({
        auditId: uuidv4(),
        sessionId,
        walletAddress: unsignedUserOp.sender.toLowerCase(),
        projectId,
        amount: amountFromCalldata,
        trustMultiplier,
        riskScore,
        userOpHash,
        onChainTxHash: null,
        onChainBlockNumber: null,
        paymasterSponsoredGas: !useTokenPaymaster,
        claimedByUserId: null,
        isAnonymous: true,
        ipAddress,
        userAgent,
        createdAt: now,
        indexedAt: null
      }, mongoSession);
      // hasPendingDonation đã được set = true bởi reserveDonationSlot ở trên
    });
  } finally {
    await mongoSession.endSession();
  }

  logger.info('Guest donation sponsored.', {
    sponsorshipId,
    sessionId,
    walletAddress: unsignedUserOp.sender,
    paymasterType: useTokenPaymaster ? 'TOKEN' : 'FREE',
    riskScore,
    trustMultiplier,
    amount: amountFromCalldata
  });

  // Buoc 9: Return result
  const result: SponsorPaymasterResult = {
    paymasterAndData: paymasterResult.paymasterAndData,
    userOpHash: paymasterResult.userOpHash,
    sponsorshipId,
    paymasterType: useTokenPaymaster ? 'TOKEN' : 'FREE',
    paymasterSponsoredGas: !useTokenPaymaster,
    trustMultiplier,
    riskScore
  };

  if (useTokenPaymaster) {
    result.gasChargeAmount = TOKEN_PAYMASTER_GAS_FEE_TOKEN;
    result.gasChargeWarning = true;
  }

  return result;
}

/**
 * Export các pure functions để unit test.
 */
export { decodeDonationCalldata, computeUserOpHash };
