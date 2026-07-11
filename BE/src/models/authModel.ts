import mongoose, { Schema } from 'mongoose';

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  walletAddress: string;
  smartAccountOwnerAddress: string | null;
  smartAccountOwnerEncryptedPrivateKey: string | null;
  socialProvider: string;
  socialAccountId: string;
  isEmailVerified: boolean;
  accountStatus: 'ACTIVE' | 'INACTIVE_PENDING_KYC';
  organizationName: string | null;
  legalRegistrationNumber: string | null;
  isSybil: boolean;
  lastLoginAt: Date;
  lastLoginIp: string | null;
  lastLoginUserAgent: string | null;
  correlationId: string;
  /** FCM device token cho push notification (FCM). */
  fcmDeviceToken: string | null;
  /** So dien thoai cua nguoi dung (dung cho SMS notification). */
  phoneNumber: string | null;
  /**
   * Auth version - tăng lên mỗi khi role thay đổi hoặc quyền bị thu hồi.
   * Dùng để invalidate JWT cũ và disconnect socket khi quyền thay đổi.
   * [S-NEW2 fix]
   */
  authVersion: number;
  updatedAt?: Date;
};

export type RefreshSession = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  csrfToken: string;
  ipAddress: string;
  userAgent: string;
  expiresAt: Date;
  failedRefreshCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AuditLogEntry = {
  id: string;
  userId: string | null;
  email: string | null;
  eventType: string;
  ipAddress: string;
  userAgent: string;
  detail: string;
  createdAt: Date;
};

const authUserSchema = new Schema<AuthUser>({
  id: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  role: { type: String, required: true },
  walletAddress: { type: String, required: true },
  smartAccountOwnerAddress: { type: String, default: null },
  smartAccountOwnerEncryptedPrivateKey: { type: String, default: null },
  socialProvider: { type: String, required: true },
  socialAccountId: { type: String, required: true },
  isEmailVerified: { type: Boolean, required: true },
  accountStatus: { type: String, required: true },
  organizationName: { type: String, default: null },
  legalRegistrationNumber: { type: String, default: null },
  isSybil: { type: Boolean, required: true, default: false },
  lastLoginAt: { type: Date, required: true },
  lastLoginIp: { type: String, default: null },
  lastLoginUserAgent: { type: String, default: null },
  correlationId: { type: String, required: true },
  fcmDeviceToken: { type: String, default: null },
  phoneNumber: { type: String, default: null },
  authVersion: { type: Number, required: true, default: 1 }
});

// Ghi chú logic phức tạp: dùng partial unique index để chỉ bắt buộc duy nhất khi legalRegistrationNumber là chuỗi hợp lệ,
// tránh lỗi duplicate khi giá trị null hoặc thiếu ở giai đoạn đăng ký ban đầu.
authUserSchema.index(
  { legalRegistrationNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      legalRegistrationNumber: { $exists: true, $gt: '' }
    }
  }
);


const refreshSessionSchema = new Schema<RefreshSession>({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  refreshTokenHash: { type: String, required: true },
  csrfToken: { type: String, required: true },
  ipAddress: { type: String, required: true },
  userAgent: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  failedRefreshCount: { type: Number, required: true },
  lockedUntil: { type: Date, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true }
});

const auditLogSchema = new Schema<AuditLogEntry>({
  id: { type: String, required: true, unique: true },
  userId: { type: String, default: null },
  email: { type: String, default: null },
  eventType: { type: String, required: true },
  ipAddress: { type: String, required: true },
  userAgent: { type: String, required: true },
  detail: { type: String, required: true },
  createdAt: { type: Date, required: true }
});

export const AuthUserModel = mongoose.model<AuthUser>('AuthUser', authUserSchema);
const RefreshSessionModel = mongoose.model<RefreshSession>('RefreshSession', refreshSessionSchema);
const AuditLogModel = mongoose.model<AuditLogEntry>('AuditLog', auditLogSchema);

/**
 * Hàm tìm người dùng theo mã số đăng ký pháp lý.
 * Mục đích: kiểm tra trùng dữ liệu pháp lý của tổ chức.
 */
export async function findUserByLegalRegistrationNumber(legalRegistrationNumber: string): Promise<AuthUser | null> {
  return AuthUserModel.findOne({ legalRegistrationNumber }).lean<AuthUser>().exec();
}

/**
 * Hàm tìm người dùng theo email.
 * Mục đích: lấy dữ liệu người dùng từ MongoDB theo email.
 */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  return AuthUserModel.findOne({ email }).lean<AuthUser>().exec();
}

/**
 * Hàm tìm người dùng theo wallet address.
 * Mục đích: phục vụ FR5/UC5.1 — lookup người dùng khi toggle Sybil status.
 */
export async function findUserByWalletAddress(walletAddress: string): Promise<AuthUser | null> {
  return AuthUserModel.findOne({ walletAddress: walletAddress.toLowerCase() }).lean<AuthUser>().exec();
}

/**
 * Hàm tìm người dùng theo id.
 * Mục đích: lấy dữ liệu người dùng từ MongoDB theo định danh.
 */
export async function findUserById(userId: string): Promise<AuthUser | null> {
  return AuthUserModel.findOne({ id: userId }).lean<AuthUser>().exec();
}

/**
 * Hàm lưu mới người dùng.
 * Mục đích: tạo dữ liệu người dùng trong MongoDB.
 */
export async function createUser(user: AuthUser): Promise<AuthUser> {
  const createdUser = await AuthUserModel.create(user);
  return createdUser.toObject() as AuthUser;
}

/**
 * Hàm cập nhật người dùng.
 * Mục đích: lưu trạng thái đăng nhập mới nhất.
 */
export async function updateUser(user: AuthUser): Promise<AuthUser> {
  const updatedUser = await AuthUserModel.findOneAndUpdate(
    { id: user.id },
    user,
    { returnDocument: 'after' }
  ).exec();
  return (updatedUser?.toObject() as AuthUser) || user;
}

/**
 * Tăng authVersion của user và invalidate tất cả socket connections.
 * Dùng khi role thay đổi hoặc quyền bị thu hồi.
 * [S-NEW2 fix]
 */
export async function incrementAuthVersion(userId: string): Promise<number> {
  const updated = await AuthUserModel.findOneAndUpdate(
    { id: userId },
    { $inc: { authVersion: 1 } },
    { returnDocument: 'after' }
  ).lean<AuthUser>().exec();
  
  if (!updated) {
    throw new Error(`User ${userId} not found for authVersion increment`);
  }
  
  return updated.authVersion;
}

/**
 * Hàm tạo phiên refresh token.
 * Mục đích: lưu hash refresh token và metadata thiết bị.
 */
export async function createRefreshSession(session: RefreshSession): Promise<RefreshSession> {
  const createdSession = await RefreshSessionModel.create(session);
  return createdSession.toObject() as RefreshSession;
}

/**
 * Hàm tìm phiên refresh token theo id.
 * Mục đích: phục vụ xác thực khi làm mới token.
 */
export async function findRefreshSessionById(sessionId: string): Promise<RefreshSession | null> {
  return RefreshSessionModel.findOne({ id: sessionId }).lean<RefreshSession>().exec();
}

/**
 * Hàm cập nhật phiên refresh token.
 * Mục đích: lưu trạng thái lockout hoặc rotate token.
 */
export async function updateRefreshSession(session: RefreshSession): Promise<RefreshSession> {
  const updatedSession = await RefreshSessionModel.findOneAndUpdate(
    { id: session.id },
    session,
    { returnDocument: 'after' }
  ).exec();
  return (updatedSession?.toObject() as RefreshSession) || session;
}

/**
 * Hàm lấy danh sách phiên refresh token còn hiệu lực theo userId.
 * Mục đích: cung cấp dữ liệu phiên đăng nhập thật cho màn hình bảo mật.
 */
export async function getActiveRefreshSessionsByUserId(userId: string): Promise<RefreshSession[]> {
  const currentTime = new Date();
  return RefreshSessionModel.find({ userId, expiresAt: { $gt: currentTime } })
    .sort({ updatedAt: -1 })
    .lean<RefreshSession[]>()
    .exec();
}

/**
 * Hàm thu hồi toàn bộ phiên refresh token theo userId.
 * Mục đích: đăng xuất toàn bộ thiết bị của người dùng.
 */
export async function revokeRefreshSessionsByUserId(userId: string): Promise<void> {
  await RefreshSessionModel.deleteMany({ userId }).exec();
}

/**
 * Hàm thu hồi phiên refresh token.
 * Mục đích: xoá phiên khi hết hạn hoặc sai bảo mật.
 */
export async function revokeRefreshSession(sessionId: string): Promise<void> {
  await RefreshSessionModel.deleteOne({ id: sessionId }).exec();
}

/**
 * Hàm ghi audit log.
 * Mục đích: lưu sự kiện đăng nhập thất bại hoặc thiết bị mới.
 */
export async function addAuditLog(entry: AuditLogEntry): Promise<void> {
  await AuditLogModel.create(entry);
}

/**
 * Hàm đếm số người dùng có đăng nhập trong một khoảng thời gian.
 * Mục đích: cung cấp dữ liệu thật cho metric người dùng hoạt động theo tháng trên dashboard admin.
 */
export async function countUsersByLastLoginRange(startDate: Date, endDate: Date): Promise<number> {
  return AuthUserModel.countDocuments({
    lastLoginAt: {
      $gte: startDate,
      $lt: endDate
    }
  }).exec();
}

/**
 * Hàm lấy danh sách audit log mới nhất.
 * Mục đích: phục vụ bảng nhật ký kiểm toán trên trang tổng quan hệ thống admin.
 */
export async function findLatestAuditLogs(limitCount: number = 50): Promise<AuditLogEntry[]> {
  const normalizedLimitCount = Number.isFinite(limitCount)
    ? Math.max(1, Math.min(200, Math.floor(limitCount)))
    : 50;

  return AuditLogModel.find({})
    .sort({ createdAt: -1 })
    .limit(normalizedLimitCount)
    .lean<AuditLogEntry[]>()
    .exec();
}

/**
 * Hàm lấy danh sách người dùng theo nhiều ví.
 * Mục đích: map dữ liệu donation on-chain sang thông tin công khai nhà hảo tâm từ MongoDB.
 */
export async function findUsersByWalletAddressList(walletAddressList: string[]): Promise<AuthUser[]> {
  if (!walletAddressList.length) {
    return [];
  }

  const normalizedWalletAddressList = walletAddressList
    .map(walletAddressItem => String(walletAddressItem || '').trim().toLowerCase())
    .filter(Boolean);

  if (!normalizedWalletAddressList.length) {
    return [];
  }

  return AuthUserModel.find({ walletAddress: { $in: normalizedWalletAddressList } }).lean<AuthUser[]>().exec();
}

// =============================================================================
// SYBIL AUDIT LOG
// =============================================================================

/** Kiểu dữ liệu bản ghi thay đổi trạng thái Sybil — ghi nhận quyết định của Admin/Regulatory Bodies theo FR5/UC5.1. */
export type SybilAuditLogEntry = {
  id: string;
  userId: string;
  walletAddress: string;
  action: 'mark_as_sybil' | 'unmark_as_sybil';
  previousValue: boolean;
  newValue: boolean;
  reason: string;
  performedBy: string;
  performedByRole: string;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
};

const sybilAuditLogSchema = new Schema<SybilAuditLogEntry>({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  walletAddress: { type: String, required: true, index: true },
  action: { type: String, required: true, enum: ['mark_as_sybil', 'unmark_as_sybil'] },
  previousValue: { type: Boolean, required: true },
  newValue: { type: Boolean, required: true },
  reason: { type: String, required: true },
  performedBy: { type: String, required: true },
  performedByRole: { type: String, required: true },
  ipAddress: { type: String, required: true },
  userAgent: { type: String, required: true },
  createdAt: { type: Date, required: true }
});

export const SybilAuditLogModel = mongoose.model<SybilAuditLogEntry>('SybilAuditLog', sybilAuditLogSchema);

/**
 * Hàm ghi log thay đổi trạng thái Sybil.
 * Mục đích: lưu audit trail bắt buộc theo FR5/UC5.1 — mọi quyết định đánh dấu hoặc bỏ đánh dấu
 * Sybil đều phải được ghi nhận kèm lý do, người thực hiện và thời gian.
 *
 * Lưu ý: Dùng toObject() để chuyển thành plain object thuần túy, tránh Mongoose document
 * wrapper gây schema validation lỗi khi create().
 */
export async function addSybilAuditLog(entry: SybilAuditLogEntry): Promise<SybilAuditLogEntry> {
  // Chuyển thành plain object thuần túy — đảm bảo tất cả required fields không bị undefined
  const plainEntry = { ...entry };
  const createdEntry = await SybilAuditLogModel.create(plainEntry);
  return createdEntry.toObject() as SybilAuditLogEntry;
}

/**
 * Hàm lấy danh sách audit log Sybil.
 * Mục đích: phục vụ trang quản lý Sybil của Regulatory Bodies — hiển thị lịch sử thay đổi.
 */
export async function findSybilAuditLogs(limitCount: number = 50, skipCount: number = 0): Promise<SybilAuditLogEntry[]> {
  return SybilAuditLogModel.find({})
    .sort({ createdAt: -1 })
    .skip(skipCount)
    .limit(limitCount)
    .lean<SybilAuditLogEntry[]>()
    .exec();
}

/**
 * Hàm lấy audit log Sybil theo userId.
 * Mục đích: hiển thị lịch sử thay đổi của một ví cụ thể trong modal chi tiết.
 */
export async function findSybilAuditLogsByUserId(userId: string): Promise<SybilAuditLogEntry[]> {
  return SybilAuditLogModel.find({ userId })
    .sort({ createdAt: -1 })
    .lean<SybilAuditLogEntry[]>()
    .exec();
}

/**
 * Hàm đếm tổng audit log Sybil.
 * Mục đích: hỗ trợ phân trang phía frontend.
 */
export async function countSybilAuditLogs(): Promise<number> {
  return SybilAuditLogModel.countDocuments({}).exec();
}

/**
 * Hàm lấy danh sách người dùng theo role.
 * Mục đích: Oracle B2 — lấy tất cả commissioner (admin + regulatory) để tạo snapshot khi có override request.
 * Chỉ lấy ACTIVE accounts để tránh include tài khoản bị suspend vào snapshot.
 */
export async function findUsersByRole(roles: string[]): Promise<AuthUser[]> {
  if (!roles.length) return [];
  return AuthUserModel.find({
    role: { $in: roles },
    accountStatus: 'ACTIVE'
  }).lean<AuthUser[]>().exec();
}

/**
 * Lấy danh sách commissioner đủ tư cách biểu quyết override request.
 *
 * [B2-fix #5] Tách helper riêng thay vì thêm isSybil filter vào findUsersByRole —
 * tránh ảnh hưởng các caller khác cần lấy cả Sybil users (vd: trang admin review Sybil).
 * Lọc thêm isSybil=false để ngăn Sybil-flagged user lọt vào commissionerSnapshot.
 */
export async function findActiveCommissioners(): Promise<AuthUser[]> {
  return AuthUserModel.find({
    role: { $in: ['admin', 'regulatory'] },
    accountStatus: 'ACTIVE',
    isSybil: false
  }).lean<AuthUser[]>().exec();
}

/**
 * Lay thong tin user phuc vu notification dispatch.
 * Tra ve email, FCM token, va phone number cua nguoi dung.
 * Dung cho E2 multi-channel delivery — worker can thong tin nay de goi dispatcher.
 *
 * @param userId ID cua nguoi dung (truong `id`, khong phai `_id`)
 * @returns UserNotificationContext hoac null neu user khong ton tai
 */
export async function findUserNotificationContext(
  userId: string
): Promise<{
  userId: string;
  userEmail: string | undefined;
  fcmDeviceToken: string | undefined;
  phoneNumber: string | undefined;
} | null> {
  const user = await AuthUserModel.findOne({ id: userId })
    .select('id email fcmDeviceToken phoneNumber')
    .lean<AuthUser>()
    .exec();

  if (!user) {
    return null;
  }

  return {
    userId: user.id,
    userEmail: user.email,
    fcmDeviceToken: user.fcmDeviceToken ?? undefined,
    phoneNumber: user.phoneNumber ?? undefined
  };
}
