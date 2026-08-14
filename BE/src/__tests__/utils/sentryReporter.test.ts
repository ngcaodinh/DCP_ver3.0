import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const callOrder: string[] = [];
  return {
    callOrder,
    loggerErrorMock: vi.fn(() => { callOrder.push('winston'); }),
    loggerWarnMock: vi.fn(),
    captureExceptionMock: vi.fn(() => { callOrder.push('sentry'); return 'event-id'; }),
    setTagMock: vi.fn(),
    setExtrasMock: vi.fn(),
    setUserMock: vi.fn(),
    isSentryEnabledMock: vi.fn(() => true)
  };
});

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: mocks.loggerWarnMock, error: mocks.loggerErrorMock })
}));

vi.mock('@sentry/node', () => ({
  captureException: mocks.captureExceptionMock,
  withScope: (callback: (scope: unknown) => void) => callback({
    setTag: mocks.setTagMock,
    setExtras: mocks.setExtrasMock,
    setUser: mocks.setUserMock
  })
}));

vi.mock('../../config/sentryConfig', () => ({
  isSentryEnabled: () => mocks.isSentryEnabledMock()
}));

import { runWithRequestContext } from '../../config/requestContext';
import { reportTerminalError } from '../../utils/sentryReporter';

beforeEach(() => {
  mocks.callOrder.length = 0;
  vi.clearAllMocks();
  mocks.isSentryEnabledMock.mockReturnValue(true);
});

describe('reportTerminalError', () => {
  it('ghi Winston trước khi bắn Sentry', () => {
    reportTerminalError('boom', new Error('boom'), { errorSource: 'http-5xx' });

    expect(mocks.callOrder).toEqual(['winston', 'sentry']);
  });

  it('vẫn ghi Winston khi Sentry tắt', () => {
    mocks.isSentryEnabledMock.mockReturnValue(false);

    reportTerminalError('boom', new Error('boom'), { errorSource: 'http-5xx' });

    expect(mocks.loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(mocks.captureExceptionMock).not.toHaveBeenCalled();
  });

  it('gắn correlation context và chuẩn hóa giá trị throw không phải Error', () => {
    runWithRequestContext({ requestId: 'req-42', userId: 'user_7' }, () => {
      reportTerminalError('boom', 'chuỗi lỗi thô', { errorSource: 'job-dlq' });
    });

    expect(mocks.setTagMock).toHaveBeenCalledWith('requestId', 'req-42');
    expect(mocks.setUserMock).toHaveBeenCalledWith({ id: 'user_7' });
    const capturedError = (mocks.captureExceptionMock.mock.calls as unknown[][])[0]?.[0];
    expect(capturedError).toEqual(expect.objectContaining({
      message: 'chuỗi lỗi thô'
    }));
  });

  it('nuốt lỗi của chính Sentry và ghi cảnh báo', () => {
    mocks.captureExceptionMock.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });

    expect(() => {
      reportTerminalError('boom', new Error('boom'), { errorSource: 'http-5xx' });
    }).not.toThrow();
    expect(mocks.loggerWarnMock).toHaveBeenCalled();
  });
});
