import { AuthUser, findUsersByWalletAddressList } from '../models/authModel';
import { DonationRecord, findDonationsInTimeRange } from '../models/donationModel';
import { ProjectRecord, findAllProjectsByProjectIdList } from '../models/projectModel';
import {
  createRankingSnapshot,
  findLatestRankingSnapshot,
  RankingSnapshotRecord
} from '../models/rankingModel';

export type DonationWithUser = {
  donationRecord: DonationRecord;
  mappedUser: AuthUser | null;
};

/** Hàm lấy donation trong cửa sổ thời gian và map user theo ví. Mục đích: chuẩn bị dữ liệu đầu vào cho thuật toán QF. */
export async function findDonationsWithMappedUserInTimeRange(startedAt: Date, endedAt: Date): Promise<DonationWithUser[]> {
  const donationList = await findDonationsInTimeRange(startedAt, endedAt);

  if (!donationList.length) {
    return [];
  }

  const walletAddressList = Array.from(new Set(donationList.map(donationItem => donationItem.donorAddress.toLowerCase())));
  const mappedUserList = await findUsersByWalletAddressList(walletAddressList);
  const userByWalletAddressMap = new Map(
    mappedUserList.map(userItem => [String(userItem.walletAddress || '').toLowerCase(), userItem])
  );

  return donationList.map(donationRecord => ({
    donationRecord,
    mappedUser: userByWalletAddressMap.get(donationRecord.donorAddress.toLowerCase()) || null
  }));
}

/** Hàm lấy tất cả dự án (bất kể trạng thái) theo danh sách id. Mục đích: phục vụ bảng xếp hạng QF — không giới hạn status/deadline. */
export async function findAllProjectsByIds(projectIdList: string[]): Promise<ProjectRecord[]> {
  return findAllProjectsByProjectIdList(projectIdList);
}

/** Hàm lưu snapshot ranking đã tính. Mục đích: tách layer service với thao tác lưu trữ MongoDB. */
export async function saveRankingSnapshot(snapshot: RankingSnapshotRecord): Promise<RankingSnapshotRecord> {
  return createRankingSnapshot(snapshot);
}

/** Hàm lấy snapshot ranking mới nhất. Mục đích: phục vụ endpoint đọc bảng xếp hạng hiện tại. */
export async function findCurrentRankingSnapshot(): Promise<RankingSnapshotRecord | null> {
  return findLatestRankingSnapshot();
}
