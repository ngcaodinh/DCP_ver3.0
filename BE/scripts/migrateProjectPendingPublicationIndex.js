const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const COLLECTION_NAME = 'projects';
const INDEX_KEY = { status: 1, activationEligibleAt: 1, projectId: 1 };
const INDEX_NAME = 'status_1_activationEligibleAt_1_projectId_1';

/** Đọc biến kết nối bắt buộc để migration không vô tình chạy nhầm database. */
function getRequiredEnvironmentVariable(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${name}`);
  return value;
}

/** Tạo idempotent và xác minh index cursor queue trước khi production nhận traffic portal. */
async function ensureProjectPendingPublicationIndex() {
  const collection = mongoose.connection.collection(COLLECTION_NAME);
  await collection.createIndex(INDEX_KEY);
  const index = (await collection.indexes()).find(item => item.name === INDEX_NAME);
  if (!index || JSON.stringify(index.key) !== JSON.stringify(INDEX_KEY)) {
    throw new Error(`Không thể xác minh index ${INDEX_NAME}.`);
  }
  return { collection: COLLECTION_NAME, index: INDEX_NAME, key: index.key };
}

/** Kết nối DB và in kết quả để operator đối chiếu rollout. */
async function runMigration() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
  const result = await ensureProjectPendingPublicationIndex();
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  runMigration()
    .catch(error => { console.error('Migration project pending-publication index thất bại:', error.message); process.exitCode = 1; })
    .finally(async () => { await mongoose.disconnect(); });
}

module.exports = { COLLECTION_NAME, INDEX_KEY, INDEX_NAME, ensureProjectPendingPublicationIndex, getRequiredEnvironmentVariable };
