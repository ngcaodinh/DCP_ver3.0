const crypto = require('crypto');
const mongoose = require('mongoose');
const { config } = require('dotenv');

config();

/** Lấy biến môi trường bắt buộc để script không chạy nhầm vào MongoDB chưa cấu hình. */
function getRequiredEnvironmentVariable(variableName) {
  const value = String(process.env[variableName] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường: ${variableName}`);
  return value;
}

/** Tạo notification SYSTEM tối thiểu và idempotent cho mỗi người bị ảnh hưởng. */
async function createRetirementNotification(collection, userId, overrideRequest, recipientKind) {
  const notificationId = crypto.randomUUID();
  const deduplicationKey = `gps-override-retired:${overrideRequest.overrideRequestId}:${userId}`;
  try {
    await collection.insertOne({
      notificationId,
      userId,
      notificationType: 'SYSTEM',
      title: 'Chức năng ghi đè GPS đã ngừng',
      content: recipientKind === 'organization'
        ? `Hồ sơ GPS của dự án ${overrideRequest.projectId} đã hết hiệu lực. Vui lòng nộp minh chứng bằng ảnh chụp trực tiếp qua camera.`
        : `Hồ sơ ghi đè GPS ${overrideRequest.overrideRequestId} đã hết hiệu lực do chức năng đã ngừng sử dụng.`,
      isRead: false,
      metadata: { overrideRequestId: overrideRequest.overrideRequestId, projectId: overrideRequest.projectId, reason: 'GPS override feature retired 2026-08-27' },
      channels: ['IN_APP'],
      priority: 'NORMAL',
      deliveryStatus: {
        IN_APP: { channel: 'IN_APP', status: 'PENDING' },
        EMAIL: { channel: 'EMAIL', status: 'SKIPPED' },
        PUSH: { channel: 'PUSH', status: 'SKIPPED' },
        SMS: { channel: 'SMS', status: 'SKIPPED' }
      },
      deliveryState: 'PENDING',
      attempts: 0,
      deduplicationKey,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return true;
  } catch (error) {
    if (error && error.code === 11000) return true;
    throw error;
  }
}

/** Đóng mọi hồ sơ PENDING, ghi audit canonical và thông báo tổ chức/snapshot mà không xóa bằng chứng lịch sử. */
async function closeGpsOverrideFeature() {
  await mongoose.connect(getRequiredEnvironmentVariable('MONGODB_URI'), {
    dbName: String(process.env.MONGODB_DB_NAME || '').trim() || undefined
  });
  const database = mongoose.connection.db;
  if (!database) throw new Error('Không thể truy cập MongoDB database.');
  const overrideCollection = database.collection('oracle_override_requests');
  const auditCollection = database.collection('admin_audit_logs');
  const notificationCollection = database.collection('notifications');
  const pendingRequests = await overrideCollection.find({ status: 'PENDING' }).toArray();
  let closedCount = 0;
  let notificationSuccessCount = 0;
  let notificationFailureCount = 0;

  for (const request of pendingRequests) {
    const now = new Date();
    const updated = await overrideCollection.findOneAndUpdate(
      { overrideRequestId: request.overrideRequestId, status: 'PENDING' },
      { $set: { status: 'EXPIRED', expiredAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    );
    // MongoDB driver 7 trả về document trực tiếp khi không bật includeResultMetadata.
    // Kiểm tra này giữ script idempotent khi một tiến trình khác vừa đóng request.
    if (!updated) continue;
    closedCount += 1;
    await auditCollection.updateOne(
      { actionId: `override-expired:${request.overrideRequestId}` },
      {
        $setOnInsert: {
          actionId: `override-expired:${request.overrideRequestId}`,
          actorType: 'SYSTEM',
          adminId: null,
          adminRole: null,
          actionType: 'OVERRIDE_EXPIRED',
          targetId: request.overrideRequestId,
          targetType: 'OVERRIDE_REQUEST',
          reason: 'GPS override feature retired 2026-08-27',
          ipAddress: null,
          userAgent: null,
          context: {
            overrideRequestId: request.overrideRequestId,
            projectId: request.projectId,
            organizationId: request.organizationId,
            commissionerSnapshotSize: Array.isArray(request.commissionerSnapshot) ? request.commissionerSnapshot.length : 0,
            outcome: 'EXPIRED_FEATURE_RETIRED'
          },
          requiresEscalation: false,
          escalationPolicy: null,
          archiveState: 'HOT',
          archivedAt: null,
          archiveLocator: null,
          archiveChecksum: null,
          createdAt: now
        }
      },
      { upsert: true }
    );
    const recipientIds = new Set([request.organizationId, ...(Array.isArray(request.commissionerSnapshot) ? request.commissionerSnapshot.map(member => member.userId) : [])].filter(Boolean));
    for (const userId of recipientIds) {
      try {
        const isOrganization = userId === request.organizationId;
        if (await createRetirementNotification(notificationCollection, userId, request, isOrganization ? 'organization' : 'commissioner')) notificationSuccessCount += 1;
      } catch (error) {
        notificationFailureCount += 1;
        console.error(`[WARN] Không gửi được notification override=${request.overrideRequestId} user=${userId}: ${error.message}`);
      }
    }
  }
  console.log(JSON.stringify({ pendingFound: pendingRequests.length, closedCount, notificationSuccessCount, notificationFailureCount }));
}

closeGpsOverrideFeature()
  .catch(error => { console.error('Đóng chức năng ghi đè GPS thất bại:', error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect(); });
