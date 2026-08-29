import { getLogger } from '../config/logger';
import { getReadOnlyAuditorStakingContract, getWritableAuditorStakingContract } from '../config/auditorStakingContract';
import { findUserById } from '../models/authModel';
import {
  completeAuditorLedgerEntry,
  findClaimableAuditorRewardLedgerEntries
} from '../models/auditorPenaltyLedgerModel';

const logger = getLogger();
const REWARD_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;
const REWARD_SWEEP_LIMIT = 20;
let rewardTimer: ReturnType<typeof setInterval> | null = null;
let isRewardSweepRunning = false;

/** Chuẩn hóa thông điệp lỗi contract để phân nhánh vận hành mà không log payload RPC thô. */
function getContractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Đọc tên custom error đã được ABI giải mã, không phụ thuộc chuỗi message khác nhau giữa RPC provider. */
function getContractErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('revert' in error)) return undefined;
  const revert = error.revert;
  if (!revert || typeof revert !== 'object' || !('name' in revert)) return undefined;
  return typeof revert.name === 'string' ? revert.name : undefined;
}

/** Tìm Rewarded event cũ khớp tuyệt đối để phục hồi ledger nếu process chết sau khi giao dịch đã được xác nhận. */
async function recoverProcessedRewardLedgerEntry(entry: { auditorUserId: string; fieldReportId: string; amount: string; reasonCode: string }, walletAddress: string): Promise<string | null> {
  const contract = getReadOnlyAuditorStakingContract();
  const events = await contract.queryFilter(contract.filters.Rewarded(walletAddress));
  const matchingEvent = events.find((event: { args?: readonly unknown[]; transactionHash?: string }) => {
    const args = event.args;
    if (!args || args.length < 3) return false;
    return String(args[0]).toLowerCase() === walletAddress.toLowerCase()
      && BigInt(String(args[1])) === BigInt(entry.amount)
      && args[2] === entry.reasonCode
      && Boolean(event.transactionHash);
  });
  return matchingEvent?.transactionHash ?? null;
}

/** Cộng các khoản thưởng đã đến hạn vào ví Auditor, giữ PENDING khi blockchain không xác nhận thành công. */
export async function sweepClaimableAuditorRewards(): Promise<void> {
  if (isRewardSweepRunning) return;
  isRewardSweepRunning = true;
  try {
    const entries = await findClaimableAuditorRewardLedgerEntries(new Date(), REWARD_SWEEP_LIMIT);
    // Dùng cùng một oracle signer nên gửi tuần tự để nonce và số dư rewardPool luôn được xác nhận theo thứ tự.
    for (const entry of entries) {
      try {
        const user = await findUserById(entry.auditorUserId);
        if (!user?.walletAddress) {
          logger.error('Không thể cộng thưởng vì Auditor không có địa chỉ ví.', {
            auditorUserId: entry.auditorUserId,
            ledgerId: entry.ledgerId
          });
          continue;
        }
        const transaction = await getWritableAuditorStakingContract().payReward(
          user.walletAddress,
          BigInt(entry.amount),
          entry.reasonCode
        );
        const receipt = await transaction.wait(2);
        if (!receipt?.hash || receipt.status !== 1) {
          logger.error('Giao dịch cộng thưởng Auditor không được xác nhận thành công.', {
            auditorUserId: entry.auditorUserId,
            ledgerId: entry.ledgerId
          });
          continue;
        }
        await completeAuditorLedgerEntry(entry.fieldReportId, 'REWARD', entry.auditorUserId, receipt.hash);
        logger.info('Đã cộng thưởng Auditor on-chain và hoàn tất ledger.', {
          auditorUserId: entry.auditorUserId,
          ledgerId: entry.ledgerId,
          amountVnd: Number(entry.amount),
          reasonCode: entry.reasonCode,
          txHash: receipt.hash
        });
      } catch (error) {
        const errorMessage = getContractErrorMessage(error);
        const errorName = getContractErrorName(error);
        if (errorName === 'InsufficientRewardPool') {
          let rewardPool: string | undefined;
          try {
            rewardPool = (await getReadOnlyAuditorStakingContract().rewardPool()).toString();
          } catch {
            rewardPool = undefined;
          }
          logger.warn('Quỹ thưởng Auditor không đủ; giữ ledger PENDING để thử lại.', {
            auditorUserId: entry.auditorUserId,
            ledgerId: entry.ledgerId,
            requiredAmount: entry.amount,
            rewardPool
          });
          continue;
        }
        if (errorName === 'AlreadyProcessedReasonCode') {
          let recoveredTxHash: string | null = null;
          try {
            const user = await findUserById(entry.auditorUserId);
            recoveredTxHash = user?.walletAddress
              ? await recoverProcessedRewardLedgerEntry(entry, user.walletAddress)
              : null;
          } catch (recoveryError) {
            logger.error('Không thể đối soát Rewarded event để phục hồi ledger thưởng.', {
              auditorUserId: entry.auditorUserId,
              ledgerId: entry.ledgerId,
              reasonCode: entry.reasonCode,
              errorMessage: getContractErrorMessage(recoveryError)
            });
          }
          if (recoveredTxHash) {
            await completeAuditorLedgerEntry(entry.fieldReportId, 'REWARD', entry.auditorUserId, recoveredTxHash);
            logger.info('Đã phục hồi ledger thưởng từ Rewarded event on-chain.', {
              auditorUserId: entry.auditorUserId,
              ledgerId: entry.ledgerId,
              reasonCode: entry.reasonCode,
              txHash: recoveredTxHash
            });
            continue;
          }
          logger.error('Reason code thưởng đã được xử lý on-chain nhưng không tìm thấy Rewarded event khớp để phục hồi ledger.', {
            auditorUserId: entry.auditorUserId,
            ledgerId: entry.ledgerId,
            reasonCode: entry.reasonCode
          });
          continue;
        }
        logger.error('Không thể cộng thưởng Auditor; giữ ledger PENDING để thử lại.', {
          auditorUserId: entry.auditorUserId,
          ledgerId: entry.ledgerId,
          errorMessage
        });
      }
    }
  } finally {
    isRewardSweepRunning = false;
  }
}

/** Khởi động worker thưởng với lần quét ngay để không chờ thêm một chu kỳ sau lúc server bật. */
export function startAuditorRewardPayoutWorker(): void {
  if (rewardTimer) return;
  void sweepClaimableAuditorRewards();
  rewardTimer = setInterval(() => { void sweepClaimableAuditorRewards(); }, REWARD_SWEEP_INTERVAL_MS);
}

/** Dừng lịch quét thưởng khi server shutdown. */
export function stopAuditorRewardPayoutWorker(): void {
  if (rewardTimer) clearInterval(rewardTimer);
  rewardTimer = null;
  isRewardSweepRunning = false;
}

/** Hook chỉ dành cho test đơn vị worker thưởng. */
export const __auditorRewardPayoutWorkerTestHooks = { sweepClaimableAuditorRewards };
