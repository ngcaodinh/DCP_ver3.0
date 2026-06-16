import { getLogger } from '../config/logger';
import { getSocketServer } from '../config/socketServer';
import { maskWalletAddress } from '../utils/maskWalletAddress';
import { sbtEvents, type SbtMintedEventPayload, type SbtMintFailedEventPayload, type SbtMintDlqEventPayload, type SbtMintBlockedEventPayload } from '../events/sbtEvents';

const logger = getLogger();

/**
 * Reference tới listener để có thể cleanup khi shutdown.
 * Tránh tích lũy listener khi bridge được khởi tạo lại.
 */
let _sbtMintedListener: ((p: SbtMintedEventPayload) => void) | null = null;
let _sbtMintFailedListener: ((p: SbtMintFailedEventPayload) => void) | null = null;
let _sbtMintDlqListener: ((p: SbtMintDlqEventPayload) => void) | null = null;
let _sbtMintBlockedListener: ((p: SbtMintBlockedEventPayload) => void) | null = null;

/**
 * Khởi tạo SBT event bridge.
 * Lắng nghe các sự kiện từ sbtEvents và emit tới Socket.io rooms.
 *
 * Mục đích:
 * - sbt.minted → emit 'sbt:minted' tới 'admin' room (real-time UI update)
 * - sbt.mint-failed → emit 'sbt:mint-failed' tới 'admin' room (monitoring)
 * - sbt.mint-dlq → emit 'sbt:mint-dlq' tới 'admin' room (alert cho admin)
 *
 * Pattern giống notificationBridge.service.ts.
 */
export function initializeSbtEventBridge(): void {
  // Cleanup listeners cũ trước khi đăng ký mới
  if (_sbtMintedListener) sbtEvents.removeListener('sbt.minted', _sbtMintedListener);
  if (_sbtMintFailedListener) sbtEvents.removeListener('sbt.mint-failed', _sbtMintFailedListener);
  if (_sbtMintDlqListener) sbtEvents.removeListener('sbt.mint-dlq', _sbtMintDlqListener);
  if (_sbtMintBlockedListener) sbtEvents.removeListener('sbt.mint-blocked', _sbtMintBlockedListener);

  _sbtMintedListener = (payload: SbtMintedEventPayload) => {
    const io = getSocketServer();
    if (!io) {
      logger.warn('Socket.io chưa khả dụng khi emit sbt.minted event.');
      return;
    }

    const socketPayload = {
      sbtId: payload.sbtId,
      mintRequestId: payload.mintRequestId,
      projectId: payload.projectId,
      organizationId: payload.organizationId,
      beneficiaryAddress: maskWalletAddress(payload.beneficiaryAddress),
      onChainTokenId: payload.onChainTokenId,
      transactionHash: payload.transactionHash,
      blockNumber: payload.blockNumber,
      imageCid: payload.imageCid,
      tokenUri: payload.tokenUri,
      milestone: payload.milestone ?? undefined,
      mintedAt: payload.mintedAt instanceof Date ? payload.mintedAt.toISOString() : String(payload.mintedAt),
      timestamp: new Date().toISOString()
    };

    io.to('admin').emit('sbt:minted', socketPayload);
    logger.info('Socket.io: đã emit sbt:minted event.', {
      sbtId: payload.sbtId,
      mintRequestId: payload.mintRequestId,
      onChainTokenId: payload.onChainTokenId
    });
  };

  _sbtMintFailedListener = (payload: SbtMintFailedEventPayload) => {
    const io = getSocketServer();
    if (!io) return;

    io.to('admin').emit('sbt:mint-failed', {
      sbtId: payload.sbtId,
      mintRequestId: payload.mintRequestId,
      projectId: payload.projectId,
      organizationId: payload.organizationId,
      attemptNumber: payload.attemptNumber,
      errorMessage: payload.errorMessage,
      failedAt: payload.failedAt instanceof Date ? payload.failedAt.toISOString() : String(payload.failedAt),
      timestamp: new Date().toISOString()
    });
  };

  _sbtMintDlqListener = (payload: SbtMintDlqEventPayload) => {
    const io = getSocketServer();
    if (!io) return;

    io.to('admin').emit('sbt:mint-dlq', {
      sbtId: payload.sbtId,
      mintRequestId: payload.mintRequestId,
      projectId: payload.projectId,
      organizationId: payload.organizationId,
      beneficiaryAddress: maskWalletAddress(payload.beneficiaryAddress),
      attemptNumber: payload.attemptNumber,
      lastErrorMessage: payload.lastErrorMessage,
      dlqAt: payload.dlqAt instanceof Date ? payload.dlqAt.toISOString() : String(payload.dlqAt),
      timestamp: new Date().toISOString()
    });

    // Alert riêng cho DLQ — đánh dấu cần admin xử lý gấp
    logger.warn('SBT mint DLQ event đã emit tới admin room.', {
      sbtId: payload.sbtId,
      mintRequestId: payload.mintRequestId,
      attemptNumber: payload.attemptNumber,
      dlqAt: payload.dlqAt instanceof Date ? payload.dlqAt.toISOString() : String(payload.dlqAt)
    });
  };

  _sbtMintBlockedListener = (payload: SbtMintBlockedEventPayload) => {
    const io = getSocketServer();
    if (!io) {
      logger.warn('Socket.io chưa khả dụng khi emit sbt.mint-blocked event.');
      return;
    }

    io.to('admin').emit('sbt:mint-blocked', {
      mintRequestId: payload.mintRequestId,
      verificationId: payload.verificationId,
      projectId: payload.projectId,
      organizationId: payload.organizationId,
      reason: payload.reason,
      blockedAt: payload.blockedAt instanceof Date ? payload.blockedAt.toISOString() : String(payload.blockedAt),
      timestamp: new Date().toISOString()
    });

    // Alert riêng cho blocked — cần admin xử lý C4
    logger.warn('SBT mint BLOCKED event đã emit tới admin room. Cần implement C4 (lookup donor wallet).', {
      verificationId: payload.verificationId,
      projectId: payload.projectId,
      organizationId: payload.organizationId,
      reason: payload.reason
    });
  };

  sbtEvents.on('sbt.minted', _sbtMintedListener);
  sbtEvents.on('sbt.mint-failed', _sbtMintFailedListener);
  sbtEvents.on('sbt.mint-dlq', _sbtMintDlqListener);
  sbtEvents.on('sbt.mint-blocked', _sbtMintBlockedListener);

  logger.info('SBT event bridge đã được khởi tạo.');
}

/**
 * Cleanup SBT event bridge khi server shutdown.
 * Mục đích: tránh memory leak khi bridge được khởi tạo lại.
 */
export function shutdownSbtEventBridge(): void {
  if (_sbtMintedListener) {
    sbtEvents.removeListener('sbt.minted', _sbtMintedListener);
    _sbtMintedListener = null;
  }
  if (_sbtMintFailedListener) {
    sbtEvents.removeListener('sbt.mint-failed', _sbtMintFailedListener);
    _sbtMintFailedListener = null;
  }
  if (_sbtMintDlqListener) {
    sbtEvents.removeListener('sbt.mint-dlq', _sbtMintDlqListener);
    _sbtMintDlqListener = null;
  }
  if (_sbtMintBlockedListener) {
    sbtEvents.removeListener('sbt.mint-blocked', _sbtMintBlockedListener);
    _sbtMintBlockedListener = null;
  }
  logger.info('SBT event bridge đã được shutdown.');
}
