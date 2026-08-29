import mongoose from 'mongoose';
import { getLogger } from './logger';

type RequiredCommitteeGovernanceIndex = {
  collection: string;
  name: string;
  key: Record<string, 1 | -1>;
  unique?: true;
  expireAfterSeconds?: number;
};

type ExistingMongoIndex = {
  name?: string;
  key?: unknown;
  unique?: boolean;
  expireAfterSeconds?: number;
};

/** Xác định lỗi MongoDB khi collection chưa tồn tại, thay vì coi đó là sự cố hạ tầng. */
function isMongoNamespaceNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 26;
}

/** Đọc index của collection; DB chưa migrate trả danh sách rỗng để cùng luồng kiểm tra xử lý. */
async function readCollectionIndexes(collectionName: string): Promise<ExistingMongoIndex[]> {
  try {
    return await mongoose.connection.collection(collectionName).indexes();
  } catch (error: unknown) {
    if (isMongoNamespaceNotFound(error)) return [];
    throw error;
  }
}

const REQUIRED_COMMITTEE_GOVERNANCE_INDEXES: readonly RequiredCommitteeGovernanceIndex[] = [
  { collection: 'technical_signer_execution_locks', name: 'lockName_1', key: { lockName: 1 }, unique: true },
  { collection: 'disbursement_committee_votes', name: 'requestId_1', key: { requestId: 1 }, unique: true },
  { collection: 'disbursement_committee_votes', name: 'committeeVoteId_1', key: { committeeVoteId: 1 }, unique: true },
  { collection: 'committee_vote_signing_requests', name: 'signingRequestId_1', key: { signingRequestId: 1 }, unique: true },
  { collection: 'committee_vote_signing_requests', name: 'deadline_1', key: { deadline: 1 }, expireAfterSeconds: 0 }
];

/** Kiểm tra index tồn tại với đúng key pattern và các option bảo vệ tính đúng đắn. */
function isRequiredIndexConfigured(
  index: ExistingMongoIndex | undefined,
  required: RequiredCommitteeGovernanceIndex
): boolean {
  if (!index || JSON.stringify(index.key) !== JSON.stringify(required.key)) return false;
  if (required.unique === true && index.unique !== true) return false;
  return required.expireAfterSeconds === undefined || index.expireAfterSeconds === required.expireAfterSeconds;
}

/**
 * Xác minh các index gác tính đúng đắn đã tồn tại trước khi worker hoặc HTTP server nhận traffic.
 * Production dừng khởi động để operator chạy migration; môi trường khác chỉ cảnh báo cho phép autoIndex hoàn tất.
 */
export async function verifyRequiredCommitteeGovernanceIndexes(): Promise<void> {
  const indexesByCollection = await Promise.all(
    REQUIRED_COMMITTEE_GOVERNANCE_INDEXES.map(async required => ({
      required,
      indexes: await readCollectionIndexes(required.collection)
    }))
  );
  const invalidIndexes = indexesByCollection
    .filter(({ required, indexes }) => !isRequiredIndexConfigured(
      indexes.find(index => index.name === required.name),
      required
    ))
    .map(({ required }) => `${required.collection}.${required.name}`);
  if (invalidIndexes.length === 0) return;

  const message = `Index CommitteeGovernance bắt buộc thiếu hoặc sai cấu hình: ${invalidIndexes.join(', ')}. Chạy node scripts/migrateCommitteeGovernanceIndexes.js trước khi khởi động.`;
  if (process.env.NODE_ENV === 'production') throw new Error(message);
  getLogger().warn(message);
}
