const { config } = require('dotenv');
const mongoose = require('mongoose');

const INDEXES = [
  { collection: 'technical_signer_execution_locks', key: { lockName: 1 }, options: { unique: true } },
  { collection: 'disbursement_committee_votes', key: { requestId: 1 }, options: { unique: true } },
  { collection: 'disbursement_committee_votes', key: { committeeVoteId: 1 }, options: { unique: true } },
  { collection: 'committee_vote_signing_requests', key: { signingRequestId: 1 }, options: { unique: true } },
  { collection: 'committee_vote_signing_requests', key: { deadline: 1 }, options: { expireAfterSeconds: 0 } },
  { collection: 'disbursement_committee_votes', key: { status: 1, onChainDecisionStatus: 1, onChainDecisionNextAttemptAt: 1, resolvedAt: 1 }, options: {} },
  { collection: 'project_arbitrations', key: { status: 1, onChainDecisionStatus: 1, onChainDecisionNextAttemptAt: 1, resolvedAt: 1 }, options: {} },
  { collection: 'public_committee_governance_events', key: { chainId: 1, contractAddress: 1, transactionHash: 1, logIndex: 1 }, options: { unique: true } },
  { collection: 'public_committee_governance_events', key: { chainId: 1, contractAddress: 1, blockNumber: -1, logIndex: -1 }, options: {} }
];

/** Trả tên mặc định MongoDB/Mongoose tạo từ key để xác minh index không bị lệch tên. */
function getDefaultIndexName(key) {
  return Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join('_');
}

/** Đọc cấu hình DB bắt buộc để migration index không chạy nhầm vào môi trường mặc định. */
function getRequiredEnvironmentVariable(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${name}`);
  return value;
}

/** Tạo và xác minh từng index idempotent để TTL, retry queue và public read model có hiệu lực trước rollout. */
async function ensureIndex(specification) {
  const collection = mongoose.connection.collection(specification.collection);
  await collection.createIndex(specification.key, specification.options);
  const indexName = getDefaultIndexName(specification.key);
  const index = (await collection.indexes()).find(candidate => candidate.name === indexName);
  if (!index || JSON.stringify(index.key) !== JSON.stringify(specification.key)) {
    throw new Error(`Không thể xác minh index ${indexName} trên ${specification.collection}.`);
  }
  if (specification.options.unique === true && index.unique !== true) {
    throw new Error(`Unique index ${indexName} không đúng cấu hình.`);
  }
  if (specification.options.expireAfterSeconds !== undefined && index.expireAfterSeconds !== specification.options.expireAfterSeconds) {
    throw new Error(`TTL index ${indexName} có expireAfterSeconds không đúng.`);
  }
  return { collection: specification.collection, index: index.name, key: index.key };
}

/** Chạy migration index theo một kết nối duy nhất và in kết quả để operator đối soát ngay sau deploy. */
async function runMigration() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
  const results = [];
  for (const specification of INDEXES) results.push(await ensureIndex(specification));
  console.log(JSON.stringify(results));
}

module.exports = { INDEXES, ensureIndex, getDefaultIndexName, runMigration };

if (require.main === module) {
  config();
  runMigration()
    .catch(error => { console.error('Migration CommitteeGovernance indexes thất bại:', error.message); process.exitCode = 1; })
    .finally(async () => { await mongoose.disconnect(); });
}
