/**
 * Unit tests cho notificationController.ts — E3 Notification API Endpoints.
 * Test cac chuc nang: mark single read, delete, unread count, preferences, get list, unsubscribe, SSE stream.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authenticationMiddleware';

/**
 * Mock config/logger
 */
vi.mock('../../config/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}));

/**
 * Mock notificationService
 */
vi.mock('../../services/notificationService', () => ({
  getUserNotifications: vi.fn(),
  markAllUserNotificationsAsRead: vi.fn(),
  markNotificationAsRead: vi.fn(),
  getUserPreferences: vi.fn(),
  updateUserPreferences: vi.fn(),
  deleteUserNotification: vi.fn(),
  getUnreadCount: vi.fn(),
  processUnsubscribe: vi.fn()
}));

/**
 * Mock notificationEvents
 */
vi.mock('../../events/notificationEvents', () => ({
  notificationEvents: {
    emit: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}));

/**
 * Mock ApplicationError
 */
const { ApplicationError } = vi.hoisted(() => {
  class ApplicationError extends Error {
    public readonly statusCode: number;
    public readonly errorCode: string;

    constructor(message: string, statusCode: number, errorCode: string) {
      super(message);
      this.name = 'ApplicationError';
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  return { ApplicationError };
});

vi.mock('../../utils/applicationError', () => ({
  ApplicationError
}));

/**
 * Mock NotificationValidationError — hoisted BEFORE vi.mock so the factory can reference it.
 * Renamed to MockNVE to avoid shadowing the imported mock.
 */
const MockNVE = vi.hoisted<new (code: 'INVALID_TYPE' | 'INVALID_CHANNEL', message: string) => {
  code: 'INVALID_TYPE' | 'INVALID_CHANNEL';
  name: string;
  message: string;
}>(() => {
  class NotificationValidationError extends Error {
    public readonly code: 'INVALID_TYPE' | 'INVALID_CHANNEL';

    constructor(code: 'INVALID_TYPE' | 'INVALID_CHANNEL', message: string) {
      super(message);
      this.name = 'NotificationValidationError';
      this.code = code;
    }
  }
  return NotificationValidationError;
});

vi.mock('../../services/constants/notification.constants', () => ({
  NotificationValidationError: MockNVE
}));

import {
  markAllUserNotificationsAsRead,
  markNotificationAsRead,
  getUserPreferences,
  updateUserPreferences,
  deleteUserNotification,
  getUnreadCount
} from '../../services/notificationService';

import {
  markNotificationAsReadController,
  deleteNotificationController,
  getUnreadCountController,
  getNotificationsController,
  unsubscribeController,
  streamNotificationsController,
  markAllNotificationsAsReadController,
  getNotificationPreferencesController,
  updateNotificationPreferencesController
} from '../../controllers/notificationController';

type MockAuthenticatedRequest = Partial<AuthenticatedRequest> & {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

/**
 * Tao mock AuthenticatedRequest voi cac overrides.
 */
function buildMockRequest(overrides: MockAuthenticatedRequest = {}): AuthenticatedRequest {
  return {
    authenticatedUser: overrides.authenticatedUser !== undefined
      ? overrides.authenticatedUser
      : { userId: 'test-user-id', role: 'donor' },
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body ?? {}
  } as unknown as AuthenticatedRequest;
}

/**
 * Tao mock Response voi tracking.
 */
function buildMockResponse(): {
  response: Response;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
} {
  const jsonMock = vi.fn();
  const statusMock = vi.fn(() => ({ json: jsonMock })) as unknown as ReturnType<typeof vi.fn>;
  const response = {
    status: statusMock,
    json: jsonMock,
    setHeader: vi.fn(),
    flushHeaders: vi.fn()
  } as unknown as Response;
  return { response, statusMock, jsonMock };
}

describe('notificationController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── markNotificationAsReadController ─────────────────────────────────────

  describe('markNotificationAsReadController', () => {
    it('tra 400 khi id rong', async () => {
      const req = buildMockRequest({ params: {} });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await markNotificationAsReadController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'INVALID_NOTIFICATION_ID'
      }));
    });

    it('tra 404 khi notification khong tim thay', async () => {
      vi.mocked(markNotificationAsRead).mockResolvedValue(null);

      const req = buildMockRequest({ params: { id: 'NOTI-123' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await markNotificationAsReadController(req, response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'NOTIFICATION_NOT_FOUND'
      }));
    });

    it('tra 200 khi thanh cong', async () => {
      vi.mocked(markNotificationAsRead).mockResolvedValue({ notificationId: 'NOTI-123' } as never);

      const req = buildMockRequest({ params: { id: 'NOTI-123' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await markNotificationAsReadController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined, params: { id: 'NOTI-123' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await markNotificationAsReadController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  // ─── getNotificationPreferencesController ──────────────────────────────────

  describe('getNotificationPreferencesController', () => {
    it('tra 200 voi preferences khi thanh cong', async () => {
      const mockPrefs = {
        globalEnabled: true,
        preferences: {
          LARGE_DONATION: { IN_APP: true, EMAIL: true }
        }
      };
      vi.mocked(getUserPreferences).mockResolvedValue(mockPrefs);

      const req = buildMockRequest();
      const { response, jsonMock, statusMock } = buildMockResponse();

      await getNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: mockPrefs
      }));
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await getNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  // ─── updateNotificationPreferencesController ───────────────────────────────

  describe('updateNotificationPreferencesController', () => {
    it('tra 400 khi globalEnabled khong phai boolean', async () => {
      const req = buildMockRequest({ body: { globalEnabled: 'yes' as never } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await updateNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'VALIDATION_ERROR'
      }));
    });

    it('tra 400 khi preferences khong phai object', async () => {
      const req = buildMockRequest({ body: { preferences: 'invalid' as never } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await updateNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'VALIDATION_ERROR'
      }));
    });

    it('tra 200 khi update thanh cong', async () => {
      const mockUpdated = {
        globalEnabled: false,
        preferences: { LARGE_DONATION: { EMAIL: false } }
      };
      vi.mocked(updateUserPreferences).mockResolvedValue(mockUpdated);

      const req = buildMockRequest({
        body: { globalEnabled: false, preferences: { LARGE_DONATION: { EMAIL: false } } }
      });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await updateNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: mockUpdated
      }));
    });

    it('tra 400 khi notification type khong hop le', async () => {
      vi.mocked(updateUserPreferences).mockRejectedValue(
        new MockNVE('INVALID_TYPE', 'Loại thông báo không hợp lệ: INVALID_TYPE')
      );

      const req = buildMockRequest({
        body: { preferences: { INVALID_TYPE: { IN_APP: true } } }
      });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await updateNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'INVALID_TYPE'
      }));
    });

    it('tra 400 khi channel khong hop le', async () => {
      vi.mocked(updateUserPreferences).mockRejectedValue(
        new MockNVE('INVALID_CHANNEL', 'Kênh không hợp lệ: FAX')
      );

      const req = buildMockRequest({
        body: { preferences: { LARGE_DONATION: { FAX: true } } }
      });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await updateNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'INVALID_CHANNEL'
      }));
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined, body: {} });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await updateNotificationPreferencesController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  // ─── markAllNotificationsAsReadController ────────────────────────────────────

  describe('markAllNotificationsAsReadController', () => {
    it('tra 200 khi thanh cong', async () => {
      vi.mocked(markAllUserNotificationsAsRead).mockResolvedValue({
        notifications: [],
        unreadCount: 0
      });

      const req = buildMockRequest();
      const { response, jsonMock, statusMock } = buildMockResponse();

      await markAllNotificationsAsReadController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await markAllNotificationsAsReadController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  // ─── deleteNotificationController ────────────────────────────────────────────

  describe('deleteNotificationController', () => {
    it('tra 200 khi xoa thanh cong', async () => {
      vi.mocked(deleteUserNotification).mockResolvedValue(true);

      const req = buildMockRequest({ params: { id: 'NOTI-123' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await deleteNotificationController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });

    it('tra 400 khi id rong', async () => {
      const req = buildMockRequest({ params: { id: '' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await deleteNotificationController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'INVALID_NOTIFICATION_ID'
      }));
    });

    it('tra 404 khi notification khong ton tai hoac khong thuoc user', async () => {
      vi.mocked(deleteUserNotification).mockResolvedValue(false);

      const req = buildMockRequest({ params: { id: 'NOTI-NONEXISTENT' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await deleteNotificationController(req, response);

      expect(statusMock).toHaveBeenCalledWith(404);
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined, params: { id: 'NOTI-123' } });
      const { response, statusMock } = buildMockResponse();

      await deleteNotificationController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  // ─── getUnreadCountController ────────────────────────────────────────────────

  describe('getUnreadCountController', () => {
    it('tra 200 voi unreadCount dung', async () => {
      vi.mocked(getUnreadCount).mockResolvedValue(5);

      const req = buildMockRequest();
      const { response, jsonMock, statusMock } = buildMockResponse();

      await getUnreadCountController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: { unreadCount: 5 }
      }));
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined });
      const { response, statusMock } = buildMockResponse();

      await getUnreadCountController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });
  });

  // ─── getNotificationsController ────────────────────────────────────────────────

  describe('getNotificationsController', () => {
    it('tra 200 voi danh sach thong bao', async () => {
      const mockResult = {
        notifications: [],
        unreadCount: 0,
        pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasNextPage: false }
      };
      const getUserNotificationsPaginated = vi.fn().mockResolvedValue(mockResult);
      vi.mocked(await import('../../controllers/notificationController')).merge.mockResolvedValue({
        ...vi.importedActual<typeof import('../../controllers/notificationController')>(),
        getUserNotificationsPaginated
      });

      const req = buildMockRequest({ query: { page: '1', limit: '10' } });
      const { response, jsonMock, statusMock } = buildMockResponse();

      await getNotificationsController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: mockResult
      }));
    });

    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined, query: {} });
      const { response, statusMock } = buildMockResponse();

      await getNotificationsController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('gioi han limit at 20 theo spec', async () => {
      const getUserNotificationsPaginated = vi.fn().mockResolvedValue({
        notifications: [],
        unreadCount: 0,
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false }
      });
      vi.mocked(await import('../../controllers/notificationController')).merge.mockResolvedValue({
        ...vi.importedActual<typeof import('../../controllers/notificationController')>(),
        getUserNotificationsPaginated
      });

      const req = buildMockRequest({ query: { limit: '100' } });
      const { response, jsonMock } = buildMockResponse();

      await getNotificationsController(req, response);

      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          pagination: expect.objectContaining({ limit: 20 })
        })
      }));
    });
  });

  // ─── unsubscribeController ────────────────────────────────────────────────────

  describe('unsubscribeController', () => {
    it('tra 400 khi token rong', async () => {
      const req = { query: {} } as { query: { token?: string } };
      const { response, jsonMock, statusMock } = buildMockResponse();

      await unsubscribeController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'INVALID_TOKEN'
      }));
    });

    it('tra 400 khi token khong dung do dai', async () => {
      const req = { query: { token: 'abc123' } } as { query: { token?: string } };
      const { response, statusMock } = buildMockResponse();

      await unsubscribeController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
    });

    it('tra 400 khi token khong dung dinh dang hex', async () => {
      const req = { query: { token: 'INVALID'.padEnd(64, 'Z') } } as { query: { token?: string } };
      const { response, statusMock } = buildMockResponse();

      await unsubscribeController(req, response);

      expect(statusMock).toHaveBeenCalledWith(400);
    });

    it('tra 404 khi token khong ton tai', async () => {
      vi.mocked(processUnsubscribe).mockResolvedValue(false);

      const req = { query: { token: 'a'.repeat(64) } } as { query: { token?: string } };
      const { response, jsonMock, statusMock } = buildMockResponse();

      await unsubscribeController(req, response);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'TOKEN_NOT_FOUND'
      }));
    });

    it('tra 200 khi unsubscribe thanh cong', async () => {
      vi.mocked(processUnsubscribe).mockResolvedValue(true);

      const req = { query: { token: 'a'.repeat(64) } } as { query: { token?: string } };
      const { response, jsonMock, statusMock } = buildMockResponse();

      await unsubscribeController(req, response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: { unsubscribed: true }
      }));
    });
  });

  // ─── streamNotificationsController ───────────────────────────────────────────

  describe('streamNotificationsController', () => {
    it('tra 401 khi chua xac thuc', async () => {
      const req = buildMockRequest({ authenticatedUser: undefined }) as unknown as Parameters<typeof streamNotificationsController>[0];
      const { response, statusMock } = buildMockResponse();

      await streamNotificationsController(req, response);

      expect(statusMock).toHaveBeenCalledWith(401);
    });

    it('setHeader SSE headers', async () => {
      const req = buildMockRequest() as unknown as Parameters<typeof streamNotificationsController>[0];
      const { response } = buildMockResponse();

      await streamNotificationsController(req, response);

      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
      expect(response.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    });
  });
});
