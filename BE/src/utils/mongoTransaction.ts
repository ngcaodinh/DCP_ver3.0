import mongoose, { type ClientSession } from 'mongoose';

/**
 * Chạy nhóm mutation MongoDB trong transaction khi kết nối đã sẵn sàng.
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
