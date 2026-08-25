import { ethers } from 'ethers';
import { getLogger } from '../config/logger';
import {
  claimAuditorPayoutForBurn,
  findAuditorPayoutById,
  findAuditorPayoutByPayosTransferId,
  markAuditorPayoutFailedIfTransferring,
  reopenAuditorPayoutForManualBurn,
  updateAuditorPayout,
  type AuditorPayout
} from '../models/auditorPayoutModel';
import { findUserById } from '../models/authModel';
import { releaseAuditorWalletLock } from '../models/auditorStakeGuardModel';
import { ApplicationError } from '../utils/applicationError';

const logger = getLogger();
const charityTokenAbi = [
  'function balanceOf(address) view returns (uint256)',
  'function isProcessedDisbursementCode(bytes32) view returns (bool)',
  'function burnForDisbursement(address,uint256,string) external'
];

function getCharityTokenWriteContract(): ethers.Contract {
  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const privateKey = String(process.env.BACKEND_MINTER_PRIVATE_KEY || '').trim();
  const tokenAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();
  if (!rpcUrl || !privateKey || !tokenAddress) {
    throw new Error('Thiếu cấu hình burn DCT cho chi trả Kiểm toán viên.');
  }
  return new ethers.Contract(tokenAddress, charityTokenAbi, new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl)));
}

/** Lấy contract DCT read-only để kiểm tra số dư payout mà không cần quyền minter. */
function getCharityTokenReadContract(): ethers.Contract {
  const rpcUrl = String(process.env.BLOCKCHAIN_RPC_URL || '').trim();
  const tokenAddress = String(process.env.CHARITY_TOKEN_CONTRACT_ADDRESS || '').trim();
  if (!rpcUrl || !tokenAddress) {
    throw new Error('Thiếu cấu hình đọc DCT cho chi trả Kiểm toán viên.');
  }
  return new ethers.Contract(tokenAddress, charityTokenAbi, new ethers.JsonRpcProvider(rpcUrl));
}

function getPayoutRequestCode(payout: AuditorPayout): string {
  return `${payout.payoutType === 'REWARD' ? 'AUDITOR_REWARD' : 'AUDITOR_UNSTAKE'}:${payout.payoutId}`;
}

/** Kiểm tra DCT còn nguyên trong ví Auditor ngay trước khi gọi PayOS để không chuyển tiền mặt không có bảo chứng. */
export async function hasAuditorPayoutBalance(payout: AuditorPayout): Promise<boolean> {
  const user = await findUserById(payout.auditorUserId);
  if (!user?.walletAddress) throw new Error('Không tìm thấy ví của Kiểm toán viên để kiểm tra số dư DCT.');
  const contract = getCharityTokenReadContract();
  const balance = await contract.balanceOf(user.walletAddress) as bigint;
  return balance >= BigInt(payout.amountVnd);
}

/**
 * Đốt DCT chỉ sau khi PayOS báo thành công. Claim trạng thái trước khi gọi chain
 * giúp callback/worker trùng không thể gửi hai lệnh burn cho cùng payout.
 */
export async function finalizeAuditorPayoutAfterPayosSuccess(payoutId: string): Promise<void> {
  const existingPayout = await findAuditorPayoutById(payoutId);
  if (!existingPayout || existingPayout.status === 'BURNED' || existingPayout.status === 'MANUAL_REVIEW') return;
  const claimedPayout = existingPayout.status === 'TRANSFERRED'
    ? existingPayout
    : await claimAuditorPayoutForBurn(payoutId);
  if (!claimedPayout) return;

  try {
    const user = await findUserById(claimedPayout.auditorUserId);
    if (!user?.walletAddress) throw new Error('Không tìm thấy ví của Kiểm toán viên để burn DCT.');

    const contract = getCharityTokenWriteContract();
    const amount = BigInt(claimedPayout.amountVnd);
    const requestCode = getPayoutRequestCode(claimedPayout);
    const balance = await contract.balanceOf(user.walletAddress) as bigint;
    if (balance < amount) {
      throw new Error('Số dư DCT không đủ để burn sau khi PayOS đã chuyển tiền.');
    }

    const burnTransaction = await contract.burnForDisbursement(user.walletAddress, amount, requestCode);
    const receipt = await burnTransaction.wait(2);
    if (!receipt?.hash || receipt.status !== 1) throw new Error('Burn DCT bị revert sau khi PayOS đã chuyển tiền.');
    await updateAuditorPayout(payoutId, { status: 'BURNED', burnTxHash: receipt.hash, errorMessage: null });
    await releaseAuditorWalletLock(claimedPayout.auditorUserId, payoutId);
  } catch (error) {
    try {
      const payout = await findAuditorPayoutById(payoutId);
      if (payout) {
        const contract = getCharityTokenWriteContract();
        const codeHash = ethers.keccak256(ethers.toUtf8Bytes(getPayoutRequestCode(payout)));
        if (await contract.isProcessedDisbursementCode(codeHash)) {
          await updateAuditorPayout(payoutId, { status: 'BURNED', errorMessage: null });
          await releaseAuditorWalletLock(payout.auditorUserId, payoutId);
          return;
        }
      }
    } catch {
      // Giữ lỗi gốc và chuyển manual review phía dưới.
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    await updateAuditorPayout(payoutId, { status: 'MANUAL_REVIEW', errorMessage });
    logger.error('Burn DCT cho payout Kiểm toán viên thất bại sau PayOS SUCCESS.', { payoutId, errorMessage });
  }
}

/** Thử burn lại sau khi admin đã đối chiếu PayOS SUCCESS bằng đúng transfer ID được lưu trong snapshot. */
export async function retryAuditorPayoutBurnAfterManualReview(
  payoutId: string,
  payosTransferId: string
): Promise<void> {
  const reopenedPayout = await reopenAuditorPayoutForManualBurn(payoutId, payosTransferId);
  if (!reopenedPayout) {
    throw new ApplicationError(
      'Payout không ở trạng thái có thể retry burn hoặc PayOS transfer không khớp.',
      409,
      'CONFLICT'
    );
  }
  await finalizeAuditorPayoutAfterPayosSuccess(reopenedPayout.payoutId);
}

/** Xử lý callback PayOS của lane Kiểm toán viên; trả false để webhook cũ xử lý giải ngân. */
export async function processAuditorPayoutPayosResult(
  payosTransferId: string | null,
  status: string
): Promise<boolean> {
  if (!payosTransferId) return false;
  const payout = await findAuditorPayoutByPayosTransferId(payosTransferId);
  if (!payout) return false;
  const normalizedStatus = status.trim().toUpperCase();
  if (normalizedStatus === 'SUCCESS' || normalizedStatus === 'COMPLETED') {
    await finalizeAuditorPayoutAfterPayosSuccess(payout.payoutId);
  } else if (normalizedStatus === 'FAILED' || normalizedStatus === 'CANCELLED') {
    await markAuditorPayoutFailedIfTransferring(payout.payoutId, 'PayOS từ chối giao dịch chi trả.');
  }
  return true;
}
