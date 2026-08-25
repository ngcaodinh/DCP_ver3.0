import mongoose, { Schema } from 'mongoose';

export type AuditorPayoutAccount = {
  payoutAccountId: string;
  auditorUserId: string;
  bankName: string;
  bankCode: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const auditorPayoutAccountSchema = new Schema<AuditorPayoutAccount>({
  payoutAccountId: { type: String, required: true, unique: true },
  auditorUserId: { type: String, required: true, unique: true },
  bankName: { type: String, required: true },
  bankCode: { type: String, required: true },
  bankAccountNumber: { type: String, required: true },
  accountHolderName: { type: String, required: true },
  branchName: { type: String, default: null }
}, { timestamps: true });

// Chỉ áp dụng unique với hai trường hợp lệ để dữ liệu cũ thiếu thông tin không tạo collision giả.
const payoutAccountPartialFilter = { $type: 'string', $gt: '' };
auditorPayoutAccountSchema.index(
  { bankAccountNumber: 1, bankName: 1 },
  Object.assign({}, { unique: true }, {
    partialFilterExpression: {
      bankAccountNumber: payoutAccountPartialFilter,
      bankName: payoutAccountPartialFilter
    }
  })
);

const AuditorPayoutAccountModel = mongoose.models?.AuditorPayoutAccount
  || mongoose.model<AuditorPayoutAccount>('AuditorPayoutAccount', auditorPayoutAccountSchema);

/** Tạo tài khoản nhận tiền duy nhất cho Kiểm toán viên. */
export async function createAuditorPayoutAccount(account: AuditorPayoutAccount): Promise<AuditorPayoutAccount> {
  const createdAccount = await AuditorPayoutAccountModel.create(account);
  return createdAccount.toObject() as AuditorPayoutAccount;
}

/** Tìm tài khoản nhận tiền của một Kiểm toán viên mà không đưa vào AuthUser phổ biến. */
export async function findAuditorPayoutAccountByUserId(userId: string): Promise<AuditorPayoutAccount | null> {
  return AuditorPayoutAccountModel.findOne({ auditorUserId: userId }).lean<AuditorPayoutAccount>().exec();
}

/** Kiểm tra trước cặp ngân hàng/số tài khoản đã tồn tại để trả lỗi nghiệp vụ thân thiện trước unique index. */
export async function findAuditorPayoutAccountByBankIdentity(
  bankName: string,
  bankAccountNumber: string
): Promise<AuditorPayoutAccount | null> {
  return AuditorPayoutAccountModel.findOne({ bankName, bankAccountNumber })
    .lean<AuditorPayoutAccount>()
    .exec();
}

/** Cập nhật tài khoản nhận tiền sau khi service đã kiểm tra lock ví và tính duy nhất của cặp ngân hàng/số tài khoản. */
export async function updateAuditorPayoutAccount(
  auditorUserId: string,
  patch: Pick<AuditorPayoutAccount, 'bankName' | 'bankCode' | 'bankAccountNumber' | 'accountHolderName' | 'branchName'>
): Promise<AuditorPayoutAccount | null> {
  const updated = await AuditorPayoutAccountModel.findOneAndUpdate(
    { auditorUserId },
    { $set: patch },
    { returnDocument: 'after' }
  ).exec();
  return updated ? updated.toObject() as AuditorPayoutAccount : null;
}

/** Xoá bản ghi payout vừa tạo khi tạo AuthUser gặp lỗi cạnh tranh email, tránh giữ nhầm số tài khoản. */
export async function deleteAuditorPayoutAccountById(payoutAccountId: string): Promise<void> {
  await AuditorPayoutAccountModel.deleteOne({ payoutAccountId }).exec();
}
