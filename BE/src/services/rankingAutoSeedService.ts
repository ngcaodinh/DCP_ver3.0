import mongoose from 'mongoose';
import { recalculateRankingSnapshot } from './rankingService';

/** Hàm tạo demo donation data đơn giản. Mục đích: cung cấp dữ liệu đủ để QF algorithm tính toán được. */
async function createDemoDonations(): Promise<void> {
  // Dùng top-level mongoose đã được connect sẵn, không dùng dynamic import
  const db = mongoose.connection.db;
  if (!db) return;

  // Định nghĩa schema tạm thời để insert data (không model vì có thể đã có model thật)
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
  }, { collection: 'donations' });

  const collections = await db.listCollections({ name: 'donations' }).toArray();
  if (!collections.length) {
    await db.createCollection('donations');
  }

  const DonationModel = mongoose.models.Donation || mongoose.model('Donation', donationSchema);
  const existingCount = await DonationModel.countDocuments();
  if (existingCount > 0) return;

  const now = new Date();
  const demoData: Record<string, unknown>[] = [
    // PRJ-1001: Nhiều người donate nhỏ → QF score cao (QF ưu tiên nhiều donor)
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001001', projectId: 'PRJ-1001', donorAddress: '0x1111111111111111111111111111111111111111', amount: 100_000, timestamp: new Date(now.getTime() - 2 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_001, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed001', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001002', projectId: 'PRJ-1001', donorAddress: '0x2222222222222222222222222222222222222222', amount: 100_000, timestamp: new Date(now.getTime() - 4 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_002, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed002', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001003', projectId: 'PRJ-1001', donorAddress: '0x3333333333333333333333333333333333333333', amount: 100_000, timestamp: new Date(now.getTime() - 6 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_003, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed003', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001004', projectId: 'PRJ-1001', donorAddress: '0x4444444444444444444444444444444444444444', amount: 100_000, timestamp: new Date(now.getTime() - 8 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_004, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed004', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001005', projectId: 'PRJ-1001', donorAddress: '0x5555555555555555555555555555555555555555', amount: 100_000, timestamp: new Date(now.getTime() - 10 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_005, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed005', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001006', projectId: 'PRJ-1001', donorAddress: '0x6666666666666666666666666666666666666666', amount: 100_000, timestamp: new Date(now.getTime() - 12 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_006, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed006', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001007', projectId: 'PRJ-1001', donorAddress: '0x7777777777777777777777777777777777777777', amount: 100_000, timestamp: new Date(now.getTime() - 14 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_007, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed007', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000001008', projectId: 'PRJ-1001', donorAddress: '0x8888888888888888888888888888888888888888', amount: 100_000, timestamp: new Date(now.getTime() - 16 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_008, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed008', createdAt: now, updatedAt: now },

    // PRJ-1002: 1 người donate lớn → total cao nhưng QF thấp
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000002001', projectId: 'PRJ-1002', donorAddress: '0x1111111111111111111111111111111111111111', amount: 1_000_000, timestamp: new Date(now.getTime() - 3 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_011, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed011', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000002002', projectId: 'PRJ-1002', donorAddress: '0x2222222222222222222222222222222222222222', amount: 500_000, timestamp: new Date(now.getTime() - 5 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_012, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed012', createdAt: now, updatedAt: now },

    // PRJ-1003: 3 người donate vừa
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000003001', projectId: 'PRJ-1003', donorAddress: '0x3333333333333333333333333333333333333333', amount: 300_000, timestamp: new Date(now.getTime() - 1 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_021, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed021', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000003002', projectId: 'PRJ-1003', donorAddress: '0x4444444444444444444444444444444444444444', amount: 300_000, timestamp: new Date(now.getTime() - 7 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_022, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed022', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000003003', projectId: 'PRJ-1003', donorAddress: '0x5555555555555555555555555555555555555555', amount: 300_000, timestamp: new Date(now.getTime() - 11 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_023, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed023', createdAt: now, updatedAt: now },

    // PRJ-1004: 2 người donate
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000004001', projectId: 'PRJ-1004', donorAddress: '0x6666666666666666666666666666666666666666', amount: 200_000, timestamp: new Date(now.getTime() - 9 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_031, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed031', createdAt: now, updatedAt: now },
    { transactionHash: '0x0000000000000000000000000000000000000000000000000000000000004002', projectId: 'PRJ-1004', donorAddress: '0x7777777777777777777777777777777777777777', amount: 200_000, timestamp: new Date(now.getTime() - 13 * 60 * 60 * 1000), isAnonymous: false, blockNumber: 18_000_032, donationStatus: 'INDEXED', indexedAt: now, correlationId: 'donation:seed032', createdAt: now, updatedAt: now }
  ];

  await DonationModel.insertMany(demoData as unknown as mongoose.Document[]);
  console.log(`Auto-seed: đã tạo ${demoData.length} donation demo.`);
}

/** Hàm tạo demo project data. Mục đích: cung cấp project info để ranking join được. */
async function createDemoProjects(): Promise<void> {
  // Dùng top-level mongoose đã được connect sẵn, không dùng dynamic import
  const db = mongoose.connection.db;
  if (!db) return;

  const projectSchema = new mongoose.Schema({
    projectId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    organizationId: { type: String, required: true },
    status: { type: String, required: true },
    goalAmount: { type: Number, required: true },
    deadline: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  }, { collection: 'projects' });

  const collections = await db.listCollections({ name: 'projects' }).toArray();
  if (!collections.length) {
    await db.createCollection('projects');
  }

  const ProjectModel = mongoose.models.Project || mongoose.model('Project', projectSchema);
  const existingCount = await ProjectModel.countDocuments();
  if (existingCount > 0) return;

  const now = new Date();
  // Deadline +30 ngày từ thời điểm tạo để đảm bảo luôn nằm trong tương lai,
  // tránh bị loại khỏi query findActiveProjectsByProjectIdList (điều kiện deadline >= now).
  const futureDeadline = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const projectList = [
    { projectId: 'PRJ-1001', name: 'Giáo dục vùng cao', organizationId: 'Tổ chức Hòa Bình', status: 'ACTIVE', goalAmount: 50_000_000, deadline: futureDeadline, createdAt: now, updatedAt: now },
    { projectId: 'PRJ-1002', name: 'Nước sạch nông thôn', organizationId: 'Hội Chữ Thập Đỏ', status: 'ACTIVE', goalAmount: 30_000_000, deadline: futureDeadline, createdAt: now, updatedAt: now },
    { projectId: 'PRJ-1003', name: 'Y tế cho người nghèo', organizationId: 'Quỹ Từ Thiện Việt', status: 'ACTIVE', goalAmount: 80_000_000, deadline: futureDeadline, createdAt: now, updatedAt: now },
    { projectId: 'PRJ-1004', name: 'Bảo vệ rừng ngập mặn', organizationId: 'Hội Bảo vệ Môi trường', status: 'ACTIVE', goalAmount: 25_000_000, deadline: futureDeadline, createdAt: now, updatedAt: now }
  ];

  await ProjectModel.insertMany(projectList as unknown as mongoose.Document[]);
  console.log(`Auto-seed: đã tạo ${projectList.length} project demo.`);
}

/**
 * Hàm auto-seed toàn bộ dữ liệu ranking demo.
 * Mục đích: đảm bảo bảng xếp hạng có dữ liệu ngay khi server dev khởi động mà không cần can thiệp thủ công.
 */
export async function autoSeedDemoRankingData(): Promise<void> {
  await createDemoProjects();
  await createDemoDonations();
  await recalculateRankingSnapshot(24);
  console.log('Auto-seed: đã tạo ranking snapshot từ dữ liệu demo.');
}
