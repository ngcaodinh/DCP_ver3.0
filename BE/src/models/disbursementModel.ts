import mongoose, { Schema } from 'mongoose';

/**
 * Trạng thái yêu cầu giải ngân.
 * None: chưa khởi tạo
 * Pending: chờ ký duyệt (yêu cầu 2/3 từ 3 vai trò)
 * Approved: đủ chữ ký, sẵn sàng chuyển khoản
 * Rejected: bị từ chối bởi một vai trò
 * Expired: quá 7 ngày không đủ chữ ký
 * Cancelled: admin cancel thủ công
 * Completed: đã chuyển khoản thành công
 */
export type DisbursementStatus =
  | 'NONE'
  | 'PENDING'
  | 'APPROVED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export type DisbursementRequestMode = 'NORMAL' | 'EMERGENCY';

export type DisbursementTransferStatus =
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED'
  | 'MANUAL_REVIEW';

/**
 * Bản ghi yêu cầu giải ngân trong MongoDB.
 * Đồng bộ với MultisigDisbursement.sol on-chain.
 */
export type DisbursementRecord = {
  requestId: string;                    // UUID hoặc số từ contract
  onChainRequestId: number;             // requestId trên blockchain (uint256)
  projectId: string;                    // projectId dự án
  onChainProjectId: number;             // projectId trên blockchain
  organizationId: string;               // Tổ chức tạo request
  requestMode: DisbursementRequestMode;
  emergencyReason: string | null;
  requiredApprovals: number;
  raisedRatioBpsAtCreation: number;
  beneficiaryWalletAddress: string;      // Địa chỉ ví nhận tiền
  beneficiaryBankAccount: {
    bankName: string;
    bankAccountNumber: string;
    accountHolderName: string;
    branchName?: string;
  };
  amount: number;                       // Số token muốn rút
  usagePurpose: string;                // Mục đích sử dụng khoản giải ngân
  evidenceCid: string;                 // CID IPFS của bằng chứng sử dụng tiền
  status: DisbursementStatus;
  // Tracking chữ ký từ 3 vai trò
  approvals: Array<{
    signerRole: 'ADMIN_SIGNER' | 'ORG_SIGNER' | 'REGULATORY_SIGNER';
    signerUserId: string;
    signerAddress: string;
    transactionHash: string;
    signedAt: Date;
    comment?: string;
  }>;
  rejection: {
    signerRole: string;
    signerUserId: string;
    signerAddress: string;
    reason: string;
    rejectedAt: Date;
  } | null;
  timeoutDeadline: Date | null;
  payosTransferId: string | null;      // PayOS transfer ID khi thực hiện chuyển khoản
  payosTransferStatus: DisbursementTransferStatus | null;
  payosTransferAttemptCount: number;
  payosTransferLastError: string | null;
  transferIdempotencyKey: string | null;
  transactionHash: string | null;      // Hash giao dịch burn token trên blockchain
  finalizeTransactionHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date | null;              // Thời điểm hết hạn (createdAt + 7 ngày)
  completedAt: Date | null;
};

const approvalSchema = new Schema({
  signerRole: { type: String, required: true },
  signerUserId: { type: String, required: true },
  signerAddress: { type: String, required: true },
  transactionHash: { type: String, required: true },
  signedAt: { type: Date, required: true },
  comment: { type: String, default: null }
}, { _id: false });

const rejectionSchema = new Schema({
  signerRole: { type: String, required: true },
  signerUserId: { type: String, required: true },
  signerAddress: { type: String, required: true },
  reason: { type: String, required: true },
  rejectedAt: { type: Date, required: true }
}, { _id: false });

const disbursementSchema = new Schema<DisbursementRecord>({
  requestId: { type: String, required: true, unique: true },
  onChainRequestId: { type: Number, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  onChainProjectId: { type: Number, required: true },
  organizationId: { type: String, required: true, index: true },
  requestMode: { type: String, required: true, enum: ['NORMAL', 'EMERGENCY'] },
  emergencyReason: { type: String, default: null },
  requiredApprovals: { type: Number, required: true },
  raisedRatioBpsAtCreation: { type: Number, required: true },
  beneficiaryWalletAddress: { type: String, required: true },
  beneficiaryBankAccount: {
    bankName: { type: String, required: true },
    bankAccountNumber: { type: String, required: true },
    accountHolderName: { type: String, required: true },
    branchName: { type: String, default: null }
  },
  amount: { type: Number, required: true },
  usagePurpose: { type: String, required: true, trim: true },
  evidenceCid: { type: String, required: true },
  status: { type: String, required: true, index: true },
  approvals: { type: [approvalSchema], default: [] },
  rejection: { type: rejectionSchema, default: null },
  timeoutDeadline: { type: Date, default: null },
  payosTransferId: { type: String, default: null },
  payosTransferStatus: { type: String, default: null },
  payosTransferAttemptCount: { type: Number, default: 0 },
  payosTransferLastError: { type: String, default: null },
  transferIdempotencyKey: { type: String, default: null },
  transactionHash: { type: String, default: null },
  finalizeTransactionHash: { type: String, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  expiredAt: { type: Date, default: null },
  completedAt: { type: Date, default: null }
});

// Index phục vụ query nhanh theo org và project
disbursementSchema.index({ organizationId: 1, projectId: 1 });
disbursementSchema.index({ beneficiaryWalletAddress: 1 });
disbursementSchema.index({ status: 1, createdAt: -1 });
disbursementSchema.index({ payosTransferId: 1 }, { sparse: true });

const DisbursementMongoModel = mongoose.model<DisbursementRecord>('Disbursement', disbursementSchema);

// ============ CRUD FUNCTIONS ============

/** Chuẩn hóa payload cập nhật. Mục đích: tránh ghi trùng updatedAt gây xung đột MongoDB. */
function buildDisbursementUpdatePayload(payload: Partial<DisbursementRecord>): Partial<DisbursementRecord> {
  const { updatedAt: _ignoredUpdatedAt, ...safePayload } = payload;
  return {
    ...safePayload,
    updatedAt: new Date()
  };
}

/** Tìm bản ghi theo requestId. Mục đích: truy vấn chi tiết một yêu cầu giải ngân. */
export async function findDisbursementByRequestId(requestId: string): Promise<DisbursementRecord | null> {
  return DisbursementMongoModel.findOne({ requestId }).lean<DisbursementRecord>().exec();
}

/** Tìm bản ghi theo onChainRequestId. Mục đích: đồng bộ on-chain event với record off-chain. */
export async function findDisbursementByOnChainRequestId(onChainRequestId: number): Promise<DisbursementRecord | null> {
  return DisbursementMongoModel.findOne({ onChainRequestId }).lean<DisbursementRecord>().exec();
}

/** Tìm bản ghi theo payosTransferId. Mục đích: xử lý callback hoặc đối soát transfer từ cổng thanh toán. */
export async function findDisbursementByPayosTransferId(payosTransferId: string): Promise<DisbursementRecord | null> {
  return DisbursementMongoModel.findOne({ payosTransferId }).lean<DisbursementRecord>().exec();
}

/** Tìm các yêu cầu giải ngân theo trạng thái. Mục đích: phục vụ dashboard ký duyệt. */
export async function findDisbursementsByStatus(status: DisbursementStatus): Promise<DisbursementRecord[]> {
  return DisbursementMongoModel.find({ status }).sort({ createdAt: -1 }).lean<DisbursementRecord[]>().exec();
}

/**
 * Hàm lấy danh sách yêu cầu giải ngân mới nhất.
 * Mục đích: cung cấp dữ liệu thật cho timeline và audit log trên dashboard admin.
 */
export async function findLatestDisbursements(limitCount: number): Promise<DisbursementRecord[]> {
  const normalizedLimitCount = Number.isFinite(limitCount)
    ? Math.max(1, Math.min(200, Math.floor(limitCount)))
    : 20;

  return DisbursementMongoModel.find({})
    .sort({ updatedAt: -1 })
    .limit(normalizedLimitCount)
    .lean<DisbursementRecord[]>()
    .exec();
}

/** Tìm các yêu cầu giải ngân theo projectId. Mục đích: xem lịch sử giải ngân dự án. */
export async function findDisbursementsByProjectId(projectId: string): Promise<DisbursementRecord[]> {
  return DisbursementMongoModel.find({ projectId }).sort({ createdAt: -1 }).lean<DisbursementRecord[]>().exec();
}

/** Tìm các yêu cầu giải ngân theo organizationId. Mục đích: trang quản lý của tổ chức. */
export async function findDisbursementsByOrganizationId(organizationId: string): Promise<DisbursementRecord[]> {
  return DisbursementMongoModel.find({ organizationId }).sort({ createdAt: -1 }).lean<DisbursementRecord[]>().exec();
}

/** Tìm yêu cầu PENDING theo beneficiary wallet. Mục đích: enforce chỉ 1 request pending mỗi beneficiary. */
export async function findPendingDisbursementByBeneficiary(beneficiaryWalletAddress: string): Promise<DisbursementRecord | null> {
  return DisbursementMongoModel.findOne({
    beneficiaryWalletAddress,
    status: 'PENDING'
  }).lean<DisbursementRecord>().exec();
}

/** Tạo mới bản ghi giải ngân. Mục đích: lưu yêu cầu rút tiền vào MongoDB. */
export async function createDisbursementRecord(record: DisbursementRecord): Promise<DisbursementRecord> {
  const created = await DisbursementMongoModel.create(record);
  return created.toObject() as DisbursementRecord;
}

/** Cập nhật bản ghi giải ngân theo requestId. Mục đích: cập nhật trạng thái và chữ ký. */
export async function updateDisbursementByRequestId(
  requestId: string,
  payload: Partial<DisbursementRecord>
): Promise<DisbursementRecord | null> {
  const updated = await DisbursementMongoModel.findOneAndUpdate(
    { requestId },
    { $set: buildDisbursementUpdatePayload(payload) },
    { returnDocument: 'after' }
  ).exec();
  return updated ? (updated.toObject() as DisbursementRecord) : null;
}

/** Cập nhật bản ghi theo requestId và điều kiện. Mục đích: tạo lock idempotency khi xử lý auto-transfer. */
export async function updateDisbursementByRequestIdWithCondition(
  requestId: string,
  condition: Record<string, unknown>,
  payload: Partial<DisbursementRecord>
): Promise<DisbursementRecord | null> {
  const updated = await DisbursementMongoModel.findOneAndUpdate(
    { requestId, ...condition },
    { $set: buildDisbursementUpdatePayload(payload) },
    { returnDocument: 'after' }
  ).exec();

  return updated ? (updated.toObject() as DisbursementRecord) : null;
}

/** Đếm số bản ghi theo trạng thái. Mục đích: thống kê dashboard. */
export async function countDisbursementsByStatus(status: DisbursementStatus): Promise<number> {
  return DisbursementMongoModel.countDocuments({ status }).exec();
}
