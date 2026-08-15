// PHẢI đứng đầu tiên: auto-instrumentation cần patch module HTTP trước các import ứng dụng.
import './instrumentation/sentry';
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import application from './app';
import { connectToMongoDb } from './config/mongodb';
import { connectToRedisSafely } from './config/redis';
import { getLogger } from './config/logger';
import { isSentryEnabled } from './config/sentryConfig';
import { reportTerminalError } from './utils/sentryReporter';
import { startRankingWorker } from './workers/rankingWorker';
import { startRankingScheduler } from './workers/rankingScheduler';
import { startRankingReconcileWorker } from './workers/rankingReconcileWorker';
import { startDonationReconciliationWorker } from './workers/donationReconciliationWorker';
import { startDisbursementTransferStatusSweepPolling } from './services/disbursementService';
import { startPayosTransferWorker } from './workers/payosTransferWorker';
import { initializeNotificationBridge } from './services/notificationBridge.service';
import { initSocketServer, shutdownSocketServer } from './config/socketServer';
import { startManualReviewEscalationWorker, stopManualReviewEscalationWorker } from './workers/manualReviewEscalationWorker';
import { startOracleWorker, stopOracleWorker } from './workers/oracle.worker';
import { startOverrideExpiryWorker, stopOverrideExpiryWorker } from './workers/overrideExpiryWorker';
import { startSbtMintWorker, stopSbtMintWorker } from './workers/sbtMintWorker';
import { startSbtMintRecoveryScheduler } from './workers/sbtMintRecoveryScheduler';
import { startSbtStatusProjectionWorker, stopSbtStatusProjectionWorker } from './workers/sbtStatusProjectionWorker';
import { initializeSbtEventBridge } from './services/sbtEventBridge.service';
import { startDataMapperWorker } from './workers/data-mapper.worker';
import { startNotificationWorker, stopNotificationWorker } from './workers/notification.worker';
import { startAdminAuditArchiveWorker, stopAdminAuditArchiveWorker } from './workers/adminAuditArchiveWorker';
import { startAdminActionOutboxWorker, stopAdminActionOutboxWorker } from './workers/adminActionOutboxWorker';
import { startFeedbackPurgeWorker, stopFeedbackPurgeWorker } from './workers/feedbackPurgeWorker';

const logger = getLogger();

const serverPort = Number(process.env.PORT) || 4000;

/**
 * Hàm kiểm tra có bật worker nền hay không.
 * Mục đích: tách process API và worker trong production nhưng vẫn giữ local chạy đủ luồng.
 */
function shouldRunWorkers(): boolean {
  return process.env.RUN_WORKERS !== 'false';
}

/**
 * Hàm khởi động các worker nền của hệ thống.
 * Mục đích: gom scheduler và polling vào một điểm để dễ kiểm soát trong production.
 */
function startBackgroundWorkers(): void {
  startRankingWorker();
  startRankingScheduler();
  startRankingReconcileWorker();
  // Donation reconciliation worker: chạy mỗi 15 phút kiểm tra pending donations
  startDonationReconciliationWorker();
  startDisbursementTransferStatusSweepPolling();
  // PayOS Transfer Worker: xử lý disbursement transfer với Bull queue
  startPayosTransferWorker();
  // Manual Review Escalation Worker: cảnh báo admin khi disbursement MANUAL_REVIEW quá hạn SLA
  startManualReviewEscalationWorker();
  // Oracle Worker: xác minh EXIF GPS ảnh minh chứng (concurrency 3)
  startOracleWorker();
  // Override Expiry Worker: expire override request PENDING quá 7 ngày không đủ vote
  startOverrideExpiryWorker();
  // SBT Mint Worker: tự động mint SBT khi Oracle verified
  startSbtMintWorker();
  // SBT status projector: replay TokenStatusUpdated thành Mongo read model cho gallery public.
  startSbtStatusProjectionWorker();
  // SBT Mint Recovery Scheduler: cron 15 phut phat hien stuck jobs
  startSbtMintRecoveryScheduler();
  // Data Mapper Worker: dong bo PayOS + blockchain vao unified_transactions (5 phut)
  startDataMapperWorker();
  // Notification Worker (E1): consume notification queue, channel routing + throttle + DLQ
  startNotificationWorker();
  // Admin audit cold archive: chỉ chạy khi private S3-compatible storage được bật/configured.
  startAdminAuditArchiveWorker();
  startAdminActionOutboxWorker();
  startFeedbackPurgeWorker();
}

/**
 * Hàm khởi động server Node.js.
 * Mục đích: khởi tạo kết nối MongoDB + Redis trước, sau đó khởi động workers và lắng nghe cổng HTTP.
 */
async function startServer(): Promise<void> {
  await connectToMongoDb();
  await connectToRedisSafely();

  if (shouldRunWorkers()) {
    startBackgroundWorkers();
  }

  // Khoi dong notification bridge de lang nghe webhook events
  initializeNotificationBridge();
  // Khoi dong SBT event bridge de lang nghe sbtEvents va emit Socket.io
  initializeSbtEventBridge();

  // Capture HTTP server để Socket.io attach vào cùng port (không mở port riêng)
  const httpServer = application.listen(serverPort, () => {
    logger.info(`Server running on port ${serverPort}`);
  });

  // Khởi tạo Socket.io sau khi HTTP server sẵn sàng
  initSocketServer(httpServer);

  // Graceful shutdown: đóng Socket.io và dừng workers trước khi process tắt
  // Graceful shutdown: đóng Socket.io và dừng workers trước khi process tắt
  const handleShutdown = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
    logger.info(`Nhận signal ${signal}, đang shutdown...`);
    try {
      shutdownSocketServer();
      stopManualReviewEscalationWorker();
      stopOverrideExpiryWorker();
      await stopOracleWorker();
      await stopSbtMintWorker();
      stopSbtStatusProjectionWorker();
      // Notification worker: Bull queue.close() chờ active job xong (graceful per spec E1)
      await stopNotificationWorker();
      stopAdminAuditArchiveWorker();
      stopAdminActionOutboxWorker();
      stopFeedbackPurgeWorker();
    } catch (error) {
      logger.error('Lỗi khi shutdown workers.', {
        errorMessage: (error as Error).message
      });
    }

    // Flush trước khi process thoát; tầng quan sát không được làm shutdown treo quá lâu.
    if (isSentryEnabled()) {
      await Sentry.flush(2000).catch(() => undefined);
    }
  };
  process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
  process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
}

startServer().catch((error: Error) => {
  // Bootstrap fail là terminal vì container sẽ restart loop, nên cần capture như unhandled.
  reportTerminalError('Server failed to start.', error, { errorSource: 'bootstrap' });
});

