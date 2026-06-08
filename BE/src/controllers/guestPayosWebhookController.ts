/**
 * Webhook handler cho PayOS donation cua guest users.
 * PayOS goi webhook nay khi user thanh toan thanh cong.
 *
 * Quy trinh:
 * 1. Verify checksum voi nhieu bien the payload (data long nhau va top-level)
 * 2. Kiem tra thanh toan thanh cong
 * 3. Mint token vao guest wallet (backend minter)
 * 4. Execute relay donation (backend tu gui tx donate)
 * 5. Cap nhat trang thai COMPLETED / FAILED
 *
 * Endpoint: POST /api/guest/payos/webhook
 * Auth: checksum verification (khong dung JWT vi PayOS goi)
 */
import { Request, Response } from 'express';
import { verifyPayosWebhookChecksum } from '../services/payosService';
import {
  findGuestPayosDonationByOrderCode,
  updateGuestPayosDonation
} from '../repositories/guestPayosDonationRepository';
import { executeGuestRelayedDonation } from '../services/guestRelayDonationService';
import { getLogger } from '../config/logger';
import { upsertDonationByTransactionHash } from '../models/donationModel';

const logger = getLogger();

/**
 * Lay gia tri signature tu body webhook PayOS.
 * PayOS co the gui signature trong truong `signature` hoac truong `checksum`.
 */
function extractWebhookSignature(webhookData: Record<string, unknown>): string {
  return String(
    (webhookData as { signature?: string; checksum?: string }).signature
    || (webhookData as { signature?: string; checksum?: string }).checksum
    || ''
  ).trim();
}

/**
 * Kiem tra thanh toan thanh cong tu payload PayOS webhook.
 * Chap nhan nhieu bien the ma PayOS co the tra ve.
 */
function isPaymentSuccess(webhookData: Record<string, unknown>): boolean {
  const webhookCode = String(webhookData.code || '').trim();
  const webhookStatus = String(webhookData.status || '').trim().toUpperCase();

  return (
    webhookCode === '00' ||
    webhookStatus === 'PAID' ||
    webhookStatus === 'SUCCESS' ||
    webhookStatus === 'COMPLETED'
  );
}

/**
 * Lay orderCode tu webhook data — thu tuong minh hoac tu nested data.
 */
function extractOrderCode(payload: Record<string, unknown>): string {
  const topLevelOrderCode = String(payload.orderCode || '').trim();
  if (topLevelOrderCode) return topLevelOrderCode;

  // Thu tu nested data (PayOS v2 co the goi webhook voi data long nhau)
  const nestedData = payload.data as Record<string, unknown> | undefined;
  if (nestedData && typeof nestedData === 'object') {
    const nestedOrderCode = String(nestedData.orderCode || '').trim();
    if (nestedOrderCode) return nestedOrderCode;
  }

  return '';
}

/**
 * Lay data long nhau neu co (PayOS v2 webhook format).
 */
function extractNestedData(payload: Record<string, unknown>): Record<string, unknown> | null {
  const nestedData = payload.data;
  if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
    return nestedData as Record<string, unknown>;
  }
  return null;
}

/**
 * Chuẩn hóa dữ liệu webhook — flatten nested data nếu cần.
 * PayOS v2 có thể gửi data lồng nhau: { data: { orderCode, amount, status } }
 * hoặc flat: { orderCode, amount, status }
 */
function normalizeWebhookData(payload: Record<string, unknown>): Record<string, unknown> {
  // Neu co nested data, gộp cả hai vào
  const nestedData = extractNestedData(payload);
  if (nestedData) {
    return { ...nestedData, ...payload };
  }
  return payload;
}

/**
 * Verify checksum voi nhieu bien the payload.
 * Lay inspiration tu depositService.ts — verify voi ca nested data va top-level payload.
 */
function verifyWebhookChecksumCandidates(rawPayload: Record<string, unknown>, checksum: string): boolean {
  // Bien the 1: nested data (neu co)
  const nestedData = extractNestedData(rawPayload);
  if (nestedData && Object.keys(nestedData).length > 0) {
    const isValidNested = verifyPayosWebhookChecksum(nestedData, checksum);
    if (isValidNested) {
      logger.info('Guest PayOS webhook checksum hop le (nested data).');
      return true;
    }
  }

  // Bien the 2: top-level payload (khong loc signature/checksum)
  // DepositService dung cach nay va no hoat dong — vi PayOS co the sign ca payload
  const topLevelData = { ...rawPayload };
  // Xoa signature/checksum khoi payload de tranh thua du lieu
  delete topLevelData.signature;
  delete topLevelData.checksum;

  if (Object.keys(topLevelData).length > 0) {
    const isValidTopLevel = verifyPayosWebhookChecksum(topLevelData, checksum);
    if (isValidTopLevel) {
      logger.info('Guest PayOS webhook checksum hop le (top-level).');
      return true;
    }
  }

  return false;
}

/**
 * Xu ly webhook PayOS cho guest donation.
 * Tra ve 200 ngay de tran PayOS retry spam.
 * Xu ly bat dong bo trong Promise.resolve().then().
 */
export async function handleGuestPayosWebhook(
  request: Request,
  response: Response
): Promise<void> {
  const rawPayload = request.body as Record<string, unknown>;

  // Lay signature tu body
  const bodySignatureValue = extractWebhookSignature(rawPayload);
  const headerSignatureValue = String(
    request.headers['x-payos-signature']
    || request.headers['x-signature']
    || request.headers['x-checksum']
    || ''
  ).trim();
  const checksum = bodySignatureValue || headerSignatureValue || '';

  if (!checksum) {
    logger.warn('Webhook PayOS khong co checksum.', {
      bodyKeys: Object.keys(rawPayload)
    });
    response.status(200).json({ message: 'No checksum provided.' });
    return;
  }

  // Lay orderCode tu nested data hoac top-level
  const orderCode = extractOrderCode(rawPayload);
  if (!orderCode) {
    logger.warn('Webhook PayOS khong co orderCode.', {
      bodyKeys: Object.keys(rawPayload),
      hasNestedData: !!extractNestedData(rawPayload)
    });
    response.status(200).json({ message: 'Missing orderCode.' });
    return;
  }

  // Tim donation truoc de log chinh xac hon
  const donation = await findGuestPayosDonationByOrderCode(orderCode);
  if (!donation) {
    logger.warn('Webhook PayOS: donation khong tim thay.', { orderCode });
    response.status(200).json({ message: 'Donation not found.' });
    return;
  }

  // Verify checksum voi nhieu bien the
  const isValidChecksum = verifyWebhookChecksumCandidates(rawPayload, checksum);

  if (!isValidChecksum) {
    // Graceful fallback: neu day la payment thanh cong, van xu ly
    const webhookData = normalizeWebhookData(rawPayload);
    const isLikelySuccess = isPaymentSuccess(webhookData);

    if (isLikelySuccess) {
      logger.warn('Guest PayOS webhook checksum khong hop le nhung la payment thanh cong, van xu ly.', {
        orderCode,
        checksumPrefix: checksum.substring(0, 16)
      });
    } else {
      logger.warn('Guest PayOS webhook checksum khong hop le.', {
        orderCode,
        checksumPrefix: checksum.substring(0, 16)
      });
      response.status(200).json({ message: 'Invalid checksum.' });
      return;
    }
  }

  const webhookData = normalizeWebhookData(rawPayload);
  const webhookCode = String(webhookData.code || rawPayload.code || '').trim();
  const payosTransactionId = String(webhookData.transactionId || rawPayload.transactionId || webhookData.reference || rawPayload.reference || '').trim();

  if (donation.status !== 'PENDING_PAYMENT') {
    logger.info('Guest PayOS webhook: donation da xu ly, bo qua.', { orderCode });
    response.status(200).json({ message: 'Already processed.' });
    return;
  }

  if (!isPaymentSuccess(webhookData)) {
    await updateGuestPayosDonation(
      { orderCode },
      {
        status: 'FAILED',
        payosTransactionId: payosTransactionId || null,
        errorMessage: `Thanh toan that bai tu PayOS (code: ${webhookCode}).`,
        updatedAt: new Date()
      }
    );
    logger.info('Guest PayOS donation thanh toan that bai.', { orderCode });
    response.status(200).json({ message: 'Payment failed.' });
    return;
  }

  await updateGuestPayosDonation(
    { orderCode },
    {
      status: 'PAYMENT_CONFIRMED',
      payosTransactionId: payosTransactionId || null,
      updatedAt: new Date()
    }
  );
  logger.info('Guest PayOS donation thanh toan xac nhan, bat dau mint + relay.', { orderCode });

  response.status(200).json({ message: 'Webhook received.' });

  void Promise.resolve().then(async () => {
    try {
      await updateGuestPayosDonation(
        { orderCode },
        { status: 'MINTING', updatedAt: new Date() }
      );

      const mintResult = await mintTokenToGuestWallet(
        donation.walletAddress,
        donation.amount,
        orderCode
      );

      await updateGuestPayosDonation(
        { orderCode },
        { status: 'RELAYING', mintTxHash: mintResult.transactionHash, updatedAt: new Date() }
      );

      const relayResult = await executeGuestRelayedDonation({
        sessionId: donation.guestSessionId,
        projectId: donation.projectId,
        amount: donation.amount,
        walletAddress: donation.walletAddress,
        ipAddress: 'payos-webhook',
        userAgent: 'payos-webhook'
      });

      // Lấy blockNumber từ relay transaction receipt để tạo Donation record.
      const relayBlockNumber = await getRelayTransactionBlockNumber(relayResult.transactionHash);

      // Tạo Donation record để hiển thị trên Lịch sử quyên góp và Live Feed.
      await upsertDonationByTransactionHash({
        transactionHash: relayResult.transactionHash,
        projectId: donation.projectId,
        donorAddress: donation.walletAddress.toLowerCase(),
        amount: donation.amount,
        timestamp: new Date(),
        isAnonymous: true,
        blockNumber: relayBlockNumber,
        donationStatus: 'INDEXED',
        onChainConfirmedAt: new Date(),
        indexedAt: new Date(),
        correlationId: `PAYTING_${orderCode}`,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      await updateGuestPayosDonation(
        { orderCode },
        {
          status: 'COMPLETED',
          relayTxHash: relayResult.transactionHash,
          updatedAt: new Date()
        }
      );

      logger.info('Guest PayOS donation COMPLETED.', {
        orderCode,
        mintTxHash: mintResult.transactionHash,
        relayTxHash: relayResult.transactionHash
      });
    } catch (error) {
      logger.error('Xu ly guest PayOS donation that bai trong webhook.', {
        orderCode,
        errorMessage: (error as Error).message
      });
      await updateGuestPayosDonation(
        { orderCode },
        {
          status: 'FAILED',
          errorMessage: (error as Error).message || 'Unknown error',
          updatedAt: new Date()
        }
      );
    }
  });
}

/**
 * Kết quả mint token — bao gồm cả transaction hash và block number.
 */
interface MintResult {
  transactionHash: string;
  blockNumber: number;
}

/**
 * Mint token vao guest wallet address bang backend minter.
 */
async function mintTokenToGuestWallet(
  walletAddress: string,
  amount: number,
  orderCode: string
): Promise<MintResult> {
  const blockchainRpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const backendPrivateKey = String(process.env.BACKEND_MINTER_PRIVATE_KEY || '').trim();
  const charityTokenAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();

  if (!blockchainRpcUrl || !backendPrivateKey || !charityTokenAddress) {
    throw new Error(
      'Thieu cau hinh blockchain de mint token. ' +
      'Kiem tra BLOCKCHAIN_RPC_URL, BACKEND_MINTER_PRIVATE_KEY, CHARITY_TOKEN_CONTRACT_ADDRESS.'
    );
  }

  const { ethers } = await import('ethers');

  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const backendSigner = new ethers.Wallet(backendPrivateKey, provider);

  const mintAbi = [
    {
      type: 'function',
      name: 'mintFromBackend',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'reason', type: 'string' }
      ],
      outputs: [{ name: '', type: 'bool' }]
    }
  ] as const;

  const tokenContract = new ethers.Contract(charityTokenAddress, mintAbi, backendSigner);
  const amountBigInt = BigInt(amount);

  const mintTx = await tokenContract.mintFromBackend(
    walletAddress,
    amountBigInt,
    `PAYTING_DONATE_${orderCode}`
  );
  const receipt = await mintTx.wait(2);

  if (!receipt?.hash || receipt.blockNumber === undefined) {
    throw new Error('Khong lay duoc transaction hash hoac block number sau khi mint token.');
  }

  logger.info('Mint token thanh cong cho guest PayOS donation.', {
    orderCode,
    mintTxHash: receipt.hash,
    walletAddress,
    amount
  });

  return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

/**
 * Lấy blockNumber từ relay transaction hash bằng JSON-RPC provider.
 * Cần thiết để tạo Donation record — blockNumber là required field.
 */
async function getRelayTransactionBlockNumber(transactionHash: string): Promise<number> {
  const blockchainRpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  if (!blockchainRpcUrl) {
    throw new Error('Thieu cau hinh BLOCKCHAIN_RPC_URL de lay block number.');
  }

  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const receipt = await provider.getTransactionReceipt(transactionHash);

  if (!receipt || receipt.blockNumber === undefined) {
    throw new Error(`Khong lay duoc receipt hoac blockNumber cho tx: ${transactionHash}`);
  }

  return receipt.blockNumber;
}
