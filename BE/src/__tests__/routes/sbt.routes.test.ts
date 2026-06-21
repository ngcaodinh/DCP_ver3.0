/**
 * Integration tests cho sbt routes — kiểm tra route layer với middleware.
 * Test auth + role authorization (không test service logic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock express-rate-limit trước để tránh lỗi request.ip
vi.mock('express-rate-limit', () => ({
  default: vi.fn(() => (_req: Request, _res: Response, next: NextFunction) => next())
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()
  })
}));

vi.mock('../../services/sbtMintService', () => ({
  rerunSbtMintJob: vi.fn()
}));

vi.mock('../../models/sbtMintDlqModel', () => ({
  findSbtMintDlqByStatus: vi.fn().mockResolvedValue([]),
  countSbtMintDlqByStatus: vi.fn().mockResolvedValue(0)
}));

vi.mock('../../middleware/authenticationMiddleware', () => ({
  createAuthenticationMiddleware: () => {
    return (req: Request, _res: Response, next: NextFunction): void => {
      // Tách authenticate header để test có thể inject user
      const authHeader = req.headers['authorization'];
      if (authHeader === 'Bearer test-token-admin') {
        (req as unknown as { authenticatedUser?: { userId: string; role: string } }).authenticatedUser = {
          userId: 'admin-1',
          role: 'admin'
        };
      } else if (authHeader === 'Bearer test-token-oracle') {
        (req as unknown as { authenticatedUser?: { userId: string; role: string } }).authenticatedUser = {
          userId: 'oracle-1',
          role: 'oracle'
        };
      } else if (authHeader === 'Bearer test-token-donor') {
        (req as unknown as { authenticatedUser?: { userId: string; role: string } }).authenticatedUser = {
          userId: 'donor-1',
          role: 'donor'
        };
      }
      next();
    };
  }
}));

vi.mock('../../middleware/roleAuthorizationMiddleware', () => ({
  createRoleAuthorizationMiddleware: (allowedRoles: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      const user = (req as unknown as { authenticatedUser?: { userId: string; role: string } }).authenticatedUser;
      if (!user) {
        res.status(401).json({ error: 'Không có quyền truy cập.' });
        return;
      }
      if (!allowedRoles.includes(user.role)) {
        res.status(403).json({ error: 'Không có quyền thực hiện hành động này.' });
        return;
      }
      next();
    };
  }
}));

// Import sau mock để đảm bảo mocks được áp dụng
import { createSbtRoutes } from '../../routes/sbt.routes';
import { rerunSbtMintJob } from '../../services/sbtMintService';

// ─── App Setup ────────────────────────────────────────────────────────────────

function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/sbt', createSbtRoutes());
  return app;
}

// Simple supertest-like helper
async function request(app: Express, method: 'get' | 'post', path: string, options?: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url: path,
      headers: options?.headers ?? {},
      body: options?.body ?? {},
      query: {},
      params: {},
      path,
      baseUrl: '',
      get: (name: string) => options?.headers?.[name.toLowerCase()] ?? null
    } as unknown as Request;

    // Simple response mock
    let statusCode = 200;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        resolve({ status: statusCode, body });
        return res;
      }
    } as unknown as Response;

    // Route matching đơn giản
    const router = createSbtRoutes();
    const testReq = {
      ...req,
      method: method.toUpperCase(),
      originalUrl: path,
      baseUrl: '/api/sbt'
    } as unknown as Request;

    if (method === 'get' && path === '/api/sbt/dlq') {
      const handler = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: (req: Request, res: Response, next: NextFunction) => void }> }).stack
        .find(layer => layer.route?.path === '/dlq' && layer.route?.methods['get']);
      if (handler) {
        handler.handle(testReq, res, () => {});
      }
    } else if (method === 'post' && path.startsWith('/api/sbt/retry-job/')) {
      const mintRequestId = path.split('/').pop() ?? '';
      const handler = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: (req: Request, res: Response, next: NextFunction) => void }> }).stack
        .find(layer => layer.route?.path === '/retry-job/:mintRequestId' && layer.route?.methods['post']);
      if (handler) {
        (testReq as unknown as { params: { mintRequestId: string } }).params = { mintRequestId };
        handler.handle(testReq, res, () => {});
      }
    } else if (method === 'post' && path === '/api/sbt/admin-mint') {
      const handler = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: (req: Request, res: Response, next: NextFunction) => void }> }).stack
        .find(layer => layer.route?.path === '/admin-mint' && layer.route?.methods['post']);
      if (handler) {
        handler.handle(testReq, res, () => {});
      }
    }
  });
}

// ─── Tests: GET /api/sbt/dlq ──────────────────────────────────────────────────

describe('sbt routes - GET /api/sbt/dlq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unauthorized (no token) → 401', async () => {
    const app = createTestApp();
    const res = await request(app, 'get', '/api/sbt/dlq');
    expect(res.status).toBe(401);
  });

  it('non-admin role (donor) → 403', async () => {
    const app = createTestApp();
    const res = await request(app, 'get', '/api/sbt/dlq', {
      headers: { authorization: 'Bearer test-token-donor' }
    });
    expect(res.status).toBe(403);
  });

  it('oracle role → 403 (only admin allowed)', async () => {
    const app = createTestApp();
    const res = await request(app, 'get', '/api/sbt/dlq', {
      headers: { authorization: 'Bearer test-token-oracle' }
    });
    expect(res.status).toBe(403);
  });

  it('admin → 200', async () => {
    const app = createTestApp();
    const res = await request(app, 'get', '/api/sbt/dlq', {
      headers: { authorization: 'Bearer test-token-admin' }
    });
    expect(res.status).toBe(200);
  });
});

// ─── Tests: POST /api/sbt/retry-job/:mintRequestId ───────────────────────────

describe('sbt routes - POST /api/sbt/retry-job/:mintRequestId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unauthorized (no token) → 401', async () => {
    const app = createTestApp();
    const res = await request(app, 'post', '/api/sbt/retry-job/SBT-MINT-123');
    expect(res.status).toBe(401);
  });

  it('non-admin role (donor) → 403', async () => {
    const app = createTestApp();
    const res = await request(app, 'post', '/api/sbt/retry-job/SBT-MINT-123', {
      headers: { authorization: 'Bearer test-token-donor' }
    });
    expect(res.status).toBe(403);
  });

  it('oracle role → 403 (only admin allowed)', async () => {
    const app = createTestApp();
    const res = await request(app, 'post', '/api/sbt/retry-job/SBT-MINT-123', {
      headers: { authorization: 'Bearer test-token-oracle' }
    });
    expect(res.status).toBe(403);
  });

  it('admin → gọi service + 200', async () => {
    (rerunSbtMintJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: { mintRequestId: 'SBT-MINT-123', sbtId: 'SBT-001', status: 'PENDING', attemptNumber: 0 },
      jobId: 'job-1',
      enqueued: true
    });

    const app = createTestApp();
    const res = await request(app, 'post', '/api/sbt/retry-job/SBT-MINT-123', {
      headers: { authorization: 'Bearer test-token-admin' }
    });

    expect(res.status).toBe(200);
    expect(rerunSbtMintJob).toHaveBeenCalledWith('SBT-MINT-123', 'admin-1');
  });
});

// ─── Tests: POST /api/sbt/admin-mint ─────────────────────────────────────────

describe('sbt routes - POST /api/sbt/admin-mint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unauthorized (no token) → 401', async () => {
    const app = createTestApp();
    const res = await request(app, 'post', '/api/sbt/admin-mint');
    expect(res.status).toBe(401);
  });

  it('admin → 403 (endpoint bị cấm)', async () => {
    const app = createTestApp();
    const res = await request(app, 'post', '/api/sbt/admin-mint', {
      headers: { authorization: 'Bearer test-token-admin' }
    });
    expect(res.status).toBe(403);
    const body = res.body as { error?: string };
    expect(body.error).toContain('bị cấm');
  });
});

// ─── Tests: POST /api/oracle/sbt-trigger (sbt-trigger route) ──────────────────

// Import sau mock để mocks được áp dụng trước
import { createSbtTriggerRoutes } from '../../routes/sbt-trigger.routes';
import { triggerSbtMintFromOracle } from '../../services/sbt-trigger.service';
import { isTransactionStuck } from '../../services/sbt-trigger.service';

vi.mock('../../services/sbt-trigger.service', () => ({
  triggerSbtMintFromOracle: vi.fn(),
  isTransactionStuck: vi.fn()
}));

function createSbtTriggerTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/oracle', createSbtTriggerRoutes());
  return app;
}

const VALID_TRIGGER_BODY = {
  verificationId: 'ver-123e4567-e89b-12d3-a456-426614174000',
  projectId: 'proj-123e4567-e89b-12d3-a456-426614174000',
  organizationId: 'org-123e4567-e89b-12d3-a456-426614174000',
  beneficiaryAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  projectIdNumeric: 42,
  milestone: 1,
  beneficiaryCount: 10,
  gpsCoordinates: '10.8231,106.6297',
  imageCid: 'QmTzQ1JRkWErjk39mryYw2WVenhAZmvR4nYLvMMHvwRag',
  tokenUri: 'ipfs://QmTzQ1JRkWErjk39mryYw2WVenhAZmvR4nYLvMMHvwRag'
};

function createSbtTriggerRequest(app: Express, method: 'post', path: string, options?: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url: path,
      headers: options?.headers ?? {},
      body: options?.body ?? {},
      query: {},
      params: {},
      path,
      baseUrl: '',
      get: (name: string) => options?.headers?.[name.toLowerCase()] ?? null
    } as unknown as Request;

    let statusCode = 200;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        resolve({ status: statusCode, body });
        return res;
      }
    } as unknown as Response;

    const router = createSbtTriggerRoutes();
    const testReq = {
      ...req,
      method: method.toUpperCase(),
      originalUrl: path,
      baseUrl: '/api/oracle'
    } as unknown as Request;

    const handler = (router as unknown as {
      stack: Array<{
        route?: { path: string; methods: Record<string, boolean> };
        handle: (req: Request, res: Response, next: NextFunction) => void;
      }>;
    }).stack
      .find(layer => layer.route?.path === '/sbt-trigger' && layer.route?.methods['post']);

    if (handler) {
      handler.handle(testReq, res, () => {});
    } else {
      resolve({ status: 404, body: { error: 'Route not found' } });
    }
  });
}

describe('sbt routes - POST /api/oracle/sbt-trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unauthorized (no token) → 401', async () => {
    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      body: VALID_TRIGGER_BODY
    });
    expect(res.status).toBe(401);
  });

  it('non-oracle role (admin) → 403', async () => {
    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      headers: { authorization: 'Bearer test-token-admin' },
      body: VALID_TRIGGER_BODY
    });
    expect(res.status).toBe(403);
  });

  it('non-oracle role (donor) → 403', async () => {
    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      headers: { authorization: 'Bearer test-token-donor' },
      body: VALID_TRIGGER_BODY
    });
    expect(res.status).toBe(403);
  });

  it('oracle role → gọi service + 201 (new request)', async () => {
    const mockRecord = {
      sbtId: 'SBT-test-uuid',
      mintRequestId: 'SBT-MINT-test-uuid',
      status: 'PENDING',
      transactionHash: null
    };
    (triggerSbtMintFromOracle as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: mockRecord,
      duplicate: false,
      enqueued: true
    });
    (isTransactionStuck as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      headers: { authorization: 'Bearer test-token-oracle' },
      body: VALID_TRIGGER_BODY
    });

    expect(res.status).toBe(201);
    expect(triggerSbtMintFromOracle).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationId: VALID_TRIGGER_BODY.verificationId,
        beneficiaryAddress: VALID_TRIGGER_BODY.beneficiaryAddress
      })
    );
  });

  it('oracle role → 200 (duplicate request)', async () => {
    const mockRecord = {
      sbtId: 'SBT-existing',
      mintRequestId: 'SBT-MINT-existing',
      status: 'PENDING',
      transactionHash: '0xabc123'
    };
    (triggerSbtMintFromOracle as ReturnType<typeof vi.fn>).mockResolvedValue({
      record: mockRecord,
      duplicate: true,
      enqueued: false
    });
    (isTransactionStuck as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      headers: { authorization: 'Bearer test-token-oracle' },
      body: VALID_TRIGGER_BODY
    });

    expect(res.status).toBe(200);
    const body = res.body as { data?: { duplicate?: boolean } };
    expect(body.data?.duplicate).toBe(true);
  });

  it('oracle role → 400 khi thiếu required fields', async () => {
    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      headers: { authorization: 'Bearer test-token-oracle' },
      body: { verificationId: 'ver-123' } // missing other required fields
    });

    expect(res.status).toBe(400);
    expect(triggerSbtMintFromOracle).not.toHaveBeenCalled();
  });

  it('oracle role → 400 khi beneficiaryAddress không hợp lệ', async () => {
    const app = createSbtTriggerTestApp();
    const res = await createSbtTriggerRequest(app, 'post', '/api/oracle/sbt-trigger', {
      headers: { authorization: 'Bearer test-token-oracle' },
      body: { ...VALID_TRIGGER_BODY, beneficiaryAddress: 'invalid-address' }
    });

    expect(res.status).toBe(400);
    const body = res.body as { details?: unknown };
    expect(body.details).toBeDefined();
    expect(triggerSbtMintFromOracle).not.toHaveBeenCalled();
  });
});
