import { NextFunction, Request, Response, Router } from 'express';
import { isSyntheticE2eExecutionEnabled, isSyntheticE2eTokenValid } from '../config/syntheticE2e';
import {
  handleSyntheticFullLoadBootstrap,
  handleSyntheticFullLoadFinalize,
  handleSyntheticKycToDisbursement
} from '../controllers/syntheticE2eController';

/** Chặn endpoint synthetic nếu không chạy đúng môi trường hoặc thiếu token test riêng. */
function syntheticE2eGuard(request: Request, response: Response, next: NextFunction): void {
  if (!isSyntheticE2eExecutionEnabled() || !isSyntheticE2eTokenValid(request.header('x-synthetic-e2e-token'))) {
    response.status(404).json({ success: false, message: 'Không tìm thấy endpoint.', errorCode: 'NOT_FOUND' });
    return;
  }
  next();
}

/** Tạo router test-only cho luồng synthetic KYC đến giải ngân. */
export function createSyntheticE2eRoutes(): Router {
  const router = Router();
  router.post('/kyc-to-disbursement', syntheticE2eGuard, handleSyntheticKycToDisbursement);
  router.post('/full-load/bootstrap', syntheticE2eGuard, handleSyntheticFullLoadBootstrap);
  router.post('/full-load/finalize', syntheticE2eGuard, handleSyntheticFullLoadFinalize);
  return router;
}
