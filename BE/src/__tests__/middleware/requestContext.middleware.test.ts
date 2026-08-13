import express, { Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { getRequestId } from '../../config/requestContext';
import { requestContextMiddleware } from '../../middleware/requestContext.middleware';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Tạo Express app tối giản để kiểm tra header và ALS như request thật. */
function buildTestApp() {
  const app = express();
  app.use(requestContextMiddleware);
  app.get('/probe', (_request, response) => response.json({ requestId: getRequestId() }));
  return app;
}

describe('E6 — correlation ID', () => {
  it('giữ nguyên X-Request-ID hợp lệ và echo về response', async () => {
    const response = await request(buildTestApp())
      .get('/probe')
      .set('X-Request-ID', 'client-supplied-id-123');

    expect(response.body.requestId).toBe('client-supplied-id-123');
    expect(response.headers['x-request-id']).toBe('client-supplied-id-123');
  });

  it('sinh UUID v4 khi thiếu header', async () => {
    const response = await request(buildTestApp()).get('/probe');
    expect(response.body.requestId).toMatch(UUID_V4_PATTERN);
  });

  it.each(['abc\ndef', 'a'.repeat(129), ''])('từ chối header không an toàn: %s', (headerValue) => {
    let observedRequestId: string | null = null;
    const response = { setHeader: vi.fn() } as unknown as Response;
    const requestObject = { headers: { 'x-request-id': headerValue } } as unknown as Request;

    requestContextMiddleware(requestObject, response, () => {
      observedRequestId = getRequestId();
    });

    expect(observedRequestId).toMatch(UUID_V4_PATTERN);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-ID', observedRequestId);
  });

  it('không chặn request khi set response header ném lỗi', () => {
    const next = vi.fn();
    const response = {
      setHeader: vi.fn(() => {
        throw new Error('header failure');
      })
    } as unknown as Response;

    requestContextMiddleware({ headers: {} } as Request, response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('không lẫn context giữa các request chạy song song', async () => {
    const app = buildTestApp();
    const responses = await Promise.all([
      request(app).get('/probe').set('X-Request-ID', 'req-A'),
      request(app).get('/probe').set('X-Request-ID', 'req-B'),
      request(app).get('/probe').set('X-Request-ID', 'req-C')
    ]);

    expect(responses.map((response) => response.body.requestId)).toEqual(['req-A', 'req-B', 'req-C']);
  });

  it('giữ requestId qua nhiều tầng async', async () => {
    const app = express();
    app.use(requestContextMiddleware);
    app.get('/deep', async (_request, response) => {
      const repositoryLayer = async () => getRequestId();
      const serviceLayer = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return repositoryLayer();
      };
      response.json({ requestId: await serviceLayer() });
    });

    const response = await request(app).get('/deep').set('X-Request-ID', 'deep-trace');
    expect(response.body.requestId).toBe('deep-trace');
  });
});
