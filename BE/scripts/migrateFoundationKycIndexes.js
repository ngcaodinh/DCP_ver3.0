/* eslint-disable @typescript-eslint/no-require-imports */
const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const collectionName = 'organizationkycsubmissions';
const foundationKycIndexName = 'organizationCategory_1_legalRegistrationNumber_1';

/** Lấy biến môi trường bắt buộc cho migration. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) throw new Error(`Thiếu biến môi trường: ${variableName}`);
  return variableValue;
}

/** Kết nối MongoDB theo cùng convention với các migration hiện có. */
async function connectToMongoDatabase() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
}

/** In index trước và sau migration để vận hành có thể đối chiếu idempotency. */
async function logCollectionIndexes(stageLabel) {
  const indexList = await mongoose.connection.collection(collectionName).indexes();
  console.log(`\n[${stageLabel}] Danh sach index cua ${collectionName}:`);
  indexList.forEach((indexItem) => {
    console.log(`- name=${indexItem.name} key=${JSON.stringify(indexItem.key)} unique=${Boolean(indexItem.unique)}`);
  });
}

/** Tạo index tra cứu FOUNDATION không unique để không chặn retry sau lỗi hệ thống. */
async function createFoundationKycIndex() {
  await mongoose.connection.collection(collectionName).createIndex(
    { organizationCategory: 1, legalRegistrationNumber: 1 },
    { name: foundationKycIndexName }
  );
  console.log(`[DONE] Da tao/giu nguyen index ${foundationKycIndexName}.`);
}

/** Chạy migration idempotent và luôn đóng kết nối MongoDB. */
async function runMigration() {
  await connectToMongoDatabase();
  await logCollectionIndexes('BEFORE_MIGRATION');
  await createFoundationKycIndex();
  await logCollectionIndexes('AFTER_MIGRATION');
}

runMigration()
  .then(() => console.log('\nMigration Foundation KYC index thanh cong.'))
  .catch((error) => {
    console.error('\nMigration Foundation KYC index that bai:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
