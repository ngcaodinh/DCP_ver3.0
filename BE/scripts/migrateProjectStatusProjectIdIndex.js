const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const collectionName = 'projects';
const indexName = 'status_1_projectId_1';

/** Đọc cấu hình DB bắt buộc để index không vô tình được tạo ở môi trường khác. */
function getRequiredEnvironmentVariable(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${name}`);
  return value;
}

/** Tạo index cursor idempotent và in lại thông tin để vận hành đối chiếu. */
async function runMigration() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
  const collection = mongoose.connection.collection(collectionName);
  await collection.createIndex({ status: 1, projectId: 1 }, { name: indexName });
  const index = (await collection.indexes()).find(item => item.name === indexName);
  if (!index || JSON.stringify(index.key) !== JSON.stringify({ status: 1, projectId: 1 })) {
    throw new Error(`Không thể xác minh index ${indexName}.`);
  }
  console.log(JSON.stringify({ collection: collectionName, index: indexName, key: index.key }));
}

runMigration()
  .catch(error => { console.error('Migration project status/projectId index thất bại:', error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
