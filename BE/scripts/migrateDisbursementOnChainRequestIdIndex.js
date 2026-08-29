const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const collectionName = 'disbursements';
const indexName = 'onChainRequestId_1';
const indexKey = { onChainRequestId: 1 };

/** Đọc cấu hình DB bắt buộc để migration không thể chạy nhầm môi trường. */
function getRequiredEnvironmentVariable(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${name}`);
  return value;
}

/** Không thay index khi dữ liệu có request id on-chain trùng, vì sẽ che giấu sai lệch chain–Mongo. */
async function assertNoDuplicateOnChainRequestIds(collection) {
  const duplicates = await collection.aggregate([
    { $match: { onChainRequestId: { $exists: true, $ne: null } } },
    { $group: { _id: '$onChainRequestId', count: { $sum: 1 }, recordIds: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 }
  ]).toArray();

  if (duplicates.length > 0) {
    throw new Error(`Phát hiện onChainRequestId trùng: ${JSON.stringify(duplicates)}. Hãy xử lý dữ liệu trước khi chạy migration.`);
  }
}

/** Thay unique index legacy bằng sparse unique index, để các record lịch sử chưa materialize từ chain không xung đột null. */
async function ensureSparseUniqueIndex(collection) {
  const currentIndex = (await collection.indexes()).find(index => index.name === indexName);
  if (currentIndex) {
    if (JSON.stringify(currentIndex.key) !== JSON.stringify(indexKey)) {
      throw new Error(`Index ${indexName} có key không mong đợi: ${JSON.stringify(currentIndex.key)}.`);
    }
    if (currentIndex.unique === true && currentIndex.sparse === true) return currentIndex;
    await collection.dropIndex(indexName);
  }

  await collection.createIndex(indexKey, { name: indexName, unique: true, sparse: true });
  const verifiedIndex = (await collection.indexes()).find(index => index.name === indexName);
  if (!verifiedIndex || JSON.stringify(verifiedIndex.key) !== JSON.stringify(indexKey)
    || verifiedIndex.unique !== true || verifiedIndex.sparse !== true) {
    throw new Error(`Không thể xác minh sparse unique index ${indexName}.`);
  }
  return verifiedIndex;
}

/** Chạy migration theo thứ tự validate dữ liệu rồi mới drop/create index. */
async function runMigration() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
  const collection = mongoose.connection.collection(collectionName);
  await assertNoDuplicateOnChainRequestIds(collection);
  const index = await ensureSparseUniqueIndex(collection);
  console.log(JSON.stringify({ collection: collectionName, index: index.name, key: index.key, unique: index.unique, sparse: index.sparse }));
}

runMigration()
  .catch(error => { console.error('Migration disbursement onChainRequestId index thất bại:', error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
