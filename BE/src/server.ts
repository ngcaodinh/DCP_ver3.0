// PHẢI đứng đầu tiên: auto-instrumentation cần patch module HTTP trước các import ứng dụng.
import './instrumentation/sentry';
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import application from './app';
import { connectToMongoDb } from './config/mongodb';
import { verifyRequiredCommitteeGovernanceIndexes } from './config/requiredIndexes';
import { connectToRedisSafely } from './config/redis';
import { getLogger } from './config/logger';
import { isSentryEnabled } from './config/sentryConfig';
import { reportTerminalError } from './utils/sentryReporter';
import { startRankingWorker } from './workers/rankingWorker';
import { startRankingScheduler } from './workers/rankingScheduler';
import { startRankingReconcileWorker } from './workers/rankingReconcileWorker';
import { startDonationReconciliationWorker } from './workers/donationReconciliationWorker';
import { startDisbursementTransferStatusSweepPolling } from './services/disbursementService';
import { startDisbursementOnChainSignerWorker, stopDisbursementOnChainSignerWorker } from './workers/disbursementOnChainSignerWorker';
import { startCommitteeDecisionRelayerWorker, stopCommitteeDecisionRelayerWorker } from './workers/committeeDecisionRelayerWorker';
import { startDisbursementCommitteeExpiryWorker, stopDisbursementCommitteeExpiryWorker } from './workers/disbursementCommitteeExpiryWorker';
import { startDisbursementRequestReconciliationWorker, stopDisbursementRequestReconciliationWorker } from './workers/disbursementRequestReconciliationWorker';
import { startGovernanceSeatProjectionWorker, stopGovernanceSeatProjectionWorker } from './workers/governanceSeatProjectionWorker';
import { startPayosTransferWorker } from './workers/payosTransferWorker';
import { initializeNotificationBridge } from './services/notificationBridge.service';
import { initSocketServer, shutdownSocketServer } from './config/socketServer';
import { startManualReviewEscalationWorker, stopManualReviewEscalationWorker } from './workers/manualReviewEscalationWorker';
import { startSbtMintWorker, stopSbtMintWorker } from './workers/sbtMintWorker';
import { startSbtMintRecoveryScheduler } from './workers/sbtMintRecoveryScheduler';
import { startSbtStatusProjectionWorker, stopSbtStatusProjectionWorker } from './workers/sbtStatusProjectionWorker';
import { startAuditorStakeEventProjectionWorker, stopAuditorStakeEventProjectionWorker } from './workers/auditorStakeEventProjectionWorker';
import { startAuditorPayoutWorker, stopAuditorPayoutWorker } from './workers/auditorPayoutWorker';
import { startAuditorDebtSettlementWorker, stopAuditorDebtSettlementWorker } from './workers/auditorDebtSettlementWorker';
import { startAuditorRewardPayoutWorker, stopAuditorRewardPayoutWorker } from './workers/auditorRewardPayoutWorker';
import { initializeSbtEventBridge } from './services/sbtEventBridge.service';
import { startDataMapperWorker } from './workers/data-mapper.worker';
import { startNotificationWorker, stopNotificationWorker } from './workers/notification.worker';
import { startAdminAuditArchiveWorker, stopAdminAuditArchiveWorker } from './workers/adminAuditArchiveWorker';
import { startAdminActionOutboxWorker, stopAdminActionOutboxWorker } from './workers/adminActionOutboxWorker';
import { startFeedbackPurgeWorker, stopFeedbackPurgeWorker } from './workers/feedbackPurgeWorker';
import { startEventLoggerWorker, stopEventLoggerWorker } from './workers/event-logger.worker';
import { startEventRetentionWorker, stopEventRetentionWorker } from './workers/event-retention.worker';
import { initializeEventSocketBridge, shutdownEventSocketBridge } from './services/eventSocketBridge.service';
import { startTrustScoreScheduler, stopTrustScoreScheduler } from './workers/trustScoreScheduler';
import { startProjectActivationWorker, stopProjectActivationWorker } from './workers/projectActivationWorker';
import { ensureRootAdminWallets } from './services/authService';
import { reconcileGovernanceAtStartup } from './services/governanceSeatStartup.service';
import { isAddress } from 'ethers';
import { validateAdminLoginWalletConfiguration } from './config/adminAccess';
import { startDonationCertificateWorker, stopDonationCertificateWorker } from './workers/donationCertificateWorker';
import { sendDonationCertificateIssuedEmail, sendDonationCertificateRevokedEmail } from './services/donationCertificateEmail.service';

const logger = getLogger();

const serverPort = Number(process.env.PORT) || 4000;

/**
 * Hàm kiểm tra có bật worker nền hay không.
 * Mục đích: tách process API và worker trong production nhưng vẫn giữ local chạy đủ luồng.
 */
function shouldRunWorkers(): boolean {
  return process.env.RUN_WORKERS !== 'false';
}

/** Bật worker ký giải ngân chỉ bằng cờ tường minh để rollout không vô tình vượt qua gate Phase 2. */
function shouldRunDisbursementOnChainSignerWorker(): boolean {
  return process.env.ENABLE_DISBURSEMENT_ONCHAIN_SIGNER_WORKER === 'true';
}

/** Relayer tách riêng để rollout không vô tình tiêu thụ nonce EIP-712 khi operator chưa cấp ví dịch vụ. */
function shouldRunCommitteeDecisionRelayerWorker(): boolean {
  return process.env.ENABLE_COMMITTEE_DECISION_RELAYER_WORKER === 'true';
}

/** Kiểm tra tập cấu hình Phase 2 trước startup để operator nhận đủ biến thiếu thay vì lỗi RPC rời rạc sau khi listen. */
function validateCommitteeRuntimeConfiguration(): void {
  validateAdminLoginWalletConfiguration();
  if (process.env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  const committeeAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  if (!isAddress(committeeAddress)) missing.push('COMMITTEE_GOVERNANCE_ADDRESS');
  if (!process.env.BLOCKCHAIN_RPC_URL?.trim()) missing.push('BLOCKCHAIN_RPC_URL');
  const deploymentBlock = Number(process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0) missing.push('COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK');
  if (shouldRunCommitteeDecisionRelayerWorker() && !process.env.COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY?.trim()) missing.push('COMMITTEE_GOVERNANCE_RELAYER_PRIVATE_KEY');
  if (shouldRunDisbursementOnChainSignerWorker()) {
    if (!shouldRunCommitteeDecisionRelayerWorker()) missing.push('ENABLE_COMMITTEE_DECISION_RELAYER_WORKER=true');
    if (!isAddress(process.env.MULTISIG_DISBURSEMENT_ADDRESS?.trim() || '')) missing.push('MULTISIG_DISBURSEMENT_ADDRESS');
    const multisigDeploymentBlock = Number(process.env.MULTISIG_DISBURSEMENT_DEPLOYMENT_BLOCK);
    if (!Number.isSafeInteger(multisigDeploymentBlock) || multisigDeploymentBlock <= 0) missing.push('MULTISIG_DISBURSEMENT_DEPLOYMENT_BLOCK');
  }
  if (missing.length > 0) throw new Error(`Thiếu hoặc không hợp lệ cấu hình CommitteeGovernance runtime: ${missing.join(', ')}.`);
  if ((shouldRunCommitteeDecisionRelayerWorker() || shouldRunDisbursementOnChainSignerWorker()) && !shouldRunWorkers()) {
    throw new Error('Không thể bật CommitteeGovernance worker khi RUN_WORKERS=false.');
  }
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
  startDisbursementCommitteeExpiryWorker();
  startDisbursementRequestReconciliationWorker();
  startGovernanceSeatProjectionWorker();
  if (shouldRunCommitteeDecisionRelayerWorker()) {
    startCommitteeDecisionRelayerWorker();
  }
  // PayOS Transfer Worker: xử lý disbursement transfer với Bull queue
  startPayosTransferWorker();
  // Fail-closed: worker ký chỉ được bật sau khi operator hoàn tất EIP-712, DecisionRecorded và audit reconciliation Phase 2.
  if (shouldRunDisbursementOnChainSignerWorker()) {
    startDisbursementOnChainSignerWorker();
  }
  // Manual Review Escalation Worker: cảnh báo admin khi disbursement MANUAL_REVIEW quá hạn SLA
  startManualReviewEscalationWorker();
  // SBT Mint Worker: tự động mint SBT khi Oracle verified
  startSbtMintWorker();
  // SBT status projector: replay TokenStatusUpdated thành Mongo read model cho gallery public.
  startSbtStatusProjectionWorker();
  // Auditor stake projector: đồng bộ quyền auditor từ event cọc, rút và slash đã đủ confirmation.
  startAuditorStakeEventProjectionWorker();
  startAuditorPayoutWorker();
  startAuditorDebtSettlementWorker();
  startAuditorRewardPayoutWorker();
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
  startEventLoggerWorker();
  startEventRetentionWorker();
  // Trust Score Scheduler (G1): tính lại trust score cho toàn bộ donor mỗi 24 giờ
  startTrustScoreScheduler();
  startProjectActivationWorker();
  startDonationCertificateWorker({ sendIssuedEmail: sendDonationCertificateIssuedEmail, sendRevokedEmail: sendDonationCertificateRevokedEmail });
}

/**
 * Hàm khởi động server Node.js.
 * Mục đích: khởi tạo kết nối MongoDB + Redis trước, sau đó khởi động workers và lắng nghe cổng HTTP.
 */
async function startServer(): Promise<void> {
  validateCommitteeRuntimeConfiguration();
  await connectToMongoDb();
  await verifyRequiredCommitteeGovernanceIndexes();
  await ensureRootAdminWallets();
  await reconcileGovernanceAtStartup();
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
  // Event logger bridge phải chạy ở cả API và worker process sau khi Socket.io sẵn sàng.
  initializeEventSocketBridge();

  // Graceful shutdown: đóng Socket.io và dừng workers trước khi process tắt
  // Graceful shutdown: đóng Socket.io và dừng workers trước khi process tắt
  const handleShutdown = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
    logger.info(`Nhận signal ${signal}, đang shutdown...`);
    try {
      shutdownSocketServer();
      await shutdownEventSocketBridge();
      // Trust Score Scheduler (G1): clear timeout để job không fire sau khi shutdown
      stopTrustScoreScheduler();
      stopProjectActivationWorker();
      stopManualReviewEscalationWorker();
      stopDisbursementOnChainSignerWorker();
      stopCommitteeDecisionRelayerWorker();
      stopDisbursementCommitteeExpiryWorker();
      stopDisbursementRequestReconciliationWorker();
      stopGovernanceSeatProjectionWorker();
      await stopSbtMintWorker();
      stopSbtStatusProjectionWorker();
      stopAuditorStakeEventProjectionWorker();
      stopAuditorDebtSettlementWorker();
      stopAuditorRewardPayoutWorker();
      await stopAuditorPayoutWorker();
      // Notification worker: Bull queue.close() chờ active job xong (graceful per spec E1)
      await stopNotificationWorker();
      stopAdminAuditArchiveWorker();
      stopAdminActionOutboxWorker();
      stopFeedbackPurgeWorker();
      await stopEventLoggerWorker();
      stopEventRetentionWorker();
      await stopDonationCertificateWorker();
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

