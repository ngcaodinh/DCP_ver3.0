import mongoose, { Schema } from 'mongoose';

export type GovernanceBootstrapState = {
  stateKey: 'committee-governance';
  transactionHash: string;
  contractAddress: string;
  chainId: string;
  seats: Array<{ walletAddress: string; role: 'executive_chair' | 'executive_member' }>;
  verifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const governanceBootstrapStateSchema = new Schema<GovernanceBootstrapState>({
  stateKey: { type: String, required: true, unique: true, enum: ['committee-governance'] },
  transactionHash: { type: String, required: true, lowercase: true },
  contractAddress: { type: String, required: true, lowercase: true },
  chainId: { type: String, required: true },
  seats: {
    type: [{
      walletAddress: { type: String, required: true, lowercase: true },
      role: { type: String, required: true, enum: ['executive_chair', 'executive_member'] }
    }],
    required: true,
    validate: [(value: unknown[]) => value.length === 5, 'Bootstrap phải có đúng năm ghế.']
  },
  verifiedAt: { type: Date, required: true }
}, { timestamps: true });

const GovernanceBootstrapStateMongoModel = mongoose.models?.GovernanceBootstrapState
  || mongoose.model<GovernanceBootstrapState>('GovernanceBootstrapState', governanceBootstrapStateSchema);

/** Lưu proof đã tự xác minh từ chain theo singleton để restart không quay lại tin dữ liệu client. */
export async function upsertVerifiedGovernanceBootstrapState(
  state: Omit<GovernanceBootstrapState, 'stateKey' | 'createdAt' | 'updatedAt'>
): Promise<GovernanceBootstrapState> {
  const result = await GovernanceBootstrapStateMongoModel.findOneAndUpdate(
    { stateKey: 'committee-governance' },
    { $set: { ...state, stateKey: 'committee-governance' } },
    { upsert: true, returnDocument: 'after', runValidators: true }
  ).lean<GovernanceBootstrapState>().exec();
  if (!result) throw new Error('Không thể lưu trạng thái bootstrap Ủy ban.');
  return result;
}

/** Đọc proof bootstrap đã được server xác minh để API/UI có thể hiển thị nguồn tin cậy. */
export async function findVerifiedGovernanceBootstrapState(): Promise<GovernanceBootstrapState | null> {
  return GovernanceBootstrapStateMongoModel.findOne({ stateKey: 'committee-governance' })
    .lean<GovernanceBootstrapState>()
    .exec();
}
