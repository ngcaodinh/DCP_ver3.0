const { config } = require('dotenv');
const mongoose = require('mongoose');
const { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } = require('ethers');

config();

const EVENT_SCAN_CHUNK_SIZE = 2_000;
const COMMITTEE_GOVERNANCE_AUDIT_ABI = [
  'event DecisionRecorded(uint8 indexed kind,bytes32 indexed subjectId,bool approved,address[] voters,bytes32 reasonHash)'
];

function requireEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường ${name}.`);
  return value;
}

function getDeploymentBlock() {
  const deploymentBlock = Number(requireEnvironment('COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK'));
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) {
    throw new Error('COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK không hợp lệ.');
  }
  return deploymentBlock;
}

function getSubjectId(requestId) {
  return keccak256(toUtf8Bytes(`DCP:DISBURSEMENT:${requestId}`)).toLowerCase();
}

function getReasonHash(requestId, approved) {
  return keccak256(toUtf8Bytes(
    `DCP Committee DISBURSEMENT decision ${requestId}: ${approved ? 'APPROVED' : 'REJECTED'}. Individual voter rationales are committed in the DCP audit record.`
  )).toLowerCase();
}

/** Quét toàn bộ event theo chunk để RPC không bị vượt log range và không đánh mất lịch sử cũ. */
async function loadDecisionEvents(contract, provider, deploymentBlock) {
  const latestBlock = await provider.getBlockNumber();
  const decisions = new Map();
  for (let fromBlock = deploymentBlock; fromBlock <= latestBlock; fromBlock += EVENT_SCAN_CHUNK_SIZE) {
    const toBlock = Math.min(latestBlock, fromBlock + EVENT_SCAN_CHUNK_SIZE - 1);
    const events = await contract.queryFilter(contract.filters.DecisionRecorded(), fromBlock, toBlock);
    for (const event of events) {
      const kind = Number(event.args[0]);
      if (kind !== 0) continue;
      const subjectId = String(event.args[1]).toLowerCase();
      decisions.set(subjectId, {
        approved: Boolean(event.args[2]),
        reasonHash: String(event.args[4]).toLowerCase(),
        transactionHash: event.transactionHash.toLowerCase(),
        blockNumber: event.blockNumber
      });
    }
  }
  return decisions;
}

async function runAudit() {
  const mongoUri = requireEnvironment('MONGODB_URI');
  const rpcUrl = requireEnvironment('BLOCKCHAIN_RPC_URL');
  const contractAddress = requireEnvironment('COMMITTEE_GOVERNANCE_ADDRESS');
  const deploymentBlock = getDeploymentBlock();
  await mongoose.connect(mongoUri, { dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined });
  const provider = new JsonRpcProvider(rpcUrl);
  const contract = new Contract(contractAddress, COMMITTEE_GOVERNANCE_AUDIT_ABI, provider);
  const eventsBySubject = await loadDecisionEvents(contract, provider, deploymentBlock);
  const records = await mongoose.connection.collection('disbursement_committee_votes').find({
    status: { $in: ['APPROVED', 'REJECTED'] }
  }, {
    projection: { requestId: 1, status: 1, onChainDecisionStatus: 1, onChainDecisionTxHash: 1 }
  }).toArray();
  const discrepancies = [];
  const expectedSubjects = new Set();
  for (const record of records) {
    const approved = record.status === 'APPROVED';
    const subjectId = getSubjectId(record.requestId);
    expectedSubjects.add(subjectId);
    const event = eventsBySubject.get(subjectId);
    if (!event) {
      discrepancies.push({ type: 'MISSING_ON_CHAIN_EVENT', requestId: record.requestId, expectedApproved: approved });
      continue;
    }
    if (event.approved !== approved || event.reasonHash !== getReasonHash(record.requestId, approved)) {
      discrepancies.push({ type: 'EVENT_PAYLOAD_MISMATCH', requestId: record.requestId, event });
      continue;
    }
    if (record.onChainDecisionStatus !== 'RECORDED') {
      discrepancies.push({ type: 'MONGO_RECEIPT_NOT_RECORDED', requestId: record.requestId, transactionHash: event.transactionHash });
      continue;
    }
    if (record.onChainDecisionTxHash && record.onChainDecisionTxHash.toLowerCase() !== event.transactionHash) {
      discrepancies.push({ type: 'TRANSACTION_HASH_MISMATCH', requestId: record.requestId, mongo: record.onChainDecisionTxHash, chain: event.transactionHash });
    }
  }
  for (const [subjectId, event] of eventsBySubject) {
    if (!expectedSubjects.has(subjectId)) discrepancies.push({ type: 'ORPHAN_ON_CHAIN_EVENT', subjectId, event });
  }
  console.log(JSON.stringify({
    auditedMongoDecisions: records.length,
    auditedOnChainDecisions: eventsBySubject.size,
    discrepancyCount: discrepancies.length,
    discrepancies
  }, null, 2));
  if (discrepancies.length > 0) process.exitCode = 2;
}

runAudit()
  .catch(error => { console.error('Audit DecisionRecorded thất bại:', error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
