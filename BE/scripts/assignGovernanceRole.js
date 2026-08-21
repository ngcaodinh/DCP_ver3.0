/* eslint-disable @typescript-eslint/no-require-imports */
const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const ASSIGNABLE_ROLES = new Set(['executive_chair', 'executive_member', 'auditor']);
const MEMBER_SEAT_LIMIT = 4;

/** Đọc đối số --key=value để script vận hành không chấp nhận input mơ hồ. */
function readArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : '';
}

/** Kết nối Mongo theo cấu hình chuẩn của các script backend. */
async function connectMongo() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('Thiếu biến môi trường MONGODB_URI');
  await mongoose.connect(uri, { dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined });
}

/** In snapshot ghế sau thay đổi để người vận hành đối chiếu ngay tại terminal. */
async function printGovernanceSnapshot(users) {
  const [chairs, members, auditors] = await Promise.all([
    users.find({ role: 'executive_chair', accountStatus: 'ACTIVE', isSybil: false }).select({ email: 1, fullName: 1, _id: 0 }).lean().exec(),
    users.find({ role: 'executive_member', accountStatus: 'ACTIVE', isSybil: false }).select({ email: 1, fullName: 1, _id: 0 }).lean().exec(),
    users.countDocuments({ role: 'auditor', accountStatus: 'ACTIVE', isSybil: false }).exec()
  ]);
  console.log(`Chair (${chairs.length}/1): ${chairs.map(user => user.email || user.fullName).join(', ') || 'trống'}`);
  console.log(`Member (${members.length}/${MEMBER_SEAT_LIMIT}): ${members.map(user => user.email || user.fullName).join(', ') || 'trống'}`);
  console.log(`Auditor đang hoạt động: ${auditors}`);
  if (auditors === 0) console.error('CẢNH BÁO ĐỎ: chưa có Kiểm toán viên; cửa sổ khiếu nại 48 giờ không có người giám sát.');
}

/** Cấp role off-chain, đồng thời tăng authVersion để phiên cũ không tiếp tục mang quyền cũ. */
async function assignGovernanceRole() {
  const email = readArgument('email').toLowerCase();
  const role = readArgument('role');
  if (!email || !ASSIGNABLE_ROLES.has(role)) throw new Error('Dùng: node scripts/assignGovernanceRole.js --email=user@example.com --role=executive_chair|executive_member|auditor');

  await connectMongo();
  const schema = new mongoose.Schema({}, { strict: false, collection: 'authusers' });
  const AuthUser = mongoose.models.GovernanceRoleAuthUser || mongoose.model('GovernanceRoleAuthUser', schema);
  const user = await AuthUser.findOne({ email }).lean().exec();
  if (!user) throw new Error(`Không tìm thấy user với email ${email}`);
  if (user.accountStatus !== 'ACTIVE' || user.isSybil) throw new Error('Chỉ cấp role cho tài khoản ACTIVE và không bị gắn cờ Sybil.');

  if (role === 'executive_chair' && user.role !== role && await AuthUser.exists({ role: 'executive_chair', accountStatus: 'ACTIVE', isSybil: false })) throw new Error('Đã có executive_chair đang hoạt động; không thể cấp ghế thứ hai.');
  if (role === 'executive_member' && user.role !== role) {
    const memberCount = await AuthUser.countDocuments({ role: 'executive_member', accountStatus: 'ACTIVE', isSybil: false }).exec();
    if (memberCount >= MEMBER_SEAT_LIMIT) throw new Error(`Đã đủ ${MEMBER_SEAT_LIMIT} executive_member đang hoạt động.`);
  }

  if (user.role === role) console.log(`SKIP: ${email} đã là ${role}.`);
  else {
    const result = await AuthUser.updateOne({ id: user.id, email }, { $set: { role }, $inc: { authVersion: 1 }, $currentDate: { updatedAt: true } }).exec();
    if (result.modifiedCount !== 1) throw new Error('Không thể cập nhật role do dữ liệu thay đổi đồng thời.');
    console.log(`ASSIGNED: ${email} -> ${role}. Yêu cầu người dùng đăng xuất/đăng nhập lại.`);
  }
  await printGovernanceSnapshot(AuthUser);
}

assignGovernanceRole().catch(error => { console.error(`Assign governance role thất bại: ${error.message}`); process.exitCode = 1; }).finally(async () => mongoose.disconnect());
