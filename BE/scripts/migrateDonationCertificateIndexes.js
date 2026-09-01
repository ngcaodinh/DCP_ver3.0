const { config } = require('dotenv');
const mongoose = require('mongoose');

config();
const indexes = [
  [{ chainId: 1, transactionHash: 1 }, { unique: true, name: 'uniq_chain_transaction' }],
  [{ certificateId: 1 }, { unique: true, name: 'uniq_certificate_id' }],
  [{ issuanceStatus: 1, nextFinalityCheckAt: 1 }, { name: 'certificate_finality_reconcile' }],
  [{ issuanceStatus: 1, 'issuanceEmail.status': 1, issuedAt: 1 }, { name: 'certificate_issuance_email_reconcile' }],
  [{ issuanceStatus: 1, 'revocationEmail.status': 1, revokedAt: 1 }, { name: 'certificate_revocation_email_reconcile' }],
  [{ issuanceStatus: 1, reverifyUntilBlock: 1 }, { name: 'certificate_reverify' }]
];

/** Kết nối Mongo theo runtime config để migration chạy đúng database deploy. */
async function runMigration() {
  if (!process.env.MONGODB_URI) throw new Error('Thiếu MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || undefined });
  const collection = mongoose.connection.collection('donationcertificates');
  const existing = await collection.indexes();
  for (const [key, options] of indexes) {
    const found = existing.find(index => index.name === options.name);
    if (found) { console.log(`[SKIP] ${options.name}`); continue; }
    await collection.createIndex(key, options);
    console.log(`[DONE] ${options.name}`);
  }
}

runMigration().catch(error => { console.error(error instanceof Error ? error.message : 'UNKNOWN_ERROR'); process.exitCode = 1; }).finally(() => mongoose.disconnect());
