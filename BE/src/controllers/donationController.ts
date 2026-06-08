import { Response } from 'express';
import { getLogger } from '../config/logger';
import { AuthenticatedRequest } from '../middleware/authenticationMiddleware';
import {
  executeOneClickDonation,
  getDonationHistoryByProjectId,
  getPublicDonationCampaignDetail,
  getPublicDonationCampaigns,
  getPublicDonorList,
  recordDonationFromTransactionHash,
  syncDonationEventsFromBlockchain
} from '../services/donationService';
import { getPublicLiveFeedTransactionList } from '../services/liveFeedService';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';

const logger = getLogger();

/** Hàm tự ghi nhận donation chạy nền sau khi đã submit on-chain. Mục đích: giảm phụ thuộc FE gọi /donations/record và tránh mất lịch sử. */
function triggerAutoRecordDonationInBackground(authenticatedUserId: string, projectId: string, transactionHash: string, isAnonymous: boolean): void {
  void recordDonationFromTransactionHash(authenticatedUserId, projectId, transactionHash, isAnonymous)
    .then(() => {
      logger.info('Tự động ghi nhận donation chạy nền thành công.', { authenticatedUserId, projectId, transactionHash });
    })
    .catch((error) => {
      logger.warn('Tự động ghi nhận donation chạy nền thất bại.', {
        authenticatedUserId,
        projectId,
        transactionHash,
        errorMessage: (error as Error).message
      });
    });
}

/** Hàm xử lý request lấy danh sách campaign quyên góp công khai. Mục đích: trả dữ liệu cho trang campaign UC3.1. */
export async function handleGetPublicDonationCampaigns(request: AuthenticatedRequest, response: Response): Promise<void> {
  const parsedLimitCount = Number(request.query.limit);

  try {
    const campaignList = await getPublicDonationCampaigns(parsedLimitCount);
    sendSuccessResponse(response, 200, 'Lấy danh sách chiến dịch quyên góp thành công.', campaignList);
  } catch (error) {
    logger.error('Lấy danh sách campaign quyên góp thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách chiến dịch quyên góp.');
  }
}

/** Hàm xử lý request lấy chi tiết campaign theo projectId. Mục đích: trả dữ liệu trang chi tiết chiến dịch. */
export async function handleGetPublicDonationCampaignDetail(request: AuthenticatedRequest, response: Response): Promise<void> {
  const { projectId } = request.params;

  try {
    const campaignDetail = await getPublicDonationCampaignDetail(projectId);

    if (!campaignDetail) {
      sendSuccessResponse(response, 200, 'Không tìm thấy chiến dịch quyên góp.', null);
      return;
    }

    sendSuccessResponse(response, 200, 'Lấy chi tiết chiến dịch quyên góp thành công.', campaignDetail);
  } catch (error) {
    logger.error('Lấy chi tiết campaign quyên góp thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy chi tiết chiến dịch quyên góp.');
  }
}

/** Hàm xử lý request lấy lịch sử donate theo projectId. Mục đích: trả dữ liệu minh bạch giao dịch public. */
export async function handleGetDonationHistoryByProjectId(request: AuthenticatedRequest, response: Response): Promise<void> {
  const { projectId } = request.params;
  const parsedLimitCount = Number(request.query.limit);

  try {
    const donationHistoryList = await getDonationHistoryByProjectId(projectId, parsedLimitCount);
    sendSuccessResponse(response, 200, 'Lấy lịch sử quyên góp thành công.', donationHistoryList);
  } catch (error) {
    logger.error('Lấy lịch sử quyên góp thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy lịch sử quyên góp.');
  }
}

/** Hàm xử lý request lấy danh sách nhà hảo tâm công khai. Mục đích: trả dữ liệu đầy đủ cho trang danh sách người đã quyên góp. */
export async function handleGetPublicDonorList(request: AuthenticatedRequest, response: Response): Promise<void> {
  const parsedPageNumber = Number(request.query.page);
  const parsedLimitCount = Number(request.query.limit);
  const parsedProjectId = String(request.query.projectId || '').trim();

  try {
    const donorListPagination = await getPublicDonorList(parsedPageNumber, parsedLimitCount, parsedProjectId);
    sendSuccessResponse(response, 200, 'Lấy danh sách nhà hảo tâm thành công.', donorListPagination);
  } catch (error) {
    logger.error('Lấy danh sách nhà hảo tâm thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy danh sách nhà hảo tâm.');
  }
}

/** Hàm xử lý request lấy snapshot live feed public. Mục đích: trả giao dịch thật cho section minh bạch trên homepage. */
export async function handleGetPublicLiveFeed(request: AuthenticatedRequest, response: Response): Promise<void> {
  const parsedLimitCount = Number(request.query.limit);

  try {
    const liveFeedTransactionItemList = await getPublicLiveFeedTransactionList(parsedLimitCount);
    sendSuccessResponse(response, 200, 'Lấy dữ liệu live feed thành công.', liveFeedTransactionItemList);
  } catch (error) {
    logger.error('Lấy dữ liệu live feed thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể lấy dữ liệu live feed.');
  }
}

/** Hàm xử lý stream SSE cho live feed public. Mục đích: đẩy snapshot giao dịch thật theo thời gian thực cho homepage. */
export async function handleStreamPublicLiveFeed(request: AuthenticatedRequest, response: Response): Promise<void> {
  const parsedLimitCount = Number(request.query.limit);

  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();

  /** Hàm gửi snapshot live feed mới nhất. Mục đích: giữ frontend đồng bộ dữ liệu thật mà không cần mock interval. */
  const sendLiveFeedSnapshot = async (): Promise<void> => {
    try {
      const liveFeedTransactionItemList = await getPublicLiveFeedTransactionList(parsedLimitCount);
      response.write('event: live-feed\n');
      response.write(`data: ${JSON.stringify(liveFeedTransactionItemList)}\n\n`);
    } catch (error) {
      logger.warn('Không thể gửi snapshot live feed SSE.', { errorMessage: (error as Error).message });
      response.write('event: heartbeat\n');
      response.write('data: {}\n\n');
    }
  };

  await sendLiveFeedSnapshot();
  const snapshotIntervalId = setInterval(() => {
    void sendLiveFeedSnapshot();
  }, 5000);

  request.on('close', () => {
    clearInterval(snapshotIntervalId);
    response.end();
  });
}


/** Hàm xử lý request donation one-click. Mục đích: backend gửi batch approve + donate để frontend thao tác kiểu web2 click. */
export async function handleOneClickDonation(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const { projectId, amount, isAnonymous } = request.body as {
    projectId?: string;
    amount?: number;
    isAnonymous?: boolean;
  };

  try {
    const normalizedProjectId = String(projectId || '').trim();
    const normalizedAnonymousFlag = Boolean(isAnonymous);

    const oneClickDonationResult = await executeOneClickDonation(
      request.authenticatedUser.userId,
      normalizedProjectId,
      Number(amount || 0),
      normalizedAnonymousFlag
    );

    sendSuccessResponse(response, 200, 'Gửi giao dịch one-click donation thành công.', oneClickDonationResult);

    // Ghi chú logic phức tạp: ghi nhận chạy nền để đảm bảo lịch sử vẫn được lưu ngay cả khi FE không kịp gọi /donations/record.
    triggerAutoRecordDonationInBackground(
      request.authenticatedUser.userId,
      normalizedProjectId,
      oneClickDonationResult.transactionHash,
      normalizedAnonymousFlag
    );
  } catch (error) {
    logger.error('Gửi giao dịch one-click donation thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể gửi giao dịch one-click donation.');
  }
}


/** Hàm xử lý request ghi nhận donation bằng transaction hash từ ví người dùng. Mục đích: xác nhận giao dịch on-chain và index idempotent cho UC3.1. */
export async function handleRecordDonationFromTransactionHash(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  const { projectId, transactionHash, isAnonymous } = request.body as {
    projectId?: string;
    transactionHash?: string;
    isAnonymous?: boolean;
  };

  try {
    const recordResult = await recordDonationFromTransactionHash(
      request.authenticatedUser.userId,
      String(projectId || ''),
      String(transactionHash || ''),
      Boolean(isAnonymous)
    );
    sendSuccessResponse(response, 200, 'Ghi nhận giao dịch quyên góp thành công.', recordResult);
  } catch (error) {
    logger.error('Ghi nhận giao dịch quyên góp thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể ghi nhận giao dịch quyên góp.');
  }
}


/** Hàm xử lý request đồng bộ event quyên góp từ blockchain. Mục đích: cho phép trigger indexer thủ công từ backend API. */
export async function handleSyncDonationEventsFromBlockchain(request: AuthenticatedRequest, response: Response): Promise<void> {
  if (!request.authenticatedUser) {
    sendErrorResponse(response, 401, 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ.', 'UNAUTHENTICATED');
    return;
  }

  try {
    const syncResult = await syncDonationEventsFromBlockchain();
    sendSuccessResponse(response, 200, 'Đồng bộ event quyên góp thành công.', syncResult);
  } catch (error) {
    logger.error('Đồng bộ event quyên góp thất bại.', { errorMessage: (error as Error).message });
    sendErrorFromUnknown(response, error, 'Không thể đồng bộ event quyên góp từ blockchain.');
  }
}
