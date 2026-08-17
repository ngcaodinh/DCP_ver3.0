const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const collectionName = 'beneficiary_feedback';
const indexDefinitions = [
  {
    name: 'uploadedByOrganizationId_1_deletedAt_1_submittedAt_-1_feedbackId_-1',
    key: { uploadedByOrganizationId: 1, deletedAt: 1, submittedAt: -1, feedbackId: -1 }
  },
  {
    name: 'uploadedByOrganizationId_1_deletedAt_1_isFlagged_1_rating_1',
    key: { uploadedByOrganizationId: 1, deletedAt: 1, isFlagged: 1, rating: 1 }
  }
];

/** Lấy biến môi trường bắt buộc để migration không thể chạy nhầm database. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/** Mở kết nối MongoDB theo cùng cấu hình runtime của backend. */
async function connectToMongoDatabase() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
}

/** So sánh key index hiện hữu với định nghĩa index cần triển khai. */
function isSameIndex(existingIndex, indexDefinition) {
  return JSON.stringify(existingIndex.key) === JSON.stringify(indexDefinition.key);
}

/** Tạo index nếu thiếu và chỉ thay thế index cùng tên khi key bị lệch. */
async function ensureIndex(collection, indexDefinition) {
  const existingIndexes = await collection.indexes();
  const existingIndex = existingIndexes.find(index => index.name === indexDefinition.name);
  if (existingIndex && isSameIndex(existingIndex, indexDefinition)) {
    console.log(`[SKIP] Index ${indexDefinition.name} da ton tai.`);
    return;
  }

  if (existingIndex) {
    await collection.dropIndex(indexDefinition.name);
  }

  await collection.createIndex(indexDefinition.key, { name: indexDefinition.name });
  console.log(`[DONE] Da tao index ${indexDefinition.name}.`);
}

/** Đảm bảo cả index phân trang và index phủ aggregate được triển khai idempotent. */
async function ensureIndexes(collection) {
  for (const indexDefinition of indexDefinitions) {
    await ensureIndex(collection, indexDefinition);
  }
}

/** Chạy migration index cho collection beneficiary feedback rồi trả quyền kết nối. */
async function runMigration() {
  await connectToMongoDatabase();
  await ensureIndexes(mongoose.connection.collection(collectionName));
}

runMigration()
  .then(() => {
    console.log('\nMigration beneficiary feedback indexes thanh cong.');
  })
  .catch((error) => {
    console.error('\nMigration beneficiary feedback indexes that bai:', error instanceof Error ? error.name : 'UNKNOWN_ERROR');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
