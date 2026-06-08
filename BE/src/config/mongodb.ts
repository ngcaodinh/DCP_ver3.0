import mongoose from 'mongoose';
import { getLogger } from './logger';

type MongoDbConfig = {
  connectionUri: string;
  databaseName?: string;
};

const logger = getLogger();

/**
 * Hàm lấy cấu hình MongoDB từ biến môi trường.
 * Mục đích: đảm bảo có đủ thông tin kết nối trước khi khởi tạo database.
 */
function buildMongoDbConfig(): MongoDbConfig {
  const connectionUri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB_NAME;

  if (!connectionUri) {
    throw new Error('Thiếu cấu hình MongoDB. Kiểm tra MONGODB_URI.');
  }

  return {
    connectionUri,
    databaseName
  };
}

const mongoDbConfig = buildMongoDbConfig();
let cachedConnectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Hàm kết nối MongoDB.
 * Mục đích: khởi tạo kết nối một lần và tái sử dụng xuyên suốt ứng dụng.
 */
export function connectToMongoDb(): Promise<typeof mongoose> {
  if (!cachedConnectionPromise) {
    cachedConnectionPromise = mongoose.connect(mongoDbConfig.connectionUri, {
      dbName: mongoDbConfig.databaseName
    });

    cachedConnectionPromise
      .then(() => {
        logger.info('MongoDB connected successfully.');
      })
      .catch((error: Error) => {
        logger.error('MongoDB connection failed.', { errorMessage: error.message });
      });
  }

  return cachedConnectionPromise;
}

