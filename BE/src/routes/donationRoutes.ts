import { Router } from 'express';
import {
  handleGetDonationHistoryByProjectId,
  handleGetPublicDonationCampaignDetail,
  handleGetPublicDonationCampaigns,
  handleGetPublicLiveFeed,
  handleGetPublicDonorList,
  handleOneClickDonation,
  handleRecordDonationFromTransactionHash,
  handleStreamPublicLiveFeed,
  handleSyncDonationEventsFromBlockchain
} from '../controllers/donationController';
import { createAuthenticationMiddleware } from '../middleware/authenticationMiddleware';
import { attachRequestMetadata } from '../middleware/ipMetadataMiddleware';
import { createRateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { createRoleAuthorizationMiddleware } from '../middleware/roleAuthorizationMiddleware';

/** Hàm khởi tạo route cho module donation. Mục đích: gom API campaign public, history và sync blockchain event cho UC3.1. */
export function createDonationRoutes(): Router {
  const router = Router();
  const authenticationMiddleware = createAuthenticationMiddleware();
  const adminAuthorizationMiddleware = createRoleAuthorizationMiddleware(['admin']);
  const getCampaignRateLimit = createRateLimitMiddleware(80, 60 * 1000, { bucketName: 'donation:get-campaign' });
  const getHistoryRateLimit = createRateLimitMiddleware(100, 60 * 1000, { bucketName: 'donation:get-history' });
  const syncEventsRateLimit = createRateLimitMiddleware(10, 60 * 1000, { bucketName: 'donation:sync-events' });

  router.get('/campaigns', attachRequestMetadata(), getCampaignRateLimit, handleGetPublicDonationCampaigns);
  router.get('/campaigns/:projectId', attachRequestMetadata(), getCampaignRateLimit, handleGetPublicDonationCampaignDetail);
  router.get('/campaigns/:projectId/history', attachRequestMetadata(), getHistoryRateLimit, handleGetDonationHistoryByProjectId);
  router.get('/donors', attachRequestMetadata(), getHistoryRateLimit, handleGetPublicDonorList);
  router.get('/live-feed', attachRequestMetadata(), getHistoryRateLimit, handleGetPublicLiveFeed);
  router.get('/live-feed/stream', attachRequestMetadata(), getHistoryRateLimit, handleStreamPublicLiveFeed);
  router.post('/one-click', attachRequestMetadata(), authenticationMiddleware, getHistoryRateLimit, handleOneClickDonation);
  router.post('/record', attachRequestMetadata(), authenticationMiddleware, getHistoryRateLimit, handleRecordDonationFromTransactionHash);

  router.post(
    '/sync-events',
    attachRequestMetadata(),
    authenticationMiddleware,
    adminAuthorizationMiddleware,
    syncEventsRateLimit,
    handleSyncDonationEventsFromBlockchain
  );

  return router;
}
