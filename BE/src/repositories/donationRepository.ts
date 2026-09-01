import {
  aggregateDonationSummaryByProjectId,
  aggregateDonationSummariesByProjectIds,
  countDonations,
  findDonationsByProjectId,
  findDonationsByProjectIdPaginated,
  findDonationsPaginated,
  findLatestDonationTimestampByProjectId,
  findLatestIndexedBlockNumber,
  upsertDonationByTransactionHash,
  DonationRecord
} from '../models/donationModel';
import { findUsersByWalletAddressList } from '../models/authModel';
import { findPublicSupportProjectByProjectId, findPublicSupportProjects, ProjectRecord } from '../models/projectModel';

export type DonorPublicListItem = { fullName: string; gmail: string; donatedAmount: number; donatedAt: Date; transactionHash: string };
export type DonorPublicPaginationResult = {
  items: DonorPublicListItem[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
};

/** Hàm lấy danh sách dự án public cần hỗ trợ. Mục đích: cung cấp dữ liệu nền cho màn hình campaign quyên góp công khai. */
export async function findPublicCampaigns(limitCount: number): Promise<ProjectRecord[]> { return findPublicSupportProjects(limitCount); }
/** Hàm lấy chi tiết dự án public theo projectId. Mục đích: phục vụ màn hình chi tiết campaign trước khi người dùng donate. */
export async function findPublicCampaignByProjectId(projectId: string): Promise<ProjectRecord | null> { return findPublicSupportProjectByProjectId(projectId); }
/** Hàm lấy lịch sử donation theo projectId. Mục đích: hiển thị bảng giao dịch quyên góp minh bạch trên UI. */
export async function findDonationHistoryByProjectId(projectId: string, limitCount: number): Promise<DonationRecord[]> { return findDonationsByProjectId(projectId, limitCount); }
/** Hàm lấy tổng hợp donation theo projectId. Mục đích: trả tổng số tiền và số lượt donate cho card thống kê chiến dịch. */
export async function findDonationSummaryByProjectId(projectId: string): Promise<{ totalAmount: number; donationCount: number }> { return aggregateDonationSummaryByProjectId(projectId); }
/** Tổng hợp donation đã INDEXED của nhiều project để portal quản trị không gọi từng hồ sơ. */
export async function findDonationSummariesByProjectIds(projectIds: string[]): Promise<Map<string, { totalAmount: number; donationCount: number }>> { return aggregateDonationSummariesByProjectIds(projectIds); }
/** Hàm lấy thời gian donation gần nhất theo projectId. Mục đích: trả lastDonationAt thay vì updatedAt của project record cho modal chi tiết. */
export async function findLatestDonationTimestampByProjectIdFromRepository(projectId: string): Promise<Date | null> { return findLatestDonationTimestampByProjectId(projectId); }

/** Hàm lấy danh sách nhà hảo tâm công khai có phân trang. Mục đích: trả dữ liệu theo page/limit và metadata cho frontend. */
export async function findPublicDonorListPaginated(pageNumber: number, limitCount: number, projectId?: string): Promise<DonorPublicPaginationResult> {
  const normalizedProjectId = String(projectId || '').trim();
  const skipCount = (pageNumber - 1) * limitCount;

  // Ghi chú logic phức tạp: giữ cùng một filter projectId cho cả count và query page để đảm bảo totalPages đồng nhất với dữ liệu bảng.
  const [totalItems, donationList] = await Promise.all([
    countDonations(normalizedProjectId),
    normalizedProjectId
      ? findDonationsByProjectIdPaginated(normalizedProjectId, limitCount, skipCount)
      : findDonationsPaginated(limitCount, skipCount)
  ]);

  const totalPages = totalItems > 0 ? Math.ceil(totalItems / limitCount) : 1;

  if (!donationList.length) {
    return { items: [], totalItems, totalPages, currentPage: pageNumber, pageSize: limitCount };
  }

  const walletAddressList = Array.from(new Set(donationList.map(donationItem => donationItem.donorAddress.toLowerCase())));
  const userList = await findUsersByWalletAddressList(walletAddressList);
  const userByWalletAddressMap = new Map(userList.map(userItem => [String(userItem.walletAddress || '').toLowerCase(), userItem]));

  const items = donationList.map(donationItem => {
    const mappedUser = userByWalletAddressMap.get(donationItem.donorAddress.toLowerCase());
    return {
      fullName: mappedUser?.fullName || 'Ẩn danh',
      gmail: mappedUser?.email || 'Không công khai',
      donatedAmount: donationItem.amount,
      donatedAt: donationItem.timestamp,
      transactionHash: donationItem.transactionHash
    };
  });

  return { items, totalItems, totalPages, currentPage: pageNumber, pageSize: limitCount };
}

/** Hàm upsert bản ghi donation theo transactionHash. Mục đích: đảm bảo index on-chain idempotent không ghi trùng event. */
export async function upsertDonationRecordByTransactionHash(payload: DonationRecord): Promise<DonationRecord> { return upsertDonationByTransactionHash(payload); }
/** Hàm lấy block mới nhất đã index. Mục đích: hỗ trợ sync event theo cơ chế incremental. */
export async function getLatestIndexedBlockNumberFromRepository(): Promise<number> { return findLatestIndexedBlockNumber(); }
/** Hàm đếm tổng số donation (anonymous + registered) trong một khoảng thời gian. Mục đích: tính % guest donations phục vụ anti-farming check. */
export async function countTotalDonationsSince(sinceDate: Date): Promise<number> {
  const { countDonationsSince } = await import('../models/donationModel');
  return countDonationsSince(sinceDate);
}

/**
 * Tim kiem donation theo projectId voi date filter va wallet filter
 * @param projectId ID cua project
 * @param options Cac tuy chon loc: startDate, endDate, walletAddress, limit
 * @returns Mang cac donation phu hop voi dieu kien loc
 */
export async function findDonationsByProjectIdWithDateFilter(
  projectId: string,
  options?: {
    startDate?: Date;
    endDate?: Date;
    walletAddress?: string;
    limit?: number;
  }
): Promise<Array<{
  _id: string;
  amount: number;
  timestamp: Date;
  walletAddress: string;
  txHash: string;
  projectId: string;
}>> {
  const { startDate, endDate, walletAddress, limit = 50 } = options || {};

  // Su dung mongoose model truc tiep
  const mongoose = await import('mongoose');
  const DonationModel = mongoose.model<DonationRecord>('Donation');

  const query: Record<string, unknown> = { projectId };

  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) (query.timestamp as Record<string, Date>).$gte = startDate;
    if (endDate) (query.timestamp as Record<string, Date>).$lte = endDate;
  }

  if (walletAddress) {
    query.donorAddress = walletAddress;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = await (DonationModel.find(query) as any)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean()
    .exec();

  return results.map((doc: Record<string, unknown>) => ({
    _id: String(doc._id),
    amount: Number(doc.amount),
    timestamp: new Date(doc.timestamp as Date),
    walletAddress: String(doc.donorAddress),
    txHash: String(doc.transactionHash),
    projectId: String(doc.projectId)
  }));
}

