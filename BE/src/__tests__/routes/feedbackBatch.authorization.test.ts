import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../controllers/feedbackBatchController', () => ({
  batchUploadFeedbackController: vi.fn((_request, response) => response.status(200).json({ success: true })),
  FEEDBACK_BATCH_RATE_LIMIT_CONFIG: { maxRequests: 10, windowMs: 60_000, bucketName: 'feedback-batch-test' },
  MAX_BATCH_SIZE: 1000,
  MAX_UPLOAD_SIZE_BYTES: 5 * 1024 * 1024
}));
vi.mock('../../controllers/feedbackModerationController', () => ({ handleFeedbackModeration: vi.fn() }));
vi.mock('../../controllers/flaggedFeedbackController', () => ({
  handleDeleteFeedback: vi.fn(),
  handleListFlaggedFeedback: vi.fn(),
  handleRestoreFeedback: vi.fn()
}));
vi.mock('../../controllers/organizationFeedbackController', () => ({
  handleListOrganizationFeedback: vi.fn((_request, response) => response.status(200).json({ success: true }))
}));
vi.mock('../../models/authModel', () => ({
  findUserById: vi.fn((userId: string) => Promise.resolve({
    userId,
    role: userId.startsWith('organizations-') ? 'organizations' : userId.startsWith('admin-') ? 'admin' : 'donor',
    accountStatus: 'ACTIVE',
    authVersion: 1
  }))
}));

import { createFeedbackRoutes } from '../../routes/feedback.routes';
import { findUserById } from '../../models/authModel';

const JWT_SECRET = 'feedback-batch-authorization-test-secret';

function createToken(role: string): string {
  return jwt.sign({ userId: `${role}-user`, role }, JWT_SECRET, {
    issuer: 'feedback-test-issuer',
    audience: 'feedback-test-audience'
  });
}

describe('feedback batch authorization', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.JWT_ISSUER = 'feedback-test-issuer';
    process.env.JWT_AUDIENCE = 'feedback-test-audience';
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  });

  function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/feedback', createFeedbackRoutes());
    return app;
  }

  it.each(['organizations', 'admin'])('cho phép role %s upload batch', async role => {
    await request(createTestApp())
      .post('/api/feedback/batch')
      .set('Authorization', `Bearer ${createToken(role)}`)
      .attach('file', Buffer.from('projectId,beneficiaryName,rating,comment,submittedAt\n'), 'feedback.csv')
      .expect(200);
  });

  it('từ chối donor với 403 và không cần chạy tới controller upload', async () => {
    await request(createTestApp())
      .post('/api/feedback/batch')
      .set('Authorization', `Bearer ${createToken('donor')}`)
      .expect(403);
  });

  it('từ chối request thiếu token với 401', async () => {
    await request(createTestApp()).post('/api/feedback/batch').expect(401);
  });

  it('kiểm tra fresh role cho endpoint organization trước khi đọc dữ liệu riêng tư', async () => {
    await request(createTestApp())
      .get('/api/feedback/organization')
      .set('Authorization', `Bearer ${createToken('organizations')}`)
      .expect(200);

    await request(createTestApp())
      .get('/api/feedback/organization')
      .set('Authorization', `Bearer ${createToken('donor')}`)
      .expect(403);
  });

  it('từ chối JWT khi user hiện tại không còn tồn tại trong DB', async () => {
    vi.mocked(findUserById).mockResolvedValueOnce(null);

    await request(createTestApp())
      .post('/api/feedback/batch')
      .set('Authorization', `Bearer ${createToken('organizations')}`)
      .attach('file', Buffer.from('feedback'), 'feedback.csv')
      .expect(401);
  });

  it('map Multer LIMIT_FILE_SIZE thành FILE_TOO_LARGE thay vì lỗi 500', async () => {
    const response = await request(createTestApp())
      .post('/api/feedback/batch')
      .set('Authorization', `Bearer ${createToken('organizations')}`)
      .attach(
        'file',
        Buffer.alloc(5 * 1024 * 1024 + 1),
        { filename: 'feedback.csv', contentType: 'text/csv' }
      );

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'FILE_TOO_LARGE'
    }));
  });

  it('map field multipart không được phép thành INVALID_BODY_FORMAT thay vì lỗi file', async () => {
    const response = await request(createTestApp())
      .post('/api/feedback/batch')
      .set('Authorization', `Bearer ${createToken('organizations')}`)
      .attach('wrongField', Buffer.from('feedback'), { filename: 'feedback.csv', contentType: 'text/csv' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      errorCode: 'INVALID_BODY_FORMAT'
    }));
  });
});
