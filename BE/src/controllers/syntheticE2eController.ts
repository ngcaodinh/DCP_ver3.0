import { Request, Response } from 'express';
import { getLogger } from '../config/logger';
import { sendErrorFromUnknown, sendErrorResponse, sendSuccessResponse } from '../utils/apiResponse';
import { runSyntheticKycToDisbursement, type SyntheticE2eInput } from '../services/syntheticE2eService';
import {
  bootstrapSyntheticFullLoad,
  finalizeSyntheticFullLoad,
  type SyntheticFullLoadInput
} from '../services/syntheticFullLoadService';

const logger = getLogger();

/** Xử lý request chạy synthetic E2E từ đăng ký KYC đến giải ngân thành công. */
export async function handleSyntheticKycToDisbursement(request: Request, response: Response): Promise<void> {
  try {
    const body = (request.body || {}) as Record<string, unknown>;
    const input: SyntheticE2eInput = {
      donationAmount: body.donationAmount === undefined ? undefined : Number(body.donationAmount),
      disbursementAmount: body.disbursementAmount === undefined ? undefined : Number(body.disbursementAmount)
    };
    const result = await runSyntheticKycToDisbursement(input);
    logger.info('Synthetic KYC-to-disbursement E2E hoàn tất.', {
      runId: result.runId,
      totalDurationMs: result.totalDurationMs,
      donationAmount: result.donationAmount,
      disbursementAmount: result.disbursementAmount
    });
    sendSuccessResponse(response, 201, 'Synthetic KYC-to-disbursement E2E hoàn tất.', result);
  } catch (error) {
    logger.error('Synthetic KYC-to-disbursement E2E thất bại.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    if (process.env.NODE_ENV === 'performance') {
      sendErrorResponse(response, 500, 'Synthetic KYC-to-disbursement E2E thất bại.', 'INTERNAL_ERROR', [{
        field: 'syntheticE2e',
        message: error instanceof Error ? error.message : String(error)
      }]);
      return;
    }
    sendErrorFromUnknown(response, error, 'Synthetic KYC-to-disbursement E2E thất bại.');
  }
}

/** Khởi tạo full-load synthetic đến project ACTIVE và cấp token donor cho 20.000 request HTTP. */
export async function handleSyntheticFullLoadBootstrap(request: Request, response: Response): Promise<void> {
  try {
    const body = (request.body || {}) as Record<string, unknown>;
    const input: SyntheticFullLoadInput = {
      donationRequestCount: body.donationRequestCount === undefined ? undefined : Number(body.donationRequestCount),
      donationAmountPerRequest: body.donationAmountPerRequest === undefined ? undefined : Number(body.donationAmountPerRequest),
      disbursementAmount: body.disbursementAmount === undefined ? undefined : Number(body.disbursementAmount)
    };
    const result = await bootstrapSyntheticFullLoad(input);
    logger.info('Synthetic full-load bootstrap hoàn tất.', {
      runId: result.runId,
      projectId: result.projectId,
      donationRequestCount: result.donationRequestCount,
      bootstrapDurationMs: result.bootstrapDurationMs
    });
    sendSuccessResponse(response, 201, 'Synthetic full-load bootstrap hoàn tất.', result);
  } catch (error) {
    logger.error('Synthetic full-load bootstrap thất bại.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    sendSyntheticError(response, error, 'Synthetic full-load bootstrap thất bại.');
  }
}

/** Chốt donation count, committee và disbursement cho một synthetic full-load run. */
export async function handleSyntheticFullLoadFinalize(request: Request, response: Response): Promise<void> {
  try {
    const body = (request.body || {}) as Record<string, unknown>;
    const runId = String(body.runId || '').trim();
    if (!runId) {
      sendErrorResponse(response, 400, 'Thiếu runId cho synthetic full-load.', 'VALIDATION_ERROR');
      return;
    }
    const result = await finalizeSyntheticFullLoad(runId);
    logger.info('Synthetic full-load finalize hoàn tất.', {
      runId: result.runId,
      projectId: result.projectId,
      donationRequestCount: result.donationRequestCount,
      totalDurationMs: result.totalDurationMs
    });
    sendSuccessResponse(response, 200, 'Synthetic full-load finalize hoàn tất.', result);
  } catch (error) {
    logger.error('Synthetic full-load finalize thất bại.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    sendSyntheticError(response, error, 'Synthetic full-load finalize thất bại.');
  }
}

/** Trả chi tiết lỗi synthetic trong performance để JMeter dễ chẩn đoán. */
function sendSyntheticError(response: Response, error: unknown, fallbackMessage: string): void {
  if (process.env.NODE_ENV === 'performance') {
    sendErrorResponse(response, 500, fallbackMessage, 'INTERNAL_ERROR', [{
      field: 'syntheticFullLoad',
      message: error instanceof Error ? error.message : String(error)
    }]);
    return;
  }
  sendErrorFromUnknown(response, error, fallbackMessage);
}
