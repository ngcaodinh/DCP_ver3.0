import 'dotenv/config';
import application from './app';
import { connectToMongoDb } from './config/mongodb';
import { connectToRedisSafely } from './config/redis';
import { startRankingWorker } from './workers/rankingWorker';
import { startRankingScheduler } from './workers/rankingScheduler';
import { startRankingReconcileWorker } from './workers/rankingReconcileWorker';
import { startDonationReconciliationWorker } from './workers/donationReconciliationWorker';
import { startDisbursementTransferStatusSweepPolling } from './services/disbursementService';
import { initializeNotificationBridge } from './services/notificationBridge.service';

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

  application.listen(serverPort, () => {
    console.log(`Server running on port ${serverPort}`);
  });
}

startServer().catch((error: Error) => {
  console.error('Server failed to start.', error.message);
});

