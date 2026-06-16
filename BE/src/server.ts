import 'dotenv/config';
import application from './app';
import { connectToMongoDb } from './config/mongodb';
import { connectToRedisSafely } from './config/redis';
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

  // Capture HTTP server để Socket.io attach vào cùng port (không mở port riêng)
  const httpServer = application.listen(serverPort, () => {
    console.log(`Server running on port ${serverPort}`);
  });

  // Khởi tạo Socket.io sau khi HTTP server sẵn sàng
  initSocketServer(httpServer);

  // Graceful shutdown: đóng Socket.io và dừng workers trước khi process tắt
  process.once('SIGTERM', () => { shutdownSocketServer(); stopManualReviewEscalationWorker(); stopOverrideExpiryWorker(); void stopOracleWorker(); });
  process.once('SIGINT', () => { shutdownSocketServer(); stopManualReviewEscalationWorker(); stopOverrideExpiryWorker(); void stopOracleWorker(); });
}

startServer().catch((error: Error) => {
  console.error('Server failed to start.', error.message);
});

