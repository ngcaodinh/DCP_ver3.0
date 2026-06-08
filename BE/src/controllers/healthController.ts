import { Request, Response } from 'express';
import mongoose from 'mongoose';

/**
 * Hàm xử lý endpoint health check.
 * Mục đích: trả trạng thái backend và kết nối MongoDB để kiểm tra service đang hoạt động.
 */
export function getHealthStatus(request: Request, response: Response): void {
  const mongoConnectionState = mongoose.connection.readyState;
  const isMongoConnected = mongoConnectionState === 1;

  response.status(200).json({
    serviceName: 'dcp-backend',
    status: 'ok',
    timestamp: new Date().toISOString(),
    mongoDb: {
      status: isMongoConnected ? 'connected' : 'disconnected',
      stateCode: mongoConnectionState
    }
  });
}

