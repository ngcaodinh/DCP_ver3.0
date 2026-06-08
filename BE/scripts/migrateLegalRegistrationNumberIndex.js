const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

/** Hàm lấy biến môi trường bắt buộc. Mục đích: dừng migration sớm khi thiếu cấu hình kết nối. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/** Hàm kết nối MongoDB. Mục đích: chuẩn bị thao tác migration index trên collection authusers. */
async function connectToMongoDatabase() {
  const mongoDatabaseUri = getRequiredEnvironmentVariable('MONGODB_URI');
  const mongoDatabaseName = String(process.env.MONGODB_DB_NAME || '').trim() || undefined;

  await mongoose.connect(mongoDatabaseUri, { dbName: mongoDatabaseName });
}

/** Hàm lấy collection authusers. Mục đích: thao tác trực tiếp index ở mức collection để migration rõ ràng, an toàn. */
function getAuthUserCollection() {
  return mongoose.connection.collection('authusers');
}

/** Hàm in danh sách index. Mục đích: quan sát trạng thái trước/sau migration để kiểm tra nhanh. */
async function logCollectionIndexes(stageLabel) {
  const authUserCollection = getAuthUserCollection();
  const indexList = await authUserCollection.indexes();

  console.log(`\n[${stageLabel}] Danh sach index cua authusers:`);
  indexList.forEach((indexItem) => {
    console.log(`- name=${indexItem.name} key=${JSON.stringify(indexItem.key)} unique=${Boolean(indexItem.unique)}`);
  });
}

/** Hàm xóa index cũ legalRegistrationNumber_1 nếu tồn tại. Mục đích: loại bỏ unique index gây conflict với giá trị null. */
async function dropLegacyLegalRegistrationNumberIndexIfExists() {
  const authUserCollection = getAuthUserCollection();
  const indexList = await authUserCollection.indexes();
  const legacyIndex = indexList.find((indexItem) => indexItem.name === 'legalRegistrationNumber_1');

  if (!legacyIndex) {
    console.log('[SKIP] Khong tim thay index cu legalRegistrationNumber_1.');
    return;
  }

  await authUserCollection.dropIndex('legalRegistrationNumber_1');
  console.log('[DONE] Da xoa index cu legalRegistrationNumber_1.');
}

/** Hàm tạo partial unique index mới. Mục đích: chỉ enforce unique khi legalRegistrationNumber là chuỗi không rỗng. */
async function createPartialUniqueIndexForLegalRegistrationNumber() {
  const authUserCollection = getAuthUserCollection();

  await authUserCollection.createIndex(
    { legalRegistrationNumber: 1 },
    {
      name: 'legalRegistrationNumber_1',
      unique: true,
      partialFilterExpression: {
        legalRegistrationNumber: { $exists: true, $gt: '' }
      }
    }
  );

  console.log('[DONE] Da tao partial unique index legalRegistrationNumber_1.');
}

/** Hàm chạy migration chính. Mục đích: đồng bộ index legalRegistrationNumber theo chiến lược partial unique an toàn. */
async function runMigration() {
  await connectToMongoDatabase();
  await logCollectionIndexes('BEFORE_MIGRATION');
  await dropLegacyLegalRegistrationNumberIndexIfExists();
  await createPartialUniqueIndexForLegalRegistrationNumber();
  await logCollectionIndexes('AFTER_MIGRATION');
}

runMigration()
  .then(() => {
    console.log('\nMigration legalRegistrationNumber index thanh cong.');
  })
  .catch((error) => {
    console.error('\nMigration legalRegistrationNumber index that bai:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
