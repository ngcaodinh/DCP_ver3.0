const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const organizationKycSubmissionCollectionName = 'organizationkycsubmissions';
const legacyBankAccountNumberIndexName = 'beneficiaryBankAccount.bankAccountNumber_1';
const compoundBankAccountIndexName = 'beneficiaryBankAccount.bankAccountNumber_1_beneficiaryBankAccount.bankName_1';

/** Hàm lấy biến môi trường bắt buộc. Mục đích: dừng migration sớm khi thiếu cấu hình kết nối. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/** Hàm kết nối MongoDB. Mục đích: chuẩn bị thao tác migration index trên collection organizationkycsubmissions. */
async function connectToMongoDatabase() {
  const mongoDatabaseUri = getRequiredEnvironmentVariable('MONGODB_URI');
  const mongoDatabaseName = String(process.env.MONGODB_DB_NAME || '').trim() || undefined;

  await mongoose.connect(mongoDatabaseUri, { dbName: mongoDatabaseName });
}

/** Hàm lấy collection organizationkycsubmissions. Mục đích: thao tác trực tiếp index để migration rõ ràng, an toàn. */
function getOrganizationKycSubmissionCollection() {
  return mongoose.connection.collection(organizationKycSubmissionCollectionName);
}

/** Hàm in danh sách index. Mục đích: quan sát trạng thái trước/sau migration để kiểm tra nhanh. */
async function logCollectionIndexes(stageLabel) {
  const organizationKycSubmissionCollection = getOrganizationKycSubmissionCollection();
  const indexList = await organizationKycSubmissionCollection.indexes();

  console.log(`\n[${stageLabel}] Danh sach index cua ${organizationKycSubmissionCollectionName}:`);
  indexList.forEach((indexItem) => {
    console.log(`- name=${indexItem.name} key=${JSON.stringify(indexItem.key)} unique=${Boolean(indexItem.unique)}`);
  });
}

/** Hàm xóa index cũ theo số tài khoản nếu tồn tại. Mục đích: bỏ ràng buộc chỉ kiểm tra trùng số tài khoản. */
async function dropLegacyBankAccountNumberIndexIfExists() {
  const organizationKycSubmissionCollection = getOrganizationKycSubmissionCollection();
  const indexList = await organizationKycSubmissionCollection.indexes();
  const legacyIndex = indexList.find((indexItem) => indexItem.name === legacyBankAccountNumberIndexName);

  if (!legacyIndex) {
    console.log(`[SKIP] Khong tim thay index cu ${legacyBankAccountNumberIndexName}.`);
    return;
  }

  await organizationKycSubmissionCollection.dropIndex(legacyBankAccountNumberIndexName);
  console.log(`[DONE] Da xoa index cu ${legacyBankAccountNumberIndexName}.`);
}

/** Hàm tạo compound unique index mới. Mục đích: chỉ chặn trùng khi đồng thời trùng số tài khoản và tên ngân hàng. */
async function createCompoundUniqueIndexForBankAccount() {
  const organizationKycSubmissionCollection = getOrganizationKycSubmissionCollection();

  await organizationKycSubmissionCollection.createIndex(
    {
      'beneficiaryBankAccount.bankAccountNumber': 1,
      'beneficiaryBankAccount.bankName': 1
    },
    {
      name: compoundBankAccountIndexName,
      unique: true,
      partialFilterExpression: {
        'beneficiaryBankAccount.bankAccountNumber': { $exists: true, $gt: '' },
        'beneficiaryBankAccount.bankName': { $exists: true, $gt: '' }
      }
    }
  );

  console.log(`[DONE] Da tao compound unique index ${compoundBankAccountIndexName}.`);
}

/** Hàm chạy migration chính. Mục đích: đồng bộ index tài khoản ngân hàng theo rule mới. */
async function runMigration() {
  await connectToMongoDatabase();
  await logCollectionIndexes('BEFORE_MIGRATION');
  await dropLegacyBankAccountNumberIndexIfExists();
  await createCompoundUniqueIndexForBankAccount();
  await logCollectionIndexes('AFTER_MIGRATION');
}

runMigration()
  .then(() => {
    console.log('\nMigration bank account index thanh cong.');
  })
  .catch((error) => {
    console.error('\nMigration bank account index that bai:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
