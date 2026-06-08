import {
  type AuditLogEntry,
  type AuthUser,
  countUsersByLastLoginRange,
  findLatestAuditLogs,
  findSybilAuditLogs,
  findUserById,
  type SybilAuditLogEntry
} from '../models/authModel';
import {
  findLatestFailedDepositTransactions,
  type DepositTransaction
} from '../models/depositModel';
import { findLatestDisbursements, type DisbursementRecord } from '../models/disbursementModel';
import { aggregateTotalDonationAmount } from '../models/donationModel';
import { countPendingKycSubmissions } from '../models/organizationKycModel';
import { countProjectsByStatus } from '../models/projectModel';
import {
  findSystemErrorReadStatesByAdminUserIdAndLogIdList,
  upsertSystemErrorReadState
} from '../models/systemErrorLogReadModel';
import { findProjectById } from '../repositories/projectRepository';
import {
  getGuestSessionSummary as getGuestSessionSummaryRepo,
  listGuestSessionsPaginated,
  invalidateGuestSession as invalidateGuestSessionRepo,
  type GuestSessionFilters,
  type GuestSessionSummary
} from '../repositories/guestWalletSessionRepository';
import { GuestWalletSession } from '../models/guestWalletSessionModel';
import { ApplicationError } from '../utils/applicationError';

export type AdminDashboardMetrics = {
  pendingProjects: number;
  pendingKycs: number;
  newUsersThisMonth: number;
  totalTransactionAmount: number;
};

export type AdminDashboardTimelineEvent = {
  id: string;
  type: 'sign' | 'view' | 'reject' | 'login';
  actionText: string;
  detailText: string;
  timestamp: string;
};

export type AdminDashboardAuditLog = {
  id: string;
  timestamp: string;
  action: string;
  module: string;
  actor: string;
  ipAddress: string;
  details: string;
};

export type SystemErrorLogCategory =
  | 'TRANSFER_TIMEOUT_15_MINUTES'
  | 'DEPOSIT'
  | 'DISBURSEMENT'
  | 'AUTH';

export type SystemErrorLogReadStateFilter = 'all' | 'read' | 'unread';

export type AdminSystemErrorActorInfo = {
  displayName: string;
  userId: string | null;
  email: string | null;
  role: string | null;
  walletAddress: string | null;
};

export type AdminSystemErrorLogDetailContext = {
  sourceOrigin: string;
  actor: AdminSystemErrorActorInfo;
  ipAddress: string | null;
  userAgent: string | null;
  businessTimestamp: string | null;
  systemTimestamp: string;
  createdAt: string | null;
  updatedAt: string | null;
  correlationId: string | null;
  eventType: string | null;
  projectId: string | null;
  projectName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  orderCode: string | null;
  requestId: string | null;
  payosTransactionId: string | null;
  payosTransferId: string | null;
  payosTransferStatus: string | null;
  transferAttemptCount: number | null;
  amountVnd: number | null;
  amountToken: number | null;
};

export type AdminSystemErrorLog = {
  id: string;
  timestamp: string;
  category: SystemErrorLogCategory;
  categoryLabel: string;
  sourceModule: 'DEPOSIT' | 'DISBURSEMENT' | 'AUTH';
  severityLevel: 'high' | 'medium' | 'low';
  title: string;
  details: string;
  referenceCode: string;
  isTransferTimeout15Minutes: boolean;
  detailContext: AdminSystemErrorLogDetailContext;
  isRead: boolean;
  readAt: string | null;
};

export type AdminSystemErrorLogCategorySummary = {
  category: SystemErrorLogCategory;
  categoryLabel: string;
  totalCount: number;
  unreadCount: number;
};

export type AdminSystemErrorLogListResult = {
  logs: AdminSystemErrorLog[];
  summary: {
    totalCount: number;
    unreadCount: number;
    transferTimeout15MinutesCount: number;
    categorySummaryList: AdminSystemErrorLogCategorySummary[];
  };
};

type TimelineEventWithSortValue = AdminDashboardTimelineEvent & {
  timestampValue: number;
};

type AuditLogWithSortValue = AdminDashboardAuditLog & {
  timestampValue: number;
};

type SystemErrorLogWithSortValue = Omit<AdminSystemErrorLog, 'isRead' | 'readAt'> & {
  timestampValue: number;
};

/**
 * Hàm chuẩn hóa dữ liệu ngày giờ về dạng Date hợp lệ.
 * Mục đích: tránh lỗi runtime khi dữ liệu lưu trữ bị thiếu hoặc sai định dạng.
 */
function parseSafeDate(dateValue: Date | string | null | undefined): Date | null {
  if (!dateValue) {
    return null;
  }

  const parsedDate = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate;
}

/**
 * Hàm format mốc thời gian cho timeline.
 * Mục đích: hiển thị thời gian ngắn gọn, dễ quét nhanh trên giao diện tổng quan.
 */
function formatTimelineTimestamp(dateValue: Date): string {
  const dayText = String(dateValue.getDate()).padStart(2, '0');
  const monthText = String(dateValue.getMonth() + 1).padStart(2, '0');
  const hourText = String(dateValue.getHours()).padStart(2, '0');
  const minuteText = String(dateValue.getMinutes()).padStart(2, '0');
  return `${hourText}:${minuteText} ${dayText}/${monthText}`;
}

/**
 * Hàm format mốc thời gian cho bảng audit log.
 * Mục đích: giữ thông tin đầy đủ đến giây để phục vụ kiểm toán.
 */
function formatAuditTimestamp(dateValue: Date): string {
  const dayText = String(dateValue.getDate()).padStart(2, '0');
  const monthText = String(dateValue.getMonth() + 1).padStart(2, '0');
  const yearText = String(dateValue.getFullYear());
  const hourText = String(dateValue.getHours()).padStart(2, '0');
  const minuteText = String(dateValue.getMinutes()).padStart(2, '0');
  const secondText = String(dateValue.getSeconds()).padStart(2, '0');
  return `${dayText}/${monthText}/${yearText} ${hourText}:${minuteText}:${secondText}`;
}

/**
 * Hàm chuyển mốc thời gian về chuỗi ISO chuẩn.
 * Mục đích: trả dữ liệu timestamp đầy đủ timezone để Admin truy vết chính xác theo hệ thống.
 */
function formatIsoTimestamp(dateValue: Date | string | null | undefined): string | null {
  const parsedDate = parseSafeDate(dateValue);
  if (!parsedDate) {
    return null;
  }

  return parsedDate.toISOString();
}

/**
 * Hàm chuyển signer role thành nhãn dễ đọc.
 * Mục đích: tránh lộ kỹ thuật nội bộ khi hiển thị actor trong timeline/audit.
 */
function mapSignerRoleToDisplayName(signerRole: string): string {
  if (signerRole === 'ADMIN_SIGNER') return 'Admin hệ thống';
  if (signerRole === 'ORG_SIGNER') return 'Đại diện tổ chức';
  if (signerRole === 'REGULATORY_SIGNER') return 'Cơ quan giám sát';
  return signerRole;
}

/**
 * Hàm chuẩn hóa action cho audit log auth.
 * Mục đích: hiển thị tên hành động dễ hiểu thay vì event code thô.
 */
function mapAuthEventTypeToAction(eventType: string): string {
  if (eventType === 'GOOGLE_LOGIN_FAILED') return 'Đăng nhập thất bại';
  if (eventType === 'NEW_DEVICE_LOGIN') return 'Đăng nhập thiết bị mới';
  if (eventType === 'REFRESH_DEVICE_MISMATCH') return 'Sai khác thiết bị phiên đăng nhập';
  if (eventType === 'REFRESH_TOKEN_FAILED') return 'Làm mới token thất bại';
  return eventType;
}

/**
 * Hàm lấy tên dự án theo projectId có cache.
 * Mục đích: giảm số lần query MongoDB khi duyệt nhiều bản ghi giải ngân.
 */
async function resolveProjectName(projectId: string, projectNameCache: Map<string, string>): Promise<string> {
  const cachedProjectName = projectNameCache.get(projectId);
  if (cachedProjectName) {
    return cachedProjectName;
  }

  const projectRecord = await findProjectById(projectId);
  const projectName = projectRecord?.name || projectId;
  projectNameCache.set(projectId, projectName);
  return projectName;
}

/**
 * Hàm lấy tên tổ chức theo organizationId có cache.
 * Mục đích: tránh query lặp khi nhiều request giải ngân thuộc cùng một tổ chức.
 */
async function resolveOrganizationName(organizationId: string, organizationNameCache: Map<string, string>): Promise<string> {
  const cachedOrganizationName = organizationNameCache.get(organizationId);
  if (cachedOrganizationName) {
    return cachedOrganizationName;
  }

  const organizationUser = await findUserById(organizationId);
  const organizationName = organizationUser?.organizationName || organizationUser?.fullName || organizationId;
  organizationNameCache.set(organizationId, organizationName);
  return organizationName;
}

/**
 * Hàm trích xuất event timeline từ danh sách request giải ngân.
 * Mục đích: tạo hoạt động gần đây bằng dữ liệu thật thay vì mock timeline.
 */
async function buildTimelineEventsFromDisbursement(disbursementRecordList: DisbursementRecord[]): Promise<TimelineEventWithSortValue[]> {
  const timelineEventList: TimelineEventWithSortValue[] = [];
  const projectNameCache = new Map<string, string>();
  const organizationNameCache = new Map<string, string>();

  for (const disbursementRecord of disbursementRecordList) {
    const [projectName, organizationName] = await Promise.all([
      resolveProjectName(disbursementRecord.projectId, projectNameCache),
      resolveOrganizationName(disbursementRecord.organizationId, organizationNameCache)
    ]);

    const createdAtDate = parseSafeDate(disbursementRecord.createdAt);
    if (createdAtDate) {
      timelineEventList.push({
        id: `${disbursementRecord.requestId}-created`,
        type: 'view',
        actionText: 'Tạo yêu cầu giải ngân',
        detailText: `${organizationName} · ${projectName}`,
        timestamp: formatTimelineTimestamp(createdAtDate),
        timestampValue: createdAtDate.getTime()
      });
    }

    for (const approvalItem of disbursementRecord.approvals) {
      const signedAtDate = parseSafeDate(approvalItem.signedAt);
      if (!signedAtDate) {
        continue;
      }

      timelineEventList.push({
        id: `${disbursementRecord.requestId}-sign-${approvalItem.signerRole}-${signedAtDate.getTime()}`,
        type: 'sign',
        actionText: 'Ký duyệt giải ngân',
        detailText: `${mapSignerRoleToDisplayName(approvalItem.signerRole)} · ${projectName}`,
        timestamp: formatTimelineTimestamp(signedAtDate),
        timestampValue: signedAtDate.getTime()
      });
    }

    const rejectedAtDate = parseSafeDate(disbursementRecord.rejection?.rejectedAt);
    if (rejectedAtDate && disbursementRecord.rejection) {
      timelineEventList.push({
        id: `${disbursementRecord.requestId}-reject-${rejectedAtDate.getTime()}`,
        type: 'reject',
        actionText: 'Từ chối giải ngân',
        detailText: `${mapSignerRoleToDisplayName(disbursementRecord.rejection.signerRole)} · ${projectName}`,
        timestamp: formatTimelineTimestamp(rejectedAtDate),
        timestampValue: rejectedAtDate.getTime()
      });
    }
  }

  return timelineEventList;
}

/**
 * Hàm trích xuất event timeline từ audit log đăng nhập.
 * Mục đích: bổ sung dấu vết hoạt động hệ thống gần đây vào khối timeline.
 */
function buildTimelineEventsFromAuthAudit(auditLogEntryList: AuditLogEntry[]): TimelineEventWithSortValue[] {
  const timelineEventList: TimelineEventWithSortValue[] = [];

  for (const auditLogEntry of auditLogEntryList) {
    const createdAtDate = parseSafeDate(auditLogEntry.createdAt);
    if (!createdAtDate) {
      continue;
    }

    const actorLabel = auditLogEntry.email || auditLogEntry.userId || 'Ẩn danh';
    timelineEventList.push({
      id: `audit-${auditLogEntry.id}`,
      type: 'login',
      actionText: mapAuthEventTypeToAction(auditLogEntry.eventType),
      detailText: `${actorLabel} · ${auditLogEntry.detail}`,
      timestamp: formatTimelineTimestamp(createdAtDate),
      timestampValue: createdAtDate.getTime()
    });
  }

  return timelineEventList;
}

/**
 * Hàm chuyển audit log auth về format bảng admin.
 * Mục đích: thống nhất dữ liệu kiểm toán giữa backend và frontend.
 */
function buildAuditLogsFromAuth(auditLogEntryList: AuditLogEntry[]): AuditLogWithSortValue[] {
  return auditLogEntryList
    .map((auditLogEntry) => {
      const createdAtDate = parseSafeDate(auditLogEntry.createdAt);
      if (!createdAtDate) {
        return null;
      }

      return {
        id: `auth-${auditLogEntry.id}`,
        timestamp: formatAuditTimestamp(createdAtDate),
        action: mapAuthEventTypeToAction(auditLogEntry.eventType),
        module: 'AUTH',
        actor: auditLogEntry.email || auditLogEntry.userId || 'Hệ thống',
        ipAddress: auditLogEntry.ipAddress || '-',
        details: auditLogEntry.detail,
        timestampValue: createdAtDate.getTime()
      };
    })
    .filter((auditLogItem): auditLogItem is AuditLogWithSortValue => Boolean(auditLogItem));
}

/**
 * Hàm chuyển audit log Sybil về format bảng admin.
 * Mục đích: hiển thị đầy đủ thao tác đánh dấu/huỷ đánh dấu Sybil trên khối kiểm toán.
 */
function buildAuditLogsFromSybil(sybilAuditLogEntryList: SybilAuditLogEntry[]): AuditLogWithSortValue[] {
  return sybilAuditLogEntryList
    .map((sybilAuditLogEntry) => {
      const createdAtDate = parseSafeDate(sybilAuditLogEntry.createdAt);
      if (!createdAtDate) {
        return null;
      }

      return {
        id: `sybil-${sybilAuditLogEntry.id}`,
        timestamp: formatAuditTimestamp(createdAtDate),
        action: sybilAuditLogEntry.action === 'mark_as_sybil' ? 'Đánh dấu Sybil' : 'Bỏ đánh dấu Sybil',
        module: 'SYBIL',
        actor: sybilAuditLogEntry.performedBy,
        ipAddress: sybilAuditLogEntry.ipAddress || '-',
        details: sybilAuditLogEntry.reason,
        timestampValue: createdAtDate.getTime()
      };
    })
    .filter((auditLogItem): auditLogItem is AuditLogWithSortValue => Boolean(auditLogItem));
}

/**
 * Hàm chuyển dữ liệu giải ngân thành audit log.
 * Mục đích: ghi nhận đầy đủ vòng đời request giải ngân để phục vụ kiểm toán vận hành.
 */
async function buildAuditLogsFromDisbursement(disbursementRecordList: DisbursementRecord[]): Promise<AuditLogWithSortValue[]> {
  const auditLogItemList: AuditLogWithSortValue[] = [];
  const projectNameCache = new Map<string, string>();
  const organizationNameCache = new Map<string, string>();

  for (const disbursementRecord of disbursementRecordList) {
    const [projectName, organizationName] = await Promise.all([
      resolveProjectName(disbursementRecord.projectId, projectNameCache),
      resolveOrganizationName(disbursementRecord.organizationId, organizationNameCache)
    ]);

    const createdAtDate = parseSafeDate(disbursementRecord.createdAt);
    if (createdAtDate) {
      auditLogItemList.push({
        id: `disbursement-${disbursementRecord.requestId}-created`,
        timestamp: formatAuditTimestamp(createdAtDate),
        action: 'Tạo yêu cầu giải ngân',
        module: 'DISBURSEMENT',
        actor: organizationName,
        ipAddress: '-',
        details: `Request ${disbursementRecord.requestId} · ${projectName}`,
        timestampValue: createdAtDate.getTime()
      });
    }

    for (const approvalItem of disbursementRecord.approvals) {
      const signedAtDate = parseSafeDate(approvalItem.signedAt);
      if (!signedAtDate) {
        continue;
      }

      auditLogItemList.push({
        id: `disbursement-${disbursementRecord.requestId}-sign-${approvalItem.signerRole}-${signedAtDate.getTime()}`,
        timestamp: formatAuditTimestamp(signedAtDate),
        action: 'Ký duyệt giải ngân',
        module: 'DISBURSEMENT',
        actor: mapSignerRoleToDisplayName(approvalItem.signerRole),
        ipAddress: '-',
        details: `Request ${disbursementRecord.requestId} · ${projectName}`,
        timestampValue: signedAtDate.getTime()
      });
    }

    const rejectedAtDate = parseSafeDate(disbursementRecord.rejection?.rejectedAt);
    if (rejectedAtDate && disbursementRecord.rejection) {
      auditLogItemList.push({
        id: `disbursement-${disbursementRecord.requestId}-reject-${rejectedAtDate.getTime()}`,
        timestamp: formatAuditTimestamp(rejectedAtDate),
        action: 'Từ chối giải ngân',
        module: 'DISBURSEMENT',
        actor: mapSignerRoleToDisplayName(disbursementRecord.rejection.signerRole),
        ipAddress: '-',
        details: disbursementRecord.rejection.reason,
        timestampValue: rejectedAtDate.getTime()
      });
    }
  }

  return auditLogItemList;
}

/**
 * Hàm lấy metrics tổng quan hệ thống cho admin dashboard.
 * Mục đích: trả dữ liệu thật từ MongoDB thay cho cấu hình mock phía frontend.
 */
export async function getAdminDashboardMetrics(): Promise<AdminDashboardMetrics> {
  const currentDate = new Date();
  const monthStartDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const nextMonthStartDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);

  const [pendingProjectCount, pendingKycCount, activeUserThisMonthCount, totalTransactionAmount] = await Promise.all([
    countProjectsByStatus('PENDING_APPROVAL'),
    countPendingKycSubmissions(),
    countUsersByLastLoginRange(monthStartDate, nextMonthStartDate),
    aggregateTotalDonationAmount()
  ]);

  return {
    pendingProjects: pendingProjectCount,
    pendingKycs: pendingKycCount,
    newUsersThisMonth: activeUserThisMonthCount,
    totalTransactionAmount
  };
}

/**
 * Hàm lấy danh sách timeline hoạt động gần đây cho admin dashboard.
 * Mục đích: tổng hợp sự kiện thật từ luồng giải ngân và audit đăng nhập.
 */
export async function getAdminDashboardTimelineEvents(): Promise<AdminDashboardTimelineEvent[]> {
  const [disbursementRecordList, auditLogEntryList] = await Promise.all([
    findLatestDisbursements(20),
    findLatestAuditLogs(20)
  ]);

  const [disbursementTimelineEvents, authTimelineEvents] = await Promise.all([
    buildTimelineEventsFromDisbursement(disbursementRecordList),
    Promise.resolve(buildTimelineEventsFromAuthAudit(auditLogEntryList))
  ]);

  return [...disbursementTimelineEvents, ...authTimelineEvents]
    .sort((leftEvent, rightEvent) => rightEvent.timestampValue - leftEvent.timestampValue)
    .slice(0, 12)
    .map(({ timestampValue, ...timelineEventItem }) => timelineEventItem);
}

/**
 * Hàm lấy danh sách audit log cho admin dashboard.
 * Mục đích: tổng hợp dữ liệu kiểm toán thật từ auth, sybil và disbursement.
 */
export async function getAdminDashboardAuditLogs(): Promise<AdminDashboardAuditLog[]> {
  const [auditLogEntryList, sybilAuditLogEntryList, disbursementRecordList] = await Promise.all([
    findLatestAuditLogs(40),
    findSybilAuditLogs(30, 0),
    findLatestDisbursements(30)
  ]);

  const [disbursementAuditLogItemList] = await Promise.all([
    buildAuditLogsFromDisbursement(disbursementRecordList)
  ]);

  const authAuditLogItemList = buildAuditLogsFromAuth(auditLogEntryList);
  const sybilAuditLogItemList = buildAuditLogsFromSybil(sybilAuditLogEntryList);

  return [...disbursementAuditLogItemList, ...authAuditLogItemList, ...sybilAuditLogItemList]
    .sort((leftLogItem, rightLogItem) => rightLogItem.timestampValue - leftLogItem.timestampValue)
    .slice(0, 50)
    .map(({ timestampValue, ...auditLogItem }) => auditLogItem);
}

const systemErrorLogCategoryList: SystemErrorLogCategory[] = [
  'TRANSFER_TIMEOUT_15_MINUTES',
  'DEPOSIT',
  'DISBURSEMENT',
  'AUTH'
];

const authFailureEventTypeSet = new Set<string>([
  'GOOGLE_LOGIN_FAILED',
  'REFRESH_TOKEN_FAILED',
  'REFRESH_DEVICE_MISMATCH'
]);

/**
 * Hàm trả về nhãn hiển thị cho từng nhóm log lỗi.
 * Mục đích: thống nhất tên phân loại giữa backend và giao diện Admin.
 */
function getSystemErrorCategoryLabel(category: SystemErrorLogCategory): string {
  switch (category) {
    case 'TRANSFER_TIMEOUT_15_MINUTES':
      return 'Chuyển tiền quá hạn 15 phút';
    case 'DEPOSIT':
      return 'Lỗi nạp tiền';
    case 'DISBURSEMENT':
      return 'Lỗi giải ngân';
    case 'AUTH':
      return 'Lỗi xác thực';
  }
}

/**
 * Hàm kiểm tra lỗi có thuộc nhóm quá hạn 15 phút hay không.
 * Mục đích: tách riêng lỗi cần tô đỏ theo yêu cầu vận hành của Admin.
 */
function isTransferTimeoutFifteenMinutesFailure(failureReason: string | null | undefined): boolean {
  if (!failureReason) {
    return false;
  }

  const normalizedFailureReason = failureReason.toLowerCase();
  return normalizedFailureReason.includes('15 phút')
    || normalizedFailureReason.includes('15 phut')
    || normalizedFailureReason.includes("15'")
    || normalizedFailureReason.includes('15’');
}

/**
 * Hàm chuẩn hóa tiêu đề lỗi xác thực từ event type.
 * Mục đích: giúp Admin đọc nhanh lỗi bảo mật mà không cần giải mã event kỹ thuật.
 */
function mapAuthFailureEventTitle(eventType: string): string {
  if (eventType === 'GOOGLE_LOGIN_FAILED') {
    return 'Đăng nhập Google thất bại';
  }

  if (eventType === 'REFRESH_TOKEN_FAILED') {
    return 'Làm mới phiên đăng nhập thất bại';
  }

  if (eventType === 'REFRESH_DEVICE_MISMATCH') {
    return 'Sai lệch thiết bị khi làm mới phiên';
  }

  return 'Lỗi xác thực hệ thống';
}

/**
 * Hàm map thông tin AuthUser sang actor info dùng trong log lỗi hệ thống.
 * Mục đích: chuẩn hóa đầu ra actor để UI luôn hiển thị thống nhất giữa các module.
 */
function mapAuthUserToSystemErrorActor(authUser: AuthUser): AdminSystemErrorActorInfo {
  return {
    displayName: authUser.fullName || authUser.email || authUser.id,
    userId: authUser.id,
    email: authUser.email || null,
    role: authUser.role || null,
    walletAddress: authUser.walletAddress || null
  };
}

/**
 * Hàm tạo actor mặc định khi không tìm thấy dữ liệu người dùng.
 * Mục đích: tránh thiếu trường quan trọng trong chi tiết log khiến Admin khó truy vết.
 */
function buildFallbackSystemErrorActor(displayName: string): AdminSystemErrorActorInfo {
  return {
    displayName,
    userId: null,
    email: null,
    role: null,
    walletAddress: null
  };
}

/**
 * Hàm resolve actor theo userId kèm cache.
 * Mục đích: hạn chế query lặp lại khi nhiều log cùng thuộc một người dùng.
 */
async function resolveSystemErrorActorByUserId(
  userId: string | null | undefined,
  userCacheByIdMap: Map<string, AuthUser | null>,
  fallbackDisplayName: string
): Promise<AdminSystemErrorActorInfo> {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    return buildFallbackSystemErrorActor(fallbackDisplayName);
  }

  if (!userCacheByIdMap.has(normalizedUserId)) {
    const userRecord = await findUserById(normalizedUserId);
    userCacheByIdMap.set(normalizedUserId, userRecord || null);
  }

  const cachedUser = userCacheByIdMap.get(normalizedUserId);
  if (!cachedUser) {
    return {
      ...buildFallbackSystemErrorActor(fallbackDisplayName),
      userId: normalizedUserId
    };
  }

  return mapAuthUserToSystemErrorActor(cachedUser);
}

/**
 * Hàm resolve actor từ audit log xác thực.
 * Mục đích: ưu tiên thông tin email/userId có sẵn trong audit để truy vết chính xác người gây lỗi.
 */
async function resolveSystemErrorActorFromAuthAudit(
  auditLogEntry: AuditLogEntry,
  userCacheByIdMap: Map<string, AuthUser | null>
): Promise<AdminSystemErrorActorInfo> {
  const actorByUserId = await resolveSystemErrorActorByUserId(
    auditLogEntry.userId,
    userCacheByIdMap,
    auditLogEntry.email || 'Người dùng ẩn danh'
  );

  if (!actorByUserId.email && auditLogEntry.email) {
    return {
      ...actorByUserId,
      email: auditLogEntry.email,
      displayName: actorByUserId.displayName || auditLogEntry.email
    };
  }

  return actorByUserId;
}

/**
 * Hàm xác định endpoint nguồn của lỗi xác thực.
 * Mục đích: giúp Admin biết lỗi phát sinh từ API nào để xử lý nhanh hơn.
 */
function getAuthFailureSourceOrigin(eventType: string): string {
  if (eventType === 'GOOGLE_LOGIN_FAILED') {
    return '/auth/login/google';
  }

  if (eventType === 'REFRESH_TOKEN_FAILED' || eventType === 'REFRESH_DEVICE_MISMATCH') {
    return '/auth/refresh';
  }

  return '/auth';
}

/**
 * Hàm chuyển danh sách giao dịch nạp tiền lỗi sang định dạng log hệ thống.
 * Mục đích: gom lỗi thuộc luồng deposit để Admin tra cứu tập trung.
 */
async function buildSystemErrorLogsFromDeposit(
  depositTransactionList: DepositTransaction[]
): Promise<SystemErrorLogWithSortValue[]> {
  const errorLogItemList: SystemErrorLogWithSortValue[] = [];
  const userCacheByIdMap = new Map<string, AuthUser | null>();

  for (const depositTransactionItem of depositTransactionList) {
    const updatedAtDate = parseSafeDate(depositTransactionItem.updatedAt);
    if (!updatedAtDate) {
      continue;
    }

    const hasTransferTimeoutFifteenMinutes = isTransferTimeoutFifteenMinutesFailure(depositTransactionItem.failureReason);
    const category: SystemErrorLogCategory = hasTransferTimeoutFifteenMinutes
      ? 'TRANSFER_TIMEOUT_15_MINUTES'
      : 'DEPOSIT';

    const actorInfo = await resolveSystemErrorActorByUserId(
      depositTransactionItem.userId,
      userCacheByIdMap,
      'Nhà hảo tâm'
    );

    const businessTimestamp = formatIsoTimestamp(depositTransactionItem.webhookProcessedAt)
      || formatIsoTimestamp(depositTransactionItem.paymentConfirmedAt)
      || formatIsoTimestamp(depositTransactionItem.updatedAt);

    const detailsText = depositTransactionItem.failureReason
      || 'Không có mô tả lỗi chi tiết từ cổng thanh toán.';

    errorLogItemList.push({
      id: `deposit-failed-${depositTransactionItem.id}`,
      timestamp: formatAuditTimestamp(updatedAtDate),
      category,
      categoryLabel: getSystemErrorCategoryLabel(category),
      sourceModule: 'DEPOSIT',
      severityLevel: hasTransferTimeoutFifteenMinutes ? 'high' : 'medium',
      title: hasTransferTimeoutFifteenMinutes
        ? 'Chuyển tiền quá thời hạn 15 phút'
        : 'Giao dịch nạp tiền thất bại',
      details: detailsText,
      referenceCode: depositTransactionItem.orderCode,
      isTransferTimeout15Minutes: hasTransferTimeoutFifteenMinutes,
      detailContext: {
        sourceOrigin: '/api/deposit/payos-webhook',
        actor: {
          ...actorInfo,
          walletAddress: actorInfo.walletAddress || depositTransactionItem.walletAddress || null
        },
        ipAddress: null,
        userAgent: null,
        businessTimestamp,
        systemTimestamp: updatedAtDate.toISOString(),
        createdAt: formatIsoTimestamp(depositTransactionItem.createdAt),
        updatedAt: formatIsoTimestamp(depositTransactionItem.updatedAt),
        correlationId: depositTransactionItem.correlationId || null,
        eventType: 'DEPOSIT_FAILED',
        projectId: null,
        projectName: null,
        organizationId: null,
        organizationName: null,
        orderCode: depositTransactionItem.orderCode,
        requestId: null,
        payosTransactionId: depositTransactionItem.payosTransactionId || null,
        payosTransferId: null,
        payosTransferStatus: null,
        transferAttemptCount: null,
        amountVnd: depositTransactionItem.amountVnd,
        amountToken: depositTransactionItem.tokenAmount
      },
      timestampValue: updatedAtDate.getTime()
    });
  }

  return errorLogItemList;
}

/**
 * Hàm chuyển dữ liệu giải ngân lỗi sang định dạng log hệ thống.
 * Mục đích: hiển thị các sự cố chuyển khoản ngân hàng trong một bảng theo dõi tập trung.
 */
async function buildSystemErrorLogsFromDisbursement(
  disbursementRecordList: DisbursementRecord[]
): Promise<SystemErrorLogWithSortValue[]> {
  const errorLogItemList: SystemErrorLogWithSortValue[] = [];
  const projectNameCache = new Map<string, string>();
  const organizationNameCache = new Map<string, string>();
  const userCacheByIdMap = new Map<string, AuthUser | null>();

  for (const disbursementRecord of disbursementRecordList) {
    const hasTransferError = disbursementRecord.payosTransferStatus === 'FAILED'
      || disbursementRecord.payosTransferStatus === 'MANUAL_REVIEW'
      || Boolean(disbursementRecord.payosTransferLastError);

    if (!hasTransferError) {
      continue;
    }

    const [projectName, organizationName] = await Promise.all([
      resolveProjectName(disbursementRecord.projectId, projectNameCache),
      resolveOrganizationName(disbursementRecord.organizationId, organizationNameCache)
    ]);

    const actorInfo = await resolveSystemErrorActorByUserId(
      disbursementRecord.organizationId,
      userCacheByIdMap,
      organizationName
    );

    const logTimestampDate = parseSafeDate(disbursementRecord.updatedAt) || parseSafeDate(disbursementRecord.createdAt);
    if (!logTimestampDate) {
      continue;
    }

    const detailsText = disbursementRecord.payosTransferLastError
      || `Trạng thái chuyển khoản PayOS: ${disbursementRecord.payosTransferStatus || 'UNKNOWN'}.`;

    errorLogItemList.push({
      id: `disbursement-transfer-${disbursementRecord.requestId}`,
      timestamp: formatAuditTimestamp(logTimestampDate),
      category: 'DISBURSEMENT',
      categoryLabel: getSystemErrorCategoryLabel('DISBURSEMENT'),
      sourceModule: 'DISBURSEMENT',
      severityLevel: disbursementRecord.payosTransferStatus === 'MANUAL_REVIEW' ? 'high' : 'medium',
      title: disbursementRecord.payosTransferStatus === 'MANUAL_REVIEW'
        ? 'Chuyển khoản giải ngân cần xử lý thủ công'
        : 'Lỗi chuyển khoản giải ngân',
      details: `${organizationName} · ${projectName} · ${detailsText}`,
      referenceCode: disbursementRecord.requestId,
      isTransferTimeout15Minutes: false,
      detailContext: {
        sourceOrigin: '/api/disbursement/auto-transfer',
        actor: actorInfo,
        ipAddress: null,
        userAgent: null,
        businessTimestamp: formatIsoTimestamp(disbursementRecord.updatedAt),
        systemTimestamp: logTimestampDate.toISOString(),
        createdAt: formatIsoTimestamp(disbursementRecord.createdAt),
        updatedAt: formatIsoTimestamp(disbursementRecord.updatedAt),
        correlationId: null,
        eventType: disbursementRecord.payosTransferStatus || 'DISBURSEMENT_TRANSFER_FAILED',
        projectId: disbursementRecord.projectId,
        projectName,
        organizationId: disbursementRecord.organizationId,
        organizationName,
        orderCode: null,
        requestId: disbursementRecord.requestId,
        payosTransactionId: null,
        payosTransferId: disbursementRecord.payosTransferId || null,
        payosTransferStatus: disbursementRecord.payosTransferStatus || null,
        transferAttemptCount: disbursementRecord.payosTransferAttemptCount,
        amountVnd: null,
        amountToken: disbursementRecord.amount
      },
      timestampValue: logTimestampDate.getTime()
    });
  }

  return errorLogItemList;
}

/**
 * Hàm chuyển audit log lỗi xác thực sang định dạng log hệ thống.
 * Mục đích: giúp Admin theo dõi sự cố bảo mật trực tiếp tại sidebar quản trị.
 */
async function buildSystemErrorLogsFromAuth(
  auditLogEntryList: AuditLogEntry[]
): Promise<SystemErrorLogWithSortValue[]> {
  const errorLogItemList: SystemErrorLogWithSortValue[] = [];
  const userCacheByIdMap = new Map<string, AuthUser | null>();

  for (const auditLogEntry of auditLogEntryList) {
    if (!authFailureEventTypeSet.has(auditLogEntry.eventType)) {
      continue;
    }

    const createdAtDate = parseSafeDate(auditLogEntry.createdAt);
    if (!createdAtDate) {
      continue;
    }

    const actorInfo = await resolveSystemErrorActorFromAuthAudit(auditLogEntry, userCacheByIdMap);

    errorLogItemList.push({
      id: `auth-error-${auditLogEntry.id}`,
      timestamp: formatAuditTimestamp(createdAtDate),
      category: 'AUTH',
      categoryLabel: getSystemErrorCategoryLabel('AUTH'),
      sourceModule: 'AUTH',
      severityLevel: 'medium',
      title: mapAuthFailureEventTitle(auditLogEntry.eventType),
      details: auditLogEntry.detail,
      referenceCode: auditLogEntry.id,
      isTransferTimeout15Minutes: false,
      detailContext: {
        sourceOrigin: getAuthFailureSourceOrigin(auditLogEntry.eventType),
        actor: actorInfo,
        ipAddress: auditLogEntry.ipAddress || null,
        userAgent: auditLogEntry.userAgent || null,
        businessTimestamp: formatIsoTimestamp(auditLogEntry.createdAt),
        systemTimestamp: createdAtDate.toISOString(),
        createdAt: formatIsoTimestamp(auditLogEntry.createdAt),
        updatedAt: formatIsoTimestamp(auditLogEntry.createdAt),
        correlationId: null,
        eventType: auditLogEntry.eventType,
        projectId: null,
        projectName: null,
        organizationId: null,
        organizationName: null,
        orderCode: null,
        requestId: null,
        payosTransactionId: null,
        payosTransferId: null,
        payosTransferStatus: null,
        transferAttemptCount: null,
        amountVnd: null,
        amountToken: null
      },
      timestampValue: createdAtDate.getTime()
    });
  }

  return errorLogItemList;
}

/**
 * Hàm gom dữ liệu log lỗi gốc từ các miền nghiệp vụ.
 * Mục đích: tạo một nguồn dữ liệu hợp nhất để lọc theo loại lỗi và trạng thái đọc.
 */
async function buildRawSystemErrorLogList(): Promise<SystemErrorLogWithSortValue[]> {
  const [failedDepositTransactionList, disbursementRecordList, authAuditLogEntryList] = await Promise.all([
    findLatestFailedDepositTransactions(120),
    findLatestDisbursements(120),
    findLatestAuditLogs(120)
  ]);

  const [depositErrorLogItemList, disbursementErrorLogItemList, authErrorLogItemList] = await Promise.all([
    buildSystemErrorLogsFromDeposit(failedDepositTransactionList),
    buildSystemErrorLogsFromDisbursement(disbursementRecordList),
    buildSystemErrorLogsFromAuth(authAuditLogEntryList)
  ]);

  return [...depositErrorLogItemList, ...disbursementErrorLogItemList, ...authErrorLogItemList]
    .sort((leftLogItem, rightLogItem) => rightLogItem.timestampValue - leftLogItem.timestampValue)
    .slice(0, 200);
}

/**
 * Hàm gắn trạng thái đã đọc cho danh sách log lỗi.
 * Mục đích: đồng bộ hiển thị unread/read theo từng tài khoản admin.
 */
function attachReadStateToSystemErrorLogs(
  rawErrorLogItemList: SystemErrorLogWithSortValue[],
  readStateByLogIdMap: Map<string, { isRead: boolean; readAt: Date | null }>
): AdminSystemErrorLog[] {
  return rawErrorLogItemList.map(({ timestampValue, ...rawErrorLogItem }) => {
    const matchedReadState = readStateByLogIdMap.get(rawErrorLogItem.id);

    return {
      ...rawErrorLogItem,
      isRead: matchedReadState?.isRead || false,
      readAt: matchedReadState?.readAt ? matchedReadState.readAt.toISOString() : null
    };
  });
}

/**
 * Hàm lọc danh sách log theo phân loại và trạng thái đọc.
 * Mục đích: hỗ trợ API trả về đúng tập dữ liệu mà Admin đang cần theo dõi.
 */
function filterSystemErrorLogs(
  allErrorLogItemList: AdminSystemErrorLog[],
  category: SystemErrorLogCategory | 'all',
  readState: SystemErrorLogReadStateFilter
): AdminSystemErrorLog[] {
  return allErrorLogItemList.filter((errorLogItem) => {
    if (category !== 'all' && errorLogItem.category !== category) {
      return false;
    }

    if (readState === 'read' && !errorLogItem.isRead) {
      return false;
    }

    if (readState === 'unread' && errorLogItem.isRead) {
      return false;
    }

    return true;
  });
}

/**
 * Hàm tạo thống kê theo từng phân loại log lỗi.
 * Mục đích: cung cấp dữ liệu badge/filter giúp Admin kiểm soát nhanh toàn cục.
 */
function buildSystemErrorLogCategorySummaryList(
  allErrorLogItemList: AdminSystemErrorLog[]
): AdminSystemErrorLogCategorySummary[] {
  return systemErrorLogCategoryList.map((category) => {
    const categoryItemList = allErrorLogItemList.filter((errorLogItem) => errorLogItem.category === category);
    const unreadCount = categoryItemList.filter((errorLogItem) => !errorLogItem.isRead).length;

    return {
      category,
      categoryLabel: getSystemErrorCategoryLabel(category),
      totalCount: categoryItemList.length,
      unreadCount
    };
  });
}

/**
 * Hàm lấy danh sách log lỗi hệ thống cho trang Admin.
 * Mục đích: phục vụ panel "Log lỗi hệ thống" với phân loại lỗi và trạng thái đọc.
 */
export async function getAdminSystemErrorLogs(
  adminUserId: string,
  options?: {
    category?: SystemErrorLogCategory | 'all';
    readState?: SystemErrorLogReadStateFilter;
    limitCount?: number;
  }
): Promise<AdminSystemErrorLogListResult> {
  const category = options?.category || 'all';
  const readState = options?.readState || 'all';
  const limitCount = options?.limitCount;
  const normalizedLimitCount = Number.isFinite(limitCount)
    ? Math.max(1, Math.min(200, Math.floor(limitCount as number)))
    : 100;

  const rawErrorLogItemList = await buildRawSystemErrorLogList();
  const logIdList = rawErrorLogItemList.map((errorLogItem) => errorLogItem.id);
  const readStateList = await findSystemErrorReadStatesByAdminUserIdAndLogIdList(adminUserId, logIdList);

  const readStateByLogIdMap = new Map(
    readStateList.map((readStateItem) => [
      readStateItem.logId,
      {
        isRead: readStateItem.isRead,
        readAt: readStateItem.readAt
      }
    ])
  );

  const allErrorLogItemList = attachReadStateToSystemErrorLogs(rawErrorLogItemList, readStateByLogIdMap);
  const filteredErrorLogItemList = filterSystemErrorLogs(allErrorLogItemList, category, readState)
    .slice(0, normalizedLimitCount);

  const unreadCount = allErrorLogItemList.filter((errorLogItem) => !errorLogItem.isRead).length;
  const transferTimeoutFifteenMinutesCount = allErrorLogItemList
    .filter((errorLogItem) => errorLogItem.isTransferTimeout15Minutes)
    .length;

  return {
    logs: filteredErrorLogItemList,
    summary: {
      totalCount: allErrorLogItemList.length,
      unreadCount,
      transferTimeout15MinutesCount: transferTimeoutFifteenMinutesCount,
      categorySummaryList: buildSystemErrorLogCategorySummaryList(allErrorLogItemList)
    }
  };
}

/**
 * Hàm cập nhật trạng thái đã đọc/chưa đọc cho một log lỗi hệ thống.
 * Mục đích: cho phép Admin đánh dấu log để kiểm soát danh sách lỗi cần xử lý.
 */
export async function updateAdminSystemErrorLogReadState(
  adminUserId: string,
  logId: string,
  isRead: boolean
): Promise<{ logId: string; isRead: boolean; readAt: string | null }> {
  const normalizedLogId = String(logId || '').trim();
  if (!normalizedLogId) {
    throw new ApplicationError('logId không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  // Ghi chú logic phức tạp: xác thực logId tồn tại trong danh sách log nguồn trước khi cập nhật read state,
  // giúp tránh ghi dữ liệu rác hoặc log giả mạo theo yêu cầu kiểm soát truy vết.
  const rawErrorLogItemList = await buildRawSystemErrorLogList();
  const isExistingLogId = rawErrorLogItemList.some((errorLogItem) => errorLogItem.id === normalizedLogId);

  if (!isExistingLogId) {
    throw new ApplicationError('Không tìm thấy log lỗi cần cập nhật.', 404, 'NOT_FOUND');
  }

  const updatedReadState = await upsertSystemErrorReadState(adminUserId, normalizedLogId, isRead);

  return {
    logId: normalizedLogId,
    isRead: updatedReadState.isRead,
    readAt: updatedReadState.readAt ? updatedReadState.readAt.toISOString() : null
  };
}

/**
 * Kiểu dữ liệu trả về cho guest session summary trên Admin Dashboard.
 */
export type AdminGuestSessionSummary = GuestSessionSummary;

/**
 * Kiểu dữ liệu một dòng guest session trong bảng admin.
 */
export type AdminGuestSessionRow = {
  sessionId: string;
  walletAddress: string;
  status: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';
  donationCount: number;
  totalDonatedAmount: number;
  totalSponsoredGas: number;
  renewalCount: number;
  deviceFingerprintHash: string;
  ipAddress: string;
  hasPendingDonation: boolean;
  claimedByUserId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Kiểu dữ liệu trả về cho danh sách guest sessions có phân trang trên Admin.
 */
export type AdminGuestSessionListResult = {
  sessions: AdminGuestSessionRow[];
  totalCount: number;
  pageCount: number;
  page: number;
  limit: number;
};

/**
 * Kiểu dữ liệu filter cho guest session list API.
 */
export type AdminGuestSessionListFilters = {
  status?: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'PURGED';
  walletAddress?: string;
  ipAddress?: string;
  startDate?: string;
  endDate?: string;
};

/**
 * Hàm format một guest session record thành row cho bảng admin.
 * Mục đích: chuẩn hóa dữ liệu trả về, đảm bảo các trường datetime thành ISO string
 * và rút gọn fingerprint để hiển thị dễ đọc.
 *
 * Dùng type chính thức GuestWalletSession thay vì inline anonymous type —
 * giúp TypeScript bắt lỗi khi model thêm/đổi field.
 */
function formatGuestSessionRow(session: GuestWalletSession): AdminGuestSessionRow {
  // Rút gọn fingerprint về 16 ký tự hex để hiển thị grouping (cùng thiết bị)
  // mà không lộ hash đầy đủ. Admin chỉ cần xác nhận 2 sessions cùng prefix
  // — không cần hash nguyên (64 ký tự).
  const fingerprintDisplay = (session.deviceFingerprintHash ?? '').substring(0, 16) + '...';

  return {
    sessionId: session.sessionId,
    walletAddress: session.walletAddress,
    status: session.status,
    donationCount: session.donationCount,
    totalDonatedAmount: session.totalDonatedAmount,
    totalSponsoredGas: session.totalSponsoredGas,
    renewalCount: session.renewalCount,
    deviceFingerprintHash: fingerprintDisplay,
    ipAddress: session.ipAddress,
    hasPendingDonation: session.hasPendingDonation,
    claimedByUserId: session.claimedByUserId,
    expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

/**
 * Hàm lấy thống kê tổng quan guest sessions cho Admin Dashboard.
 * Mục đích: cung cấp KPI cards - đếm sessions theo status, sum gas sponsored và donation amounts.
 *
 * Design: Dùng passthrough wrapper thay vì controller gọi repo trực tiếp để:
 * 1. Giữ layer boundary rõ ràng — controller chỉ gọi service, không biết repository
 * 2. Tạo hook point cho future business logic (e.g., enrich với risk data)
 * 3. Service layer là nơi duy nhất biết cả guest session và risk data
 */
export async function getAdminGuestSessionSummary(): Promise<AdminGuestSessionSummary> {
  return getGuestSessionSummaryRepo();
}

/**
 * Hàm lấy danh sách guest sessions có phân trang cho Admin.
 * Mục đích: hiển thị bảng quản lý với filter theo status, wallet address, IP, ngày tạo.
 * Chuẩn hóa pagination tại đây — repository tin tưởng giá trị từ service.
 *
 * @param page - Trang hiện tại (1-based, default: 1)
 * @param limit - Số bản ghi mỗi trang (default: 20, max: 100)
 * @param filters - Bộ lọc tùy chọn
 */
export async function listAdminGuestSessions(
  page: number,
  limit: number,
  filters?: AdminGuestSessionListFilters
): Promise<AdminGuestSessionListResult> {
  const normalizedPage = Math.max(1, page);
  const normalizedLimit = Math.max(1, Math.min(100, limit));

  const repoFilters: GuestSessionFilters = {};

  if (filters?.status) {
    repoFilters.status = filters.status;
  }

  if (filters?.walletAddress && filters.walletAddress.trim()) {
    repoFilters.walletAddress = filters.walletAddress.trim();
  }

  if (filters?.ipAddress && filters.ipAddress.trim()) {
    repoFilters.ipAddress = filters.ipAddress.trim();
  }

  if (filters?.startDate) {
    const parsedStartDate = new Date(filters.startDate);
    if (!Number.isNaN(parsedStartDate.getTime())) {
      repoFilters.startDate = parsedStartDate;
    }
  }

  if (filters?.endDate) {
    const parsedEndDate = new Date(filters.endDate);
    if (!Number.isNaN(parsedEndDate.getTime())) {
      repoFilters.endDate = parsedEndDate;
    }
  }

  const result = await listGuestSessionsPaginated(normalizedPage, normalizedLimit, repoFilters);

  return {
    sessions: result.sessions.map(formatGuestSessionRow),
    totalCount: result.totalCount,
    pageCount: result.pageCount,
    page: normalizedPage,
    limit: normalizedLimit
  };
}

/**
 * Hàm vô hiệu hóa một guest session theo yêu cầu của Admin.
 * Mục đích: cho phép admin manually expire session đang ACTIVE khi phát hiện hành vi bất thường.
 *
 * @param sessionId - ID của session cần vô hiệu hóa
 */
export async function invalidateAdminGuestSession(sessionId: string): Promise<{
  sessionId: string;
  status: string;
}> {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) {
    throw new ApplicationError('sessionId không hợp lệ.', 400, 'VALIDATION_ERROR');
  }

  const { session, alreadyInactive } = await invalidateGuestSessionRepo(normalizedSessionId);

  if (!session) {
    throw new ApplicationError('Không tìm thấy guest session.', 404, 'NOT_FOUND');
  }

  if (alreadyInactive) {
    throw new ApplicationError(
      `Session đang ở trạng thái '${session.status}', không cần vô hiệu hóa.`,
      409,
      'GUEST_SESSION_ALREADY_INACTIVE'
    );
  }

  return {
    sessionId: session.sessionId,
    status: session.status
  };
}
