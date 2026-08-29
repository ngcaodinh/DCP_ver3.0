import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';

export type AuthUser = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  walletAddress: string;
  /** Địa chỉ MetaMask tự quản dùng riêng cho cổng quản trị, luôn lưu chữ thường. */
  governanceWalletAddress?: string | null;
  /** Slot 1-based bảo vệ quota Chair/Member bằng unique index ở MongoDB. */
  governanceSeatSlot?: number | null;
  /** Đánh dấu ví admin được đồng bộ từ allowlist hệ thống để reconciliation không chạm admin thường. */
  isRootAdminWallet?: boolean;
  smartAccountOwnerAddress: string | null;
  smartAccountOwnerEncryptedPrivateKey: string | null;
  socialProvider: string;
  socialAccountId: string;
  isEmailVerified: boolean;
  accountStatus: 'ACTIVE' | 'INACTIVE_PENDING_KYC' | 'PENDING_STAKE_VERIFICATION' | 'SUSPENDED';
  suspendedReasonCode?: string | null;
  organizationName: string | null;
  legalRegistrationNumber: string | null;
  isSybil: boolean;
  lastLoginAt: Date | null;
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

/** Nonce SIWE ngắn hạn để chống phát lại chữ ký đăng nhập cổng quản trị. */
export type WalletLoginNonce = {
  id: string;
  walletAddress: string;
  nonce: string;
  expiresAt: Date;
  createdAt: Date;
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
  governanceWalletAddress: { type: String, default: null },
  governanceSeatSlot: { type: Number, default: null },
  isRootAdminWallet: { type: Boolean, required: true, default: false },
  smartAccountOwnerAddress: { type: String, default: null },
  smartAccountOwnerEncryptedPrivateKey: { type: String, default: null },
  socialProvider: { type: String, required: true },
  socialAccountId: { type: String, required: true },
  isEmailVerified: { type: Boolean, required: true },
  accountStatus: { type: String, required: true },
  suspendedReasonCode: { type: String, default: null },
  organizationName: { type: String, default: null },
  legalRegistrationNumber: { type: String, default: null },
  isSybil: { type: Boolean, required: true, default: false },
  lastLoginAt: { type: Date, default: null },
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

// Chỉ địa chỉ ví quản trị thực sự mới phải duy nhất; các tài khoản Google cũ có giá trị null không xung đột.
authUserSchema.index(
  { governanceWalletAddress: 1 },
  {
    unique: true,
    partialFilterExpression: {
      governanceWalletAddress: { $exists: true, $gt: '' }
    }
  }
);

// Slot được giữ duy nhất khi ghế còn ACTIVE, do đó nhiều request đồng thời không thể vượt quota 1 Chair hoặc 4 Member.
authUserSchema.index(
  { role: 1, governanceSeatSlot: 1 },
  {
    unique: true,
    partialFilterExpression: {
      role: { $in: ['executive_chair', 'executive_member'] },
      accountStatus: 'ACTIVE',
      governanceSeatSlot: { $gte: 1 }
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

const walletLoginNonceSchema = new Schema<WalletLoginNonce>({
  id: { type: String, required: true, unique: true },
  walletAddress: { type: String, required: true, index: true },
  nonce: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  createdAt: { type: Date, required: true }
});

export const AuthUserModel = mongoose.models?.AuthUser
  || mongoose.model<AuthUser>('AuthUser', authUserSchema);
const RefreshSessionModel = mongoose.models?.RefreshSession
  || mongoose.model<RefreshSession>('RefreshSession', refreshSessionSchema);
const AuditLogModel = mongoose.models?.AuditLog
  || mongoose.model<AuditLogEntry>('AuditLog', auditLogSchema);
const WalletLoginNonceModel = mongoose.models?.WalletLoginNonce
  || mongoose.model<WalletLoginNonce>('WalletLoginNonce', walletLoginNonceSchema);

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

/** Tìm tài khoản quản trị theo địa chỉ MetaMask chuẩn hóa chữ thường. */
export async function findUserByGovernanceWalletAddress(walletAddress: string): Promise<AuthUser | null> {
  return AuthUserModel.findOne({ governanceWalletAddress: walletAddress.toLowerCase() })
    .lean<AuthUser>()
    .exec();
}

/** Liệt kê các ví root admin đã được đồng bộ trước đó để reconciliation tập cấu hình có thể thu hồi ví bị loại. */
export async function findRootAdminWalletUsers(): Promise<AuthUser[]> {
  return AuthUserModel.find({ role: 'admin', isRootAdminWallet: true })
    .lean<AuthUser[]>()
    .exec();
}

/** Liệt kê ghế Ủy ban và chỉ trả trường tối thiểu cần cho màn quản trị. */
export async function findGovernanceSeats(): Promise<AuthUser[]> {
  return AuthUserModel.find({ role: { $in: ['executive_chair', 'executive_member'] } })
    .select('id fullName role governanceWalletAddress walletAddress governanceSeatSlot accountStatus lastLoginAt updatedAt authVersion')
    .sort({ role: 1, createdAt: 1 })
    .lean<AuthUser[]>()
    .exec();
}

/** Tạo ghế với slot đã chọn để MongoDB thực thi quota ngay cả khi request chạy đồng thời. */
export async function createGovernanceSeatUser(user: AuthUser, governanceSeatSlot: number): Promise<AuthUser> {
  const createdUser = await AuthUserModel.create({ ...user, governanceSeatSlot });
  return createdUser.toObject() as AuthUser;
}

/** Đếm ghế đang hoạt động theo vai trò để giới hạn đúng cấu hình 1 Chủ tịch và 4 Ủy viên. */
export async function countActiveGovernanceSeats(role: 'executive_chair' | 'executive_member'): Promise<number> {
  return AuthUserModel.countDocuments({ role, accountStatus: 'ACTIVE' }).exec();
}

/** Đếm ghế ACTIVE legacy chưa có slot để service khóa mutation cho tới khi migration hoàn tất. */
export async function countActiveGovernanceSeatsMissingSlot(): Promise<number> {
  return AuthUserModel.countDocuments({
    role: { $in: ['executive_chair', 'executive_member'] },
    accountStatus: 'ACTIVE',
    $or: [
      { governanceSeatSlot: null },
      { governanceSeatSlot: { $exists: false } }
    ]
  }).exec();
}

/** Thu ghế theo ví, tăng authVersion trong cùng một ghi để thu hồi JWT đang mở. */
export async function suspendGovernanceSeatByWalletAddress(walletAddress: string): Promise<AuthUser | null> {
  return AuthUserModel.findOneAndUpdate(
    {
      governanceWalletAddress: walletAddress.toLowerCase(),
      role: { $in: ['executive_chair', 'executive_member'] },
      accountStatus: 'ACTIVE'
    },
    {
      $set: { accountStatus: 'SUSPENDED' },
      $inc: { authVersion: 1 }
    },
    { returnDocument: 'after' }
  ).lean<AuthUser>().exec();
}

/** Đồng bộ một ghế hiện hữu từ chain, chỉ dùng bởi projector sau khi event SeatChangeExecuted đã được xác nhận. */
export async function upsertGovernanceSeatFromChain(input: {
  walletAddress: string;
  role: 'executive_chair' | 'executive_member';
  governanceSeatSlot: number;
}): Promise<AuthUser> {
  const walletAddress = input.walletAddress.toLowerCase();
  const existing = await findUserByGovernanceWalletAddress(walletAddress);
  const roleOrStatusChanged = Boolean(existing && (existing.role !== input.role || existing.accountStatus !== 'ACTIVE'));
  const setOnInsert: Record<string, unknown> = {
    id: crypto.randomUUID(),
    email: `${walletAddress}@wallet.dcp.local`,
    fullName: `On-chain committee seat ${walletAddress.slice(0, 10)}`,
    smartAccountOwnerAddress: null,
    smartAccountOwnerEncryptedPrivateKey: null,
    socialProvider: 'metamask',
    socialAccountId: walletAddress,
    isEmailVerified: false,
    organizationName: null,
    legalRegistrationNumber: null,
    isSybil: false,
    lastLoginAt: null,
    lastLoginIp: null,
    lastLoginUserAgent: null,
    correlationId: crypto.randomUUID(),
    fcmDeviceToken: null,
    phoneNumber: null,
    isRootAdminWallet: false
  };
  // $inc và $setOnInsert cùng một field bị Mongo từ chối, nên chỉ gán default cho nhánh insert thực sự.
  if (!roleOrStatusChanged) setOnInsert.authVersion = 1;
  const updated = await AuthUserModel.findOneAndUpdate(
    { governanceWalletAddress: walletAddress },
    {
      $set: {
        role: input.role,
        walletAddress,
        governanceWalletAddress: walletAddress,
        governanceSeatSlot: input.governanceSeatSlot,
        accountStatus: 'ACTIVE',
        suspendedReasonCode: null
      },
      ...(roleOrStatusChanged ? { $inc: { authVersion: 1 } } : {}),
      $setOnInsert: setOnInsert
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).lean<AuthUser>().exec();
  if (!updated) throw new Error('Không thể đồng bộ ghế ủy ban từ blockchain.');
  return updated;
}

/** Lưu nonce đăng nhập ví với TTL ngắn để người dùng ký một thông điệp chỉ dùng một lần. */
export async function createWalletLoginNonce(walletAddress: string, expiresAt: Date): Promise<WalletLoginNonce> {
  const record: WalletLoginNonce = {
    id: crypto.randomUUID(),
    walletAddress: walletAddress.toLowerCase(),
    nonce: crypto.randomBytes(32).toString('hex'),
    expiresAt,
    createdAt: new Date()
  };
  const createdRecord = await WalletLoginNonceModel.create(record);
  return createdRecord.toObject() as WalletLoginNonce;
}

/** Đọc nonce còn hạn mà không tiêu thụ trước khi chữ ký được xác minh thành công. */
export async function findWalletLoginNonce(walletAddress: string, nonce: string): Promise<WalletLoginNonce | null> {
  return WalletLoginNonceModel.findOne({
    walletAddress: walletAddress.toLowerCase(),
    nonce,
    expiresAt: { $gt: new Date() }
  }).lean<WalletLoginNonce>().exec();
}

/** Xóa nguyên tử nonce sau khi đã xác minh chữ ký để chặn phát lại và race đăng nhập song song. */
export async function consumeWalletLoginNonce(nonceId: string): Promise<boolean> {
  const deleted = await WalletLoginNonceModel.deleteOne({ id: nonceId, expiresAt: { $gt: new Date() } }).exec();
  return deleted.deletedCount === 1;
}

/**
 * Hàm tìm người dùng theo id.
 * Mục đích: lấy dữ liệu người dùng từ MongoDB theo định danh.
 */
export async function findUserById(userId: string): Promise<AuthUser | null> {
  return AuthUserModel.findOne({ id: userId }).lean<AuthUser>().exec();
}

/** Lấy riêng wallet address theo user ID để kiểm tra quyền sở hữu ví. */
export async function findUserWalletAddressById(userId: string): Promise<string | null> {
  const user = await AuthUserModel.findOne({ id: userId })
    .select('walletAddress')
    .lean<Pick<AuthUser, 'walletAddress'>>()
    .exec();
  return user?.walletAddress || null;
}

/**
 * Hàm lưu mới người dùng.
 * Mục đích: tạo dữ liệu người dùng trong MongoDB.
 */
export async function createUser(user: AuthUser): Promise<AuthUser> {
  const createdUser = await AuthUserModel.create(user);
  return createdUser.toObject() as AuthUser;
}

/** Xoá user vừa tạo khi bước onboarding liên quan thất bại trước khi hoàn tất, tránh để lại tài khoản mồ côi. */
export async function deleteUserById(userId: string): Promise<void> {
  await AuthUserModel.deleteOne({ id: userId }).exec();
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

export const SybilAuditLogModel = mongoose.models?.SybilAuditLog
  || mongoose.model<SybilAuditLogEntry>('SybilAuditLog', sybilAuditLogSchema);

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

/** Lấy batch người dùng theo ID để tránh truy vấn lặp khi dựng danh sách nghiệp vụ. */
export async function findUsersByIds(userIds: string[]): Promise<AuthUser[]> {
  if (!userIds.length) return [];
  return AuthUserModel.find({ id: { $in: [...new Set(userIds)] } }).lean<AuthUser[]>().exec();
}

/** Lấy danh sách ghế Ủy ban Điều hành độc lập cho riêng luồng xét xử F2. */
export async function findActiveExecutiveCommittee(): Promise<AuthUser[]> {
  return AuthUserModel.find({
    role: { $in: ['executive_chair', 'executive_member'] },
    accountStatus: 'ACTIVE',
    isSybil: false
  }).lean<AuthUser[]>().exec();
}

/** Lấy Kiểm toán viên đang hoạt động, loại trừ tài khoản đã bị đánh dấu Sybil. */
export async function findActiveAuditors(): Promise<AuthUser[]> {
  return AuthUserModel.find({
    role: 'auditor',
    accountStatus: 'ACTIVE',
    isSybil: false
  }).lean<AuthUser[]>().exec();
}

/** Đếm Kiểm toán viên có thể thực hiện quyền khiếu nại tại thời điểm niêm yết. */
export async function countActiveAuditors(): Promise<number> {
  return AuthUserModel.countDocuments({
    role: 'auditor',
    accountStatus: 'ACTIVE',
    isSybil: false
  }).exec();
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
