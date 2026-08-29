import mongoose, { type ClientSession } from 'mongoose';
import { getLogger } from '../config/logger';

type MongoClientTopology = { topology?: { description?: { type?: string } } };

const logger = getLogger();
let standaloneFallbackWarningLogged = false;

/** Xác định topology Mongo có hỗ trợ transaction đa document hay không. */
function supportsMongoTransactions(): boolean {
  try {
    const client = mongoose.connection.getClient() as unknown as MongoClientTopology;
    const topologyType = client.topology?.description?.type;
    return topologyType === 'ReplicaSetWithPrimary' || topologyType === 'Sharded';
  } catch {
    // Không đọc được topology thì vẫn thử transaction để tránh vô tình hạ cấp tính nguyên tử.
    return true;
  }
}

/**
 * Chạy nhóm mutation MongoDB trong transaction khi topology hỗ trợ; standalone dùng mutation tuần tự để local dev không bị lỗi 500.
 * Unit test không mở Mongo connection sẽ chạy callback không session để giữ test thuần logic;
 * production chỉ thực hiện mutation sau khi kết nối đã được bootstrap.
 */
export async function runMongoTransaction<T>(
  work: (session?: ClientSession) => Promise<T>
): Promise<T> {
  if (mongoose.connection.readyState !== 1) {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return work();
    throw new Error('MongoDB connection is required for an atomic mutation.');
  }

  if (!supportsMongoTransactions()) {
    // Mongo standalone không hỗ trợ session transaction; các repository đã nhận session tùy chọn để giữ local dev hoạt động.
    if (!standaloneFallbackWarningLogged) {
      logger.warn('MongoDB không hỗ trợ transaction đa document; đang dùng mutation tuần tự. Production nên chạy replica set hoặc mongos.');
      standaloneFallbackWarningLogged = true;
    }
    return work();
  }

  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}
