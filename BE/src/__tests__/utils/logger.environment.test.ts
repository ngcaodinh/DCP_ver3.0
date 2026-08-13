import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnvironment = { ...process.env };

/** Khôi phục environment sau mỗi profile để module logger được kiểm thử độc lập. */
function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
}

/** Đếm DailyRotateFile transport để xác nhận profile không tạo artifact ngoài ý muốn. */
function countFileTransports(transports: readonly { constructor: { name: string } }[]): number {
  return transports.filter(transport => transport.constructor.name === 'DailyRotateFile').length;
}

describe('logger environment profiles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    restoreEnvironment();
  });

  it('LOG_DRIVER=console dùng console fallback và không tạo file transport', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_DRIVER', 'console');
    vi.stubEnv('LOG_FILE_ENABLED', 'true');
    vi.resetModules();

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { getLogger } = await import('../../config/logger');
    const { winstonLogger } = await import('../../utils/logger');

    const rawReasonSecret = 'console-reason-secret';
    getLogger().info('console profile', {
      amount: 500000,
      reason: `apiKey=${rawReasonSecret}`
    });

    expect(consoleLogSpy).toHaveBeenCalledWith('console profile', {
      amount: '***VND',
      reason: '[REASON_REDACTED]'
    });
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(rawReasonSecret);
    expect(countFileTransports(winstonLogger.transports)).toBe(0);
  });

  it('LOG_FILE_ENABLED=false không tạo DailyRotateFile hoặc audit transport', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_DRIVER', 'winston');
    vi.stubEnv('LOG_FILE_ENABLED', 'false');
    vi.resetModules();

    const { winstonLogger } = await import('../../utils/logger');

    expect(countFileTransports(winstonLogger.transports)).toBe(0);
  });

  it('NODE_ENV=test không tạo DailyRotateFile hoặc audit transport', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('LOG_DRIVER', 'winston');
    vi.stubEnv('LOG_FILE_ENABLED', 'true');
    vi.resetModules();

    const { winstonLogger } = await import('../../utils/logger');

    expect(countFileTransports(winstonLogger.transports)).toBe(0);
  });
});
