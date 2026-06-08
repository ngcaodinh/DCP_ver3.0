import { findUserById, findUsersByWalletAddressList, type AuthUser } from '../models/authModel';
import { findLatestDisbursements, type DisbursementRecord } from '../models/disbursementModel';
import { findDonations, type DonationRecord } from '../models/donationModel';
import { findAllProjectsByProjectIdList, type ProjectRecord } from '../models/projectModel';

export type LiveFeedTransactionType = 'donation' | 'disbursement';

export type LiveFeedTransactionItem = {
  id: string;
  type: LiveFeedTransactionType;
  displayName: string;
  transactionHash: string;
  projectId: string;
  projectName: string;
  organizationName: string | null;
  amount: number;
  currencySymbol: string;
  occurredAt: string;
  explorerUrl: string | null;
  displayDirection: 'inflow' | 'outflow';
};

type LiveFeedTransactionItemWithSortValue = LiveFeedTransactionItem & {
  occurredAtTimestamp: number;
};

/** Hàm chuẩn hóa giới hạn bản ghi feed. Mục đích: chặn giá trị quá lớn gây tải không cần thiết cho homepage public. */
function normalizeLimitCount(limitCount: number, defaultLimitCount = 6, maxLimitCount = 20): number {
  if (!Number.isFinite(limitCount)) {
    return defaultLimitCount;
  }

  return Math.max(1, Math.min(maxLimitCount, Math.floor(limitCount)));
}

/** Hàm build URL block explorer. Mục đích: cho phép frontend mở trực tiếp transaction thật từ live feed. */
function buildExplorerUrl(transactionHash: string): string | null {
  const normalizedExplorerBaseUrl = String(process.env.BLOCKCHAIN_EXPLORER_BASE_URL || '').trim();
  if (!normalizedExplorerBaseUrl || !transactionHash) {
    return null;
  }

  const sanitizedExplorerBaseUrl = normalizedExplorerBaseUrl.endsWith('/')
    ? normalizedExplorerBaseUrl.slice(0, -1)
    : normalizedExplorerBaseUrl;

  return `${sanitizedExplorerBaseUrl}/tx/${transactionHash}`;
}

/** Hàm map danh sách project sang Map. Mục đích: tra cứu tên dự án nhanh khi hợp nhất nhiều nguồn giao dịch. */
function createProjectMap(projectList: ProjectRecord[]): Map<string, ProjectRecord> {
  return new Map(projectList.map(projectItem => [projectItem.projectId, projectItem]));
}

/** Hàm map tên tổ chức theo organizationId. Mục đích: hiển thị tên thân thiện thay cho id kỹ thuật trên homepage. */
async function createOrganizationNameMap(organizationIdList: string[]): Promise<Map<string, string>> {
  const uniqueOrganizationIdList = Array.from(new Set(organizationIdList.filter(Boolean)));
  const organizationNameEntryList = await Promise.all(
    uniqueOrganizationIdList.map(async organizationId => {
      const organizationUser = await findUserById(organizationId);
      const organizationName = organizationUser?.organizationName || organizationUser?.fullName || organizationId;
      return [organizationId, organizationName] as const;
    })
  );

  return new Map(organizationNameEntryList);
}

/** Hàm chuẩn hóa donation record thành item live feed. Mục đích: đồng nhất dữ liệu thật từ Mongo để frontend render trực tiếp. */
function mapDonationRecordToLiveFeedItem(
  donationRecord: DonationRecord,
  projectByProjectIdMap: Map<string, ProjectRecord>,
  organizationNameByIdMap: Map<string, string>,
  userByWalletAddressMap: Map<string, AuthUser>
): LiveFeedTransactionItemWithSortValue {
  const projectRecord = projectByProjectIdMap.get(donationRecord.projectId);
  const occurredAtDate = new Date(donationRecord.timestamp);
  const occurredAtTimestamp = occurredAtDate.getTime();
  const donorUser = userByWalletAddressMap.get(String(donationRecord.donorAddress || '').toLowerCase());

  return {
    id: `donation-${donationRecord.transactionHash}`,
    type: 'donation',
    displayName: donorUser?.fullName || 'Nhà hảo tâm ẩn danh',
    transactionHash: donationRecord.transactionHash,
    projectId: donationRecord.projectId,
    projectName: projectRecord?.name || donationRecord.projectId,
    organizationName: projectRecord?.organizationId ? (organizationNameByIdMap.get(projectRecord.organizationId) || null) : null,
    amount: donationRecord.amount,
    currencySymbol: '₫',
    occurredAt: occurredAtDate.toISOString(),
    explorerUrl: buildExplorerUrl(donationRecord.transactionHash),
    displayDirection: 'inflow',
    occurredAtTimestamp: Number.isFinite(occurredAtTimestamp) ? occurredAtTimestamp : 0
  };
}

/** Hàm kiểm tra disbursement có đủ điều kiện public trong live feed. Mục đích: chỉ hiển thị giao dịch giải ngân đã có dấu vết thật. */
function isEligibleDisbursementForLiveFeed(disbursementRecord: DisbursementRecord): boolean {
  return Boolean(
    disbursementRecord.transactionHash
    || disbursementRecord.finalizeTransactionHash
    || disbursementRecord.status === 'COMPLETED'
    || disbursementRecord.status === 'EXECUTING'
  );
}

/** Hàm chuẩn hóa disbursement record thành item live feed. Mục đích: hợp nhất cùng donation trong một timeline minh bạch. */
function mapDisbursementRecordToLiveFeedItem(
  disbursementRecord: DisbursementRecord,
  projectByProjectIdMap: Map<string, ProjectRecord>,
  organizationNameByIdMap: Map<string, string>
): LiveFeedTransactionItemWithSortValue {
  const projectRecord = projectByProjectIdMap.get(disbursementRecord.projectId);
  const occurredAtDate = new Date(
    disbursementRecord.updatedAt
    || disbursementRecord.createdAt
  );
  const occurredAtTimestamp = occurredAtDate.getTime();
  const transactionHash = disbursementRecord.finalizeTransactionHash || disbursementRecord.transactionHash || '';

  return {
    id: `disbursement-${disbursementRecord.requestId}-${transactionHash || occurredAtTimestamp}`,
    type: 'disbursement',
    displayName: organizationNameByIdMap.get(disbursementRecord.organizationId) || 'Đơn vị giải ngân',
    transactionHash,
    projectId: disbursementRecord.projectId,
    projectName: projectRecord?.name || disbursementRecord.projectId,
    organizationName: organizationNameByIdMap.get(disbursementRecord.organizationId) || null,
    amount: disbursementRecord.amount,
    currencySymbol: '₫',
    occurredAt: occurredAtDate.toISOString(),
    explorerUrl: transactionHash ? buildExplorerUrl(transactionHash) : null,
    displayDirection: 'outflow',
    occurredAtTimestamp: Number.isFinite(occurredAtTimestamp) ? occurredAtTimestamp : 0
  };
}

/** Hàm lấy snapshot live feed thật. Mục đích: cung cấp nguồn dữ liệu public cho section minh bạch trên homepage. */
export async function getPublicLiveFeedTransactionList(limitCount: number): Promise<LiveFeedTransactionItem[]> {
  const normalizedLimitCount = normalizeLimitCount(limitCount);

  const [donationRecordList, disbursementRecordList] = await Promise.all([
    findDonations(Math.max(normalizedLimitCount * 3, 18)),
    findLatestDisbursements(Math.max(normalizedLimitCount * 3, 18))
  ]);

  const eligibleDisbursementRecordList = disbursementRecordList.filter(isEligibleDisbursementForLiveFeed);
  const donorWalletAddressList = Array.from(
    new Set(donationRecordList.map(donationRecord => String(donationRecord.donorAddress || '').toLowerCase()).filter(Boolean))
  );
  const projectIdList = Array.from(
    new Set([
      ...donationRecordList.map(donationRecord => donationRecord.projectId),
      ...eligibleDisbursementRecordList.map(disbursementRecord => disbursementRecord.projectId)
    ])
  );
  const projectList = await findAllProjectsByProjectIdList(projectIdList);
  const projectByProjectIdMap = createProjectMap(projectList);
  const donorUserList = await findUsersByWalletAddressList(donorWalletAddressList);
  const userByWalletAddressMap = new Map(donorUserList.map(userItem => [String(userItem.walletAddress || '').toLowerCase(), userItem]));
  const organizationNameByIdMap = await createOrganizationNameMap([
    ...projectList.map(projectItem => projectItem.organizationId),
    ...eligibleDisbursementRecordList.map(disbursementRecord => disbursementRecord.organizationId)
  ]);

  const liveFeedTransactionItemList = [
    ...donationRecordList.map(donationRecord => mapDonationRecordToLiveFeedItem(donationRecord, projectByProjectIdMap, organizationNameByIdMap, userByWalletAddressMap)),
    ...eligibleDisbursementRecordList.map(disbursementRecord => mapDisbursementRecordToLiveFeedItem(disbursementRecord, projectByProjectIdMap, organizationNameByIdMap))
  ];

  return liveFeedTransactionItemList
    .sort((leftItem, rightItem) => rightItem.occurredAtTimestamp - leftItem.occurredAtTimestamp)
    .slice(0, normalizedLimitCount)
    .map(({ occurredAtTimestamp, ...liveFeedTransactionItem }) => liveFeedTransactionItem);
}
