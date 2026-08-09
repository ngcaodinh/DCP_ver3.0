const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const collectionName = 'manual_review_queue';
const indexDefinitions = [
  {
    name: 'disbursementRequestId_1_reviewCycle_1',
    key: { disbursementRequestId: 1, reviewCycle: 1 },
    unique: true
  },
  {
    name: 'assignedAdminId_1_status_1_createdAt_1',
    key: { assignedAdminId: 1, status: 1, createdAt: 1 }
  },
  {
    name: 'projectId_1_status_1',
    key: { projectId: 1, status: 1 }
  },
  {
    name: 'status_1_slaDeadline_1',
    key: { status: 1, slaDeadline: 1 }
  },
  {
    name: 'status_1_requestMode_1_createdAt_-1',
    key: { status: 1, requestMode: 1, createdAt: -1 }
  },
  {
    name: 'retentionExpiresAt_1',
    key: { retentionExpiresAt: 1 },
    expireAfterSeconds: 0
  }
];

function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

async function connectToMongoDatabase() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
}

function isSameIndex(existingIndex, definition) {
  return JSON.stringify(existingIndex.key) === JSON.stringify(definition.key)
    && Boolean(existingIndex.unique) === Boolean(definition.unique)
    && (definition.expireAfterSeconds === undefined
      || existingIndex.expireAfterSeconds === definition.expireAfterSeconds);
}

async function ensureIndex(collection, definition) {
  const existingIndexes = await collection.indexes();
  const existingIndex = existingIndexes.find(index => index.name === definition.name);
  if (existingIndex && isSameIndex(existingIndex, definition)) {
    console.log(`[SKIP] Index ${definition.name} da ton tai.`);
    return;
  }

  if (existingIndex) {
    await collection.dropIndex(definition.name);
    console.log(`[DONE] Da xoa index cu ${definition.name}.`);
  }

  await collection.createIndex(definition.key, {
    name: definition.name,
    ...(definition.unique ? { unique: true } : {}),
    ...(definition.expireAfterSeconds !== undefined
      ? { expireAfterSeconds: definition.expireAfterSeconds }
      : {})
  });
  console.log(`[DONE] Da tao index ${definition.name}.`);
}

async function runMigration() {
  await connectToMongoDatabase();
  const collection = mongoose.connection.collection(collectionName);
  for (const definition of indexDefinitions) {
    await ensureIndex(collection, definition);
  }
}

runMigration()
  .then(() => {
    console.log('\nMigration manual review queue indexes thanh cong.');
  })
  .catch((error) => {
    console.error('\nMigration manual review queue indexes that bai:', error instanceof Error ? error.name : 'UNKNOWN_ERROR');
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
