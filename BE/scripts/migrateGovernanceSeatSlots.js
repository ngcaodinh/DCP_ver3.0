const { config } = require('dotenv');
const mongoose = require('mongoose');

config();

const AUTH_USER_COLLECTION = 'authusers';
const GOVERNANCE_SEAT_SLOT_INDEX = 'role_1_governanceSeatSlot_1';
const ACTIVE_SEAT_FILTER = {
  role: { $in: ['executive_chair', 'executive_member'] },
  accountStatus: 'ACTIVE'
};
const SEAT_CAPACITY = { executive_chair: 1, executive_member: 4 };
const MIGRATION_STATE_COLLECTION = 'governance_seat_migration_states';
const MIGRATION_KEY = 'governance-seat-slots';

/** Đọc biến môi trường bắt buộc để migration không chạy vào database chưa được xác định. */
function getRequiredEnvironmentVariable(variableName) {
  const value = String(process.env[variableName] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${variableName}`);
  return value;
}

/** Kết nối Mongo theo cùng convention script migration hiện có của repository. */
async function connectToMongoDatabase() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
}

/** Xác minh roster legacy không vượt quota trước khi gán slot xác định, tránh che giấu dữ liệu sai. */
function validateLegacySeatCapacity(seats) {
  for (const role of Object.keys(SEAT_CAPACITY)) {
    const roleSeats = seats.filter(seat => seat.role === role);
    if (roleSeats.length > SEAT_CAPACITY[role]) {
      throw new Error(`Roster ACTIVE role=${role} có ${roleSeats.length} ghế, vượt quota ${SEAT_CAPACITY[role]}. Cần xử lý thủ công trước migration.`);
    }
  }
}

/** Gán slot 1-based ổn định theo role và createdAt; update CAS giúp script chạy lại vẫn idempotent. */
async function backfillActiveGovernanceSeatSlots(collection, seats) {
  for (const role of Object.keys(SEAT_CAPACITY)) {
    const roleSeats = seats
      .filter(seat => seat.role === role)
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || String(left._id).localeCompare(String(right._id)));
    for (const [index, seat] of roleSeats.entries()) {
      const governanceSeatSlot = index + 1;
      if (seat.governanceSeatSlot === governanceSeatSlot) continue;
      const updateResult = await collection.updateOne(
        {
          _id: seat._id,
          ...ACTIVE_SEAT_FILTER,
          role,
          $or: [
            { governanceSeatSlot: null },
            { governanceSeatSlot: { $exists: false } }
          ]
        },
        { $set: { governanceSeatSlot, updatedAt: new Date() } }
      );
      if (updateResult.modifiedCount !== 1 && seat.governanceSeatSlot !== governanceSeatSlot) {
        throw new Error(`Ghế ${seat._id} thay đổi trong khi migration; hãy chạy lại sau khi traffic đã bị khóa.`);
      }
    }
  }
}

/** Tạo/kiểm chứng unique partial index sau backfill để Mongo tiếp tục bảo vệ quota khi có race. */
async function ensureGovernanceSeatSlotIndex(collection) {
  await collection.createIndex(
    { role: 1, governanceSeatSlot: 1 },
    {
      name: GOVERNANCE_SEAT_SLOT_INDEX,
      unique: true,
      partialFilterExpression: {
        role: { $in: ['executive_chair', 'executive_member'] },
        accountStatus: 'ACTIVE',
        governanceSeatSlot: { $gte: 1 }
      }
    }
  );
}

/** Khóa bền vững mọi mutation roster trước khi đọc dữ liệu để chặn race giữa backfill và unique index. */
async function setMigrationLock(isLocked, completedAt = null) {
  const now = new Date();
  await mongoose.connection.collection(MIGRATION_STATE_COLLECTION).updateOne(
    { migrationKey: MIGRATION_KEY },
    {
      $set: { isLocked, lockedAt: isLocked ? now : null, completedAt, updatedAt: now },
      $setOnInsert: { migrationKey: MIGRATION_KEY, createdAt: now }
    },
    { upsert: true }
  );
}

/** Chạy migration seat slot theo thứ tự: đọc roster, validate, backfill, index và kiểm tra tồn dư legacy. */
async function runMigration() {
  await connectToMongoDatabase();
  await setMigrationLock(true);
  try {
    const collection = mongoose.connection.collection(AUTH_USER_COLLECTION);
    const seats = await collection.find(ACTIVE_SEAT_FILTER).sort({ role: 1, createdAt: 1, _id: 1 }).toArray();
    validateLegacySeatCapacity(seats);
    await backfillActiveGovernanceSeatSlots(collection, seats);
    await ensureGovernanceSeatSlotIndex(collection);
    const remainingLegacySeats = await collection.countDocuments({
      ...ACTIVE_SEAT_FILTER,
      $or: [{ governanceSeatSlot: null }, { governanceSeatSlot: { $exists: false } }]
    });
    if (remainingLegacySeats !== 0) throw new Error(`Còn ${remainingLegacySeats} ghế ACTIVE chưa có slot sau migration.`);
    await setMigrationLock(false, new Date());
    console.log(JSON.stringify({ migratedActiveSeats: seats.length, remainingLegacySeats, index: GOVERNANCE_SEAT_SLOT_INDEX }));
  } catch (error) {
    // Giữ lock khi migration lỗi để traffic không ghi thêm dữ liệu vào trạng thái nửa chừng.
    throw error;
  }
}

runMigration()
  .catch(error => { console.error('Migration governance seat slots thất bại:', error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
