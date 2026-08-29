const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const AUDITOR_PAYOUT_COLLECTION = 'auditorpayouts';
const AUDITOR_STAKE_INTENT_COLLECTION = 'auditorstakeintents';
const AUDITOR_STAKE_GUARD_COLLECTION = 'auditorstakeguards';
const AUDITOR_STAKE_EVENT_DEAD_LETTER_COLLECTION = 'auditorstakeeventdeadletters';
const AUDITOR_PENALTY_LEDGER_COLLECTION = 'auditorpenaltyledgers';
const PAYOUT_ONCHAIN_TX_HASH_INDEX = 'onchainTxHash_1';
const STAKE_INTENT_TX_HASH_INDEX = 'txHash_1';
const STALE_GUARD_INDEX = 'walletLock_1_lockedAt_1';
const DEAD_LETTER_INDEX = 'chainId_1_contractAddress_1_transactionHash_1_logIndex_1';
const LEGACY_LEDGER_UNIQUE_INDEX = 'fieldReportId_1_entryType_1';
const PENALTY_LEDGER_UNIQUE_INDEX = 'penalty_field_report_unique';
const REWARD_LEDGER_UNIQUE_INDEX = 'reward_field_report_auditor_unique';

/** Lấy biến môi trường bắt buộc để migration không chạy nhầm vào MongoDB chưa được cấu hình. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) throw new Error(`Thiếu biến môi trường: ${variableName}`);
  return variableValue;
}

/** Kết nối đúng database mục tiêu trước khi sửa index của luồng AuditorStaking. */
async function connectToMongoDatabase() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
}

/** Xóa index legacy nếu tồn tại để createIndex bên dưới luôn idempotent và không che lỗi cấu hình. */
async function dropIndexIfExists(collection, indexName) {
  const indexes = await collection.indexes();
  if (!indexes.some(index => index.name === indexName)) return;
  await collection.dropIndex(indexName);
  console.log(`[DONE] Đã xóa index cũ ${collection.collectionName}.${indexName}.`);
}

/** Tạo unique partial index chỉ với transaction hash dạng chuỗi, cho phép nhiều record chưa có hash. */
async function createUniqueStringIndex(collection, fieldName, indexName) {
  await collection.createIndex(
    { [fieldName]: 1 },
    {
      name: indexName,
      unique: true,
      partialFilterExpression: { [fieldName]: { $type: 'string' } }
    }
  );
  console.log(`[DONE] Đã tạo unique partial index ${collection.collectionName}.${indexName}.`);
}

/** Tạo index cho stale-lock sweeper để scheduler không quét toàn collection khi số Auditor tăng. */
async function createStaleGuardIndex(collection) {
  await collection.createIndex(
    { walletLock: 1, lockedAt: 1 },
    { name: STALE_GUARD_INDEX }
  );
  console.log(`[DONE] Đã tạo index ${collection.collectionName}.${STALE_GUARD_INDEX}.`);
}

/** Tạo unique index cho dead-letter để một event lỗi chỉ tạo một hồ sơ vận hành xuyên suốt các lần retry. */
async function createDeadLetterIndex(collection) {
  await collection.createIndex(
    { chainId: 1, contractAddress: 1, transactionHash: 1, logIndex: 1 },
    { name: DEAD_LETTER_INDEX, unique: true }
  );
  console.log(`[DONE] Đã tạo index ${collection.collectionName}.${DEAD_LETTER_INDEX}.`);
}

/** Tách unique key ledger để một biên bản có thể thưởng nhiều Auditor nhưng vẫn chỉ phạt một Auditor. */
async function createAuditorRewardLedgerIndexes(collection) {
  await collection.createIndex(
    { fieldReportId: 1, entryType: 1 },
    { name: PENALTY_LEDGER_UNIQUE_INDEX, unique: true, partialFilterExpression: { entryType: 'PENALTY' } }
  );
  await collection.createIndex(
    { fieldReportId: 1, entryType: 1, auditorUserId: 1 },
    { name: REWARD_LEDGER_UNIQUE_INDEX, unique: true, partialFilterExpression: { entryType: 'REWARD' } }
  );
  console.log(`[DONE] Đã tạo các index unique tách biệt cho REWARD/PENALTY ở ${collection.collectionName}.`);
}

/** Đồng bộ các index AuditorStaking theo schema hiện tại một cách có thể chạy lặp lại an toàn. */
async function runMigration() {
  await connectToMongoDatabase();
  const payoutCollection = mongoose.connection.collection(AUDITOR_PAYOUT_COLLECTION);
  const stakeIntentCollection = mongoose.connection.collection(AUDITOR_STAKE_INTENT_COLLECTION);
  const stakeGuardCollection = mongoose.connection.collection(AUDITOR_STAKE_GUARD_COLLECTION);
  const deadLetterCollection = mongoose.connection.collection(AUDITOR_STAKE_EVENT_DEAD_LETTER_COLLECTION);
  const ledgerCollection = mongoose.connection.collection(AUDITOR_PENALTY_LEDGER_COLLECTION);

  await dropIndexIfExists(payoutCollection, PAYOUT_ONCHAIN_TX_HASH_INDEX);
  await dropIndexIfExists(stakeIntentCollection, STAKE_INTENT_TX_HASH_INDEX);
  await createUniqueStringIndex(payoutCollection, 'onchainTxHash', PAYOUT_ONCHAIN_TX_HASH_INDEX);
  await createUniqueStringIndex(stakeIntentCollection, 'txHash', STAKE_INTENT_TX_HASH_INDEX);
  await createStaleGuardIndex(stakeGuardCollection);
  await createDeadLetterIndex(deadLetterCollection);
  await dropIndexIfExists(ledgerCollection, LEGACY_LEDGER_UNIQUE_INDEX);
  await createAuditorRewardLedgerIndexes(ledgerCollection);
}

runMigration()
  .then(() => {
    console.log('Migration AuditorStaking indexes thành công.');
  })
  .catch(error => {
    console.error('Migration AuditorStaking indexes thất bại:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
