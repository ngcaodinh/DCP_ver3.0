const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const QUEUE_COLLECTION_NAME = 'manual_review_queue';
const DISBURSEMENT_COLLECTION_NAME = 'disbursements';
const DEFAULT_BATCH_SIZE = 500;

/** Kiểu dependency tối thiểu của hai collection để migration có thể kiểm thử độc lập với Mongo thật. */
function getMigrationCollections() {
  return {
    queueCollection: mongoose.connection.collection(QUEUE_COLLECTION_NAME),
    disbursementCollection: mongoose.connection.collection(DISBURSEMENT_COLLECTION_NAME)
  };
}

/** Lấy biến môi trường bắt buộc để migration không chạy nhầm database. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/** Kết nối MongoDB theo đúng cấu hình vận hành hiện tại của backend. */
async function connectToMongoDatabase() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
}

/** Cập nhật snapshot requestMode theo batch để migration bounded và có thể chạy lặp idempotent. */
async function migrateRequestMode(batchSize = DEFAULT_BATCH_SIZE, collections = getMigrationCollections()) {
  const { queueCollection, disbursementCollection } = collections;
  let lastQueueId = null;
  let updatedCount = 0;

  for (;;) {
    const queueFilter = {
      status: 'PENDING',
      requestMode: { $exists: false },
      ...(lastQueueId ? { _id: { $gt: lastQueueId } } : {})
    };
    const queueItems = await queueCollection
      .find(queueFilter, { projection: { _id: 1, queueId: 1, disbursementRequestId: 1 } })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();

    if (queueItems.length === 0) {
      break;
    }

    const requestIds = queueItems.map(item => item.disbursementRequestId).filter(Boolean);
    const disbursements = await disbursementCollection
      .find(
        { requestId: { $in: requestIds } },
        { projection: { requestId: 1, requestMode: 1 } }
      )
      .toArray();
    const modeByRequestId = new Map(
      disbursements
        .filter(item => item.requestMode === 'NORMAL' || item.requestMode === 'EMERGENCY')
        .map(item => [item.requestId, item.requestMode])
    );
    const operations = queueItems
      .map(item => ({
        queueId: item.queueId,
        requestMode: modeByRequestId.get(item.disbursementRequestId)
      }))
      .filter(item => item.requestMode)
      .map(item => ({
        updateOne: {
          filter: {
            queueId: item.queueId,
            status: 'PENDING',
            requestMode: { $exists: false }
          },
          update: { $set: { requestMode: item.requestMode } }
        }
      }));

    if (operations.length > 0) {
      const result = await queueCollection.bulkWrite(operations, { ordered: false });
      updatedCount += result.modifiedCount;
    }

    lastQueueId = queueItems[queueItems.length - 1]._id;
    console.log(`[INFO] Da quet ${queueItems.length} queue item, cap nhat ${updatedCount} snapshot.`);
  }

  return updatedCount;
}

/** Chạy migration và luôn đóng kết nối để container one-shot thoát sạch. */
async function runMigration() {
  await connectToMongoDatabase();
  const updatedCount = await migrateRequestMode();
  console.log(`\nMigration requestMode thanh cong. So queue item cap nhat: ${updatedCount}.`);
}

/** Chỉ ghi tên lỗi an toàn, không ghi message có thể chứa chuỗi kết nối hoặc credential. */
function getSafeMigrationErrorName(error) {
  return error instanceof Error && error.name ? error.name : 'UNKNOWN_ERROR';
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  getRequiredEnvironmentVariable,
  connectToMongoDatabase,
  getMigrationCollections,
  migrateRequestMode,
  getSafeMigrationErrorName,
  runMigration
};

if (require.main === module) {
  runMigration()
    .catch(error => {
      console.error('\nMigration requestMode that bai:', getSafeMigrationErrorName(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect();
    });
}
