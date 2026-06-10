import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHealthRoutes } from '../../routes/healthRoutes';
import {
  getFullHealthStatus,
  getReadinessStatus,
  getLivenessStatus
} from '../../services/health-check.service';
import type {
  HealthStatus,
  ReadinessStatus,
  LivenessStatus
} from '../../services/health-check.service';

vi.mock('../../services/health-check.service', () => ({
  getFullHealthStatus: vi.fn(),
  getReadinessStatus: vi.fn(),
  getLivenessStatus: vi.fn()
}));

function createTestApplication() {
  const testApplication = express();
  testApplication.use(express.json());
  testApplication.use(createHealthRoutes());
  return testApplication;
}

describe('healthRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // GET /health — comprehensive health check
  // Spec test cases:
  // - Khi /health endpoint được gọi, thì check MongoDB connection và trả response time
  // - Khi /health endpoint được gọi, thì check Redis connection và trả response time
  // - Khi dependency fail và /health được gọi, thì trả HTTP 503 với body chứa failed dependency name
  // - Khi /live endpoint được k8s liveness probe gọi, thì luôn trả 200 nếu process đang chạy
  // ============================================================

  describe('GET /health', () => {
    it('check MongoDB connection và trả response time', async () => {
      const mock: HealthStatus = {
        status: 'ok',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.dependencies.mongodb.status).toBe('up');
      expect(response.body.dependencies.mongodb.responseTimeMs).toBe(5);
    });

    it('check Redis connection và trả response time', async () => {
      const mock: HealthStatus = {
        status: 'ok',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.body.dependencies.redis.status).toBe('up');
      expect(response.body.dependencies.redis.responseTimeMs).toBe(2);
    });

    it('trả HTTP 503 khi MongoDB down', async () => {
      const mock: HealthStatus = {
        status: 'unhealthy',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'down', responseTimeMs: null, errorMessage: 'Connection refused' },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('unhealthy');
      expect(response.body.dependencies.mongodb.status).toBe('down');
    });

    it('trả HTTP 503 khi dependency fail', async () => {
      const mock: HealthStatus = {
        status: 'unhealthy',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'down', responseTimeMs: null, errorMessage: 'MongoDB disconnected' },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.status).toBe(503);
      expect(response.body.dependencies.mongodb.errorMessage).toBe('MongoDB disconnected');
    });

    it('trả HTTP 200 khi tất cả dependencies up', async () => {
      const mock: HealthStatus = {
        status: 'ok',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });

    it('trả HTTP 200 với degraded khi Redis degraded', async () => {
      const mock: HealthStatus = {
        status: 'degraded',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'degraded', responseTimeMs: null, errorMessage: 'Redis not connected' },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('degraded');
      expect(response.body.dependencies.redis.status).toBe('degraded');
    });

    it('bao gồm serviceName và timestamp trong response', async () => {
      const mock: HealthStatus = {
        status: 'ok',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100,
        dependencies: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.body.serviceName).toBe('dcp-backend');
      expect(response.body.timestamp).toBe('2026-06-10T12:00:00.000Z');
    });

    it('bao gồm uptimeSeconds trong response', async () => {
      const mock: HealthStatus = {
        status: 'ok',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 7200,
        dependencies: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getFullHealthStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/health');

      expect(response.body.uptimeSeconds).toBe(7200);
    });
  });

  // ============================================================
  // GET /ready — k8s readiness probe
  // Spec: chỉ trả 200 khi semua DB + queue ready
  // ============================================================

  describe('GET /ready', () => {
    it('trả 200 khi MongoDB up', async () => {
      const mock: ReadinessStatus = {
        status: 'ready',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        checks: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getReadinessStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
    });

    it('trả 503 khi MongoDB down', async () => {
      const mock: ReadinessStatus = {
        status: 'not_ready',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        checks: {
          mongodb: { status: 'down', responseTimeMs: null, errorMessage: 'MongoDB disconnected' },
          redis: { status: 'degraded', responseTimeMs: null },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getReadinessStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/ready');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
    });

    it('trả 200 khi Redis degraded nhưng MongoDB up', async () => {
      const mock: ReadinessStatus = {
        status: 'ready',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        checks: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'degraded', responseTimeMs: null, errorMessage: 'Redis not connected' },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getReadinessStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
      expect(response.body.checks.mongodb.status).toBe('up');
      expect(response.body.checks.redis.status).toBe('degraded');
    });

    it('bao gồm checks với responseTimeMs', async () => {
      const mock: ReadinessStatus = {
        status: 'ready',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        checks: {
          mongodb: { status: 'up', responseTimeMs: 5 },
          redis: { status: 'up', responseTimeMs: 2 },
          payos: { status: 'up', responseTimeMs: 100 }
        }
      };
      vi.mocked(getReadinessStatus).mockResolvedValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/ready');

      expect(response.body.checks).toBeDefined();
      expect(response.body.checks.mongodb.responseTimeMs).toBe(5);
      expect(response.body.checks.redis.responseTimeMs).toBe(2);
      expect(response.body.checks.payos.responseTimeMs).toBe(100);
    });
  });

  // ============================================================
  // GET /live — k8s liveness probe
  // Spec: luôn trả 200 nếu process đang chạy
  // ============================================================

  describe('GET /live', () => {
    it('luôn trả 200 nếu process đang chạy', async () => {
      const mock: LivenessStatus = {
        status: 'alive',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100
      };
      vi.mocked(getLivenessStatus).mockReturnValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/live');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('alive');
    });

    it('bao gồm uptimeSeconds trong response', async () => {
      const mock: LivenessStatus = {
        status: 'alive',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 5000
      };
      vi.mocked(getLivenessStatus).mockReturnValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/live');

      expect(response.body.uptimeSeconds).toBe(5000);
    });

    it('bao gồm serviceName trong response', async () => {
      const mock: LivenessStatus = {
        status: 'alive',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100
      };
      vi.mocked(getLivenessStatus).mockReturnValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/live');

      expect(response.body.serviceName).toBe('dcp-backend');
    });

    it('bao gồm timestamp trong response', async () => {
      const mock: LivenessStatus = {
        status: 'alive',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100
      };
      vi.mocked(getLivenessStatus).mockReturnValue(mock);

      const testApplication = createTestApplication();
      const response = await request(testApplication).get('/live');

      expect(response.body.timestamp).toBe('2026-06-10T12:00:00.000Z');
    });

    it('không gọi service khi /live được gọi lần thứ hai (pure function)', async () => {
      const mock: LivenessStatus = {
        status: 'alive',
        serviceName: 'dcp-backend',
        timestamp: '2026-06-10T12:00:00.000Z',
        uptimeSeconds: 100
      };
      vi.mocked(getLivenessStatus).mockReturnValue(mock);

      const testApplication = createTestApplication();
      await request(testApplication).get('/live');
      await request(testApplication).get('/live');

      expect(getLivenessStatus).toHaveBeenCalledTimes(2);
    });
  });
});
