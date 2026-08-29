import crypto from 'node:crypto';
import {
  claimAuditorLedgerEntry,
  findAuditorLedgerEntryByFieldReportAndType,
  sumCompletedAuditorRewardLedgerEntries,
  type AuditorPenaltyLedgerEntry
} from '../models/auditorPenaltyLedgerModel';
import { sumReservedAuditorRewardPayoutsByUserId } from '../models/auditorPayoutModel';
import { getLogger } from '../config/logger';
import { ApplicationError } from '../utils/applicationError';
import { buildAuditorRewardReasonCode } from '../utils/auditorStakingReasonCode';

const AUDITOR_REWARD_WAIT_MS = 7 * 24 * 60 * 60 * 1_000;
const logger = getLogger();

/** Ghi nhận thưởng Auditor idempotent theo biên bản và người thắng, với thời gian chờ bắt buộc bảy ngày. */
export async function scheduleAuditorReward(input: {
  auditorUserId: string;
  fieldReportId: string;
  fieldCaseId: string;
  milestoneIndex: number;
  amountVnd: number;
}): Promise<AuditorPenaltyLedgerEntry> {
  if (!Number.isSafeInteger(input.amountVnd) || input.amountVnd <= 0) {
    throw new ApplicationError('Số tiền thưởng Auditor không hợp lệ.', 400, 'AMOUNT_INVALID');
  }
  if (!Number.isSafeInteger(input.milestoneIndex) || input.milestoneIndex < 0) {
    throw new ApplicationError('Mốc giải ngân không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  const now = new Date();
  const entry: AuditorPenaltyLedgerEntry = {
    ledgerId: crypto.randomUUID(),
    auditorUserId: input.auditorUserId,
    fieldReportId: input.fieldReportId,
    fieldCaseId: input.fieldCaseId,
    milestoneIndex: input.milestoneIndex,
    entryType: 'REWARD',
    amount: String(input.amountVnd),
    txHash: null,
    reasonCode: buildAuditorRewardReasonCode(input.fieldReportId, input.auditorUserId),
    status: 'PENDING',
    payableAt: new Date(now.getTime() + AUDITOR_REWARD_WAIT_MS),
    createdAt: now
  };
  if (await claimAuditorLedgerEntry(entry)) {
    logger.info('Đã ghi nhận thưởng Auditor chờ chi trả.', {
      auditorUserId: entry.auditorUserId,
      ledgerId: entry.ledgerId,
      fieldReportId: entry.fieldReportId,
      amountVnd: input.amountVnd,
      payableAt: entry.payableAt?.toISOString(),
      reasonCode: entry.reasonCode
    });
    return entry;
  }

  const existing = await findAuditorLedgerEntryByFieldReportAndType(input.fieldReportId, 'REWARD', input.auditorUserId);
  if (!existing) throw new Error('Không thể đọc khoản thưởng Auditor đã được ghi nhận trước đó.');
  if (
    existing.auditorUserId !== entry.auditorUserId
    || existing.fieldCaseId !== entry.fieldCaseId
    || existing.milestoneIndex !== entry.milestoneIndex
    || existing.amount !== entry.amount
    || existing.reasonCode !== entry.reasonCode
  ) {
    throw new ApplicationError('Quyết định thưởng Auditor trùng khóa nhưng không khớp dữ liệu đã ghi nhận.', 409, 'CONFLICT');
  }
  return existing;
}

/** Tính phần thưởng có thể rút, tái dùng ledger đã đọc ở portal hoặc aggregate ở Mongo cho đường tạo payout. */
export async function getAuditorClaimableRewardVnd(
  auditorUserId: string,
  entries?: AuditorPenaltyLedgerEntry[]
): Promise<number> {
  const creditedRewardVnd = entries
    ? entries
      .filter(entry => entry.entryType === 'REWARD' && entry.status === 'COMPLETED')
      .reduce((total, entry) => total + Number(entry.amount), 0)
    : await sumCompletedAuditorRewardLedgerEntries(auditorUserId);
  const reservedRewardVnd = await sumReservedAuditorRewardPayoutsByUserId(auditorUserId);
  return Math.max(0, creditedRewardVnd - reservedRewardVnd);
}
