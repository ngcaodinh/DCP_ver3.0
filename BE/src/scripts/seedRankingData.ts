import 'dotenv/config';
import mongoose from 'mongoose';
import { connectToMongoDb } from '../config/mongodb';
import { connectToRedisSafely } from '../config/redis';
import { getRankingQueue } from '../queues/rankingQueue';
import { startRankingWorker } from '../workers/rankingWorker';

/**
 * Script seed dữ liệu demo cho ranking QF.
 * Mục đích: tạo dữ liệu donation và project để test bảng xếp hạng khi chưa có donation thật.
 * Cách chạy: npx ts-node --project tsconfig.json src/scripts/seedRankingData.ts
 */

// Demo projects
const demoProjectList = [
  { projectId: 'PRJ-1001', name: 'Giáo dục vùng cao', organizationId: 'Tổ chức Hòa Bình', status: 'ACTIVE', goalAmount: 50_000_000 },
  { projectId: 'PRJ-1002', name: 'Nước sạch nông thôn', organizationId: 'Hội Chữ Thập Đỏ', status: 'ACTIVE', goalAmount: 30_000_000 },
  { projectId: 'PRJ-1003', name: 'Y tế cho người nghèo', organizationId: 'Quỹ Từ Thiện Việt', status: 'ACTIVE', goalAmount: 80_000_000 },
  { projectId: 'PRJ-1004', name: 'Bảo vệ rừng ngập mặn', organizationId: 'Hội Bảo vệ Môi trường', status: 'ACTIVE', goalAmount: 25_000_000 },
  { projectId: 'PRJ-1005', name: 'Hỗ trợ trẻ em mồ côi', organizationId: 'Quỹ Bông Sen', status: 'ACTIVE', goalAmount: 40_000_000 },
  { projectId: 'PRJ-1006', name: 'Công nghệ cho trường học', organizationId: 'Tổ chức Giáo dục Số', status: 'ACTIVE', goalAmount: 60_000_000 }
];

// Demo donors (wallet addresses)
const demoDonorList = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555',
  '0x6666666666666666666666666666666666666666',
  '0x7777777777777777777777777777777777777777',
  '0x8888888888888888888888888888888888888888'
];

/** Hàm seed schema project. Mục đích: tạo collection project nếu chưa có. */
async function ensureProjectCollection(): Promise<void> {
  const collectionName = 'projects';
  const collections = await mongoose.connection.db?.listCollections({ name: collectionName }).toArray();
  if (!collections?.length) {
    await mongoose.connection.db?.createCollection(collectionName);
  }

  const projectSchema = new mongoose.Schema({
    projectId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    organizationId: { type: String, required: true },
    status: { type: String, required: true },
    goalAmount: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  }, { collection: collectionName });

  if (!mongoose.models.Project) {
    mongoose.model('Project', projectSchema);
  }
}

/** Hàm seed schema donation. Mục đích: tạo collection donation nếu chưa có. */
async function ensureDonationCollection(): Promise<void> {
  const collectionName = 'donations';
  const collections = await mongoose.connection.db?.listCollections({ name: collectionName }).toArray();
  if (!collections?.length) {
    await mongoose.connection.db?.createCollection(collectionName);
  }

  const donationSchema = new mongoose.Schema({
    transactionHash: { type: String, required: true, unique: true },
    projectId: { type: String, required: true, index: true },
    donorAddress: { type: String, required: true, lowercase: true },
    amount: { type: Number, required: true },
    timestamp: { type: Date, required: true },
    isAnonymous: { type: Boolean, required: true },
    blockNumber: { type: Number, required: true },
    donationStatus: { type: String, required: true },
    indexedAt: { type: Date, required: true },
    correlationId: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  }, { collection: collectionName });

  if (!mongoose.models.Donation) {
    mongoose.model('Donation', donationSchema);
  }
}

/** Hàm seed schema ranking. Mục đích: tạo collection ranking snapshot nếu chưa có. */
async function ensureRankingCollection(): Promise<void> {
  const collectionName = 'rankingsnapshots';
  const collections = await mongoose.connection.db?.listCollections({ name: collectionName }).toArray();
  if (!collections?.length) {
    await mongoose.connection.db?.createCollection(collectionName);
  }

  const rankingSchema = new mongoose.Schema({
    snapshotId: { type: String, required: true, unique: true },
    calculatedAt: { type: Date, required: true },
    calculationWindowHours: { type: Number, required: true },
    calculationWindowStartedAt: { type: Date, required: true },
    calculationWindowEndedAt: { type: Date, required: true },
    totalValidDonations: { type: Number, required: true },
    skippedInvalidDonationCount: { type: Number, required: true },
    skippedSybilDonationCount: { type: Number, required: true },
    rankingItems: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true }
  }, { collection: collectionName });

  if (!mongoose.models.Rankingsnapshot) {
    mongoose.model('Rankingsnapshot', rankingSchema);
  }
}

/** Hàm seed dữ liệu donation demo. Mục đích: tạo donation giả với nhiều người donate để QF cho kết quả khác biệt. */
async function seedDemoDonations(): Promise<number> {
  const DonationModel = mongoose.model('Donation');
  const existingCount = await DonationModel.countDocuments();
  if (existingCount > 0) {
    console.log(`Đã có ${existingCount} donation trong DB. Bỏ qua seed.`);
    return 0;
  }

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const demoDonationList: Record<string, unknown>[] = [];
  let txIndex = 0;

  for (const projectItem of demoProjectList) {
    // Mỗi project có 5-8 donors khác nhau
    const donorCount = 5 + Math.floor(Math.random() * 4);
    const donorShuffled = [...demoDonorList].sort(() => Math.random() - 0.5).slice(0, donorCount);

    for (let i = 0; i < donorCount; i++) {
      // Mỗi donor donate 1-3 lần
      const donationCount = 1 + Math.floor(Math.random() * 3);
      for (let j = 0; j < donationCount; j++) {
        const randomHoursAgo = Math.random() * 24;
        const donationTimestamp = new Date(now.getTime() - randomHoursAgo * 60 * 60 * 1000);
        const txHash = `0x${String(txIndex++).padStart(64, '0')}`;

        demoDonationList.push({
          transactionHash: txHash,
          projectId: projectItem.projectId,
          donorAddress: donorShuffled[i].toLowerCase(),
          amount: Math.floor(Math.random() * 500_000) + 50_000,
          timestamp: donationTimestamp,
          isAnonymous: false,
          blockNumber: 18_000_000 + txIndex,
          donationStatus: 'INDEXED',
          indexedAt: donationTimestamp,
          correlationId: `donation:${txHash}`,
          createdAt: now,
          updatedAt: now
        });
      }
    }
  }

  if (demoDonationList.length > 0) {
    await DonationModel.insertMany(demoDonationList as unknown as mongoose.Document[]);
    console.log(`Đã seed ${demoDonationList.length} donation demo.`);
  }

  return demoDonationList.length;
}

/** Hàm seed dữ liệu project demo. Mục đích: tạo project để ranking join được. */
async function seedDemoProjects(): Promise<number> {
  const ProjectModel = mongoose.model('Project');
  const existingCount = await ProjectModel.countDocuments();
  if (existingCount > 0) {
    console.log(`Đã có ${existingCount} project trong DB. Bỏ qua seed.`);
    return 0;
  }

  const now = new Date();
  const projectDocumentList = demoProjectList.map(projectItem => ({
    projectId: projectItem.projectId,
    name: projectItem.name,
    organizationId: projectItem.organizationId,
    status: projectItem.status,
    goalAmount: projectItem.goalAmount,
    createdAt: now,
    updatedAt: now
  }));

  await ProjectModel.insertMany(projectDocumentList as unknown as mongoose.Document[]);
  console.log(`Đã seed ${projectDocumentList.length} project demo.`);
  return projectDocumentList.length;
}

/** Hàm trigger recalculate ranking. Mục đích: đẩy job vào queue sau khi seed dữ liệu. */
async function triggerRankingRecalculate(): Promise<void> {
  const rankingQueue = getRankingQueue();
  if (!rankingQueue) {
    console.warn('Ranking queue không khả dụng. Không thể trigger recalculate.');
    return;
  }

  const existingJobCount = await rankingQueue.getWaitingCount();
  const activeJobCount = await rankingQueue.getActiveCount();
  if (existingJobCount > 0 || activeJobCount > 0) {
    console.log(`Đang có ${existingJobCount} job waiting + ${activeJobCount} job active. Bỏ qua trigger.`);
    return;
  }

  await rankingQueue.add({ windowHours: 24 }, { jobId: `ranking-recalc-${Date.now()}` });
  console.log('Đã đẩy job recalculate ranking vào queue.');
}

/** Hàm chính: chạy seed. Mục đích: khởi tạo dữ liệu demo và trigger recalculate. */
async function main(): Promise<void> {
  console.log('=== Bắt đầu seed dữ liệu ranking demo ===');

  await connectToMongoDb();
  await connectToRedisSafely();

  await ensureProjectCollection();
  await ensureDonationCollection();
  await ensureRankingCollection();

  await seedDemoProjects();
  const donatedCount = await seedDemoDonations();

  if (donatedCount > 0) {
    startRankingWorker();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await triggerRankingRecalculate();
  }

  console.log('=== Seed hoàn tất ===');
  console.log('Truy cập GET http://localhost:4000/api/v1/rankings để xem bảng xếp hạng.');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((error: Error) => {
  console.error('Seed thất bại.', error.message);
  process.exit(1);
});
