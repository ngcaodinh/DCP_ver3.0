import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import winston from 'winston';
import { runWithRequestContext, runWithWorkerContext, setRequestUser } from '../../config/requestContext';
import { getLogger } from '../../config/logger';
import {
  combinedFileTransportOptions,
  createSafeErrorJsonFormat,
  errorFileTransportOptions,
  exceptionFileTransportOptions,
  rejectionFileTransportOptions,
  winstonLogger
} from '../../utils/logger';

/** Bắt record Winston đã format để test schema mà không đọc file log. */
function captureLogOutput(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  winstonLogger.on('data', (info) => entries.push(info));
  return entries;
}

describe('E6 — Winston structured logging', () => {
  afterEach(() => {
    winstonLogger.removeAllListeners('data');
    vi.clearAllMocks();
  });

  it('gồm timestamp, level, message, requestId, userId và service', () => {
    const entries = captureLogOutput();

    runWithRequestContext({ requestId: 'req-tc1', userId: null }, () => {
      setRequestUser('user_123');
      getLogger().info('Donation confirmed', { projectId: 'proj_88' });
    });

    expect(entries.at(-1)).toMatchObject({
      level: 'info',
      message: 'Donation confirmed',
      requestId: 'req-tc1',
      userId: 'user_123',
      service: 'dcp-backend',
      meta: { projectId: 'proj_88' }
    });
    expect(entries.at(-1)?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries.at(-1)?.['@timestamp']).toBe(entries.at(-1)?.timestamp);
    expect(entries.at(-1)?.['@version']).toBe('1');
  });

  it('trả requestId và userId null ngoài request scope', () => {
    const entries = captureLogOutput();
    getLogger().info('Bootstrap done');

    expect(entries.at(-1)).toMatchObject({ requestId: null, userId: null });
    expect(entries.at(-1)).not.toHaveProperty('meta');
  });

  it('gắn worker run ID vào envelope khi log ngoài HTTP request', () => {
    const entries = captureLogOutput();

    runWithWorkerContext('data-mapper', () => {
      getLogger().info('Data mapper cycle started', { jobId: 'job-42' });
    });

    expect(entries.at(-1)).toMatchObject({
      requestId: expect.stringMatching(/^data-mapper:/),
      userId: null,
      workerName: 'data-mapper',
      workerRunId: expect.stringMatching(/^data-mapper:/),
      meta: { jobId: 'job-42' }
    });
  });

  it('che amount và không để lọt giá trị thật vào record', () => {
    const entries = captureLogOutput();
    getLogger().info('Donation received', { amount: 500000 });

    const entry = entries.at(-1)!;
    expect((entry.meta as Record<string, unknown>).amount).toBe('***VND');
    expect(JSON.stringify(entry)).not.toContain('500000');
  });

  it('rút gọn wallet address thành first6 + last4', () => {
    const entries = captureLogOutput();
    const fullAddress = '0xabcdef1234567890abcdef1234567890abcdwxyz';
    getLogger().info('Wallet linked', { walletAddress: fullAddress });

    const meta = entries.at(-1)!.meta as Record<string, unknown>;
    expect(meta.walletAddress).toBe('0xabcd...wxyz');
    expect(JSON.stringify(meta)).not.toContain(fullAddress);
  });

  it('redact metadata lồng nhau trước khi Winston nhận record', () => {
    const entries = captureLogOutput();
    const fullAddress = '0xabcdef1234567890abcdef1234567890abcdwxyz';

    getLogger().info('Nested metadata', {
      context: {
        sessionId: 'session-raw',
        ipAddress: '192.0.2.1',
        walletAddress: fullAddress,
        amount: 500000
      }
    });

    const entry = entries.at(-1)!;
    expect(entry.meta).toEqual({
      context: {
        sessionId: '[SESSION_REDACTED]',
        ipAddress: '[IP_REDACTED]',
        walletAddress: '0xabcd...wxyz',
        amount: '***VND'
      }
    });
    expect(JSON.stringify(entry)).not.toContain('session-raw');
    expect(JSON.stringify(entry)).not.toContain('192.0.2.1');
    expect(JSON.stringify(entry)).not.toContain('500000');
  });

  it('sanitize raw stack cho record exception/rejection qua in-memory transport', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        chunks.push(chunk.toString());
        callback();
      }
    });
    const exceptionLogger = winston.createLogger({
      format: createSafeErrorJsonFormat(),
      transports: [new winston.transports.Stream({ stream })],
      exitOnError: false
    });
    const rawStack = 'Error: https://user:password@example.com?apiKey=secret\n'
      + 'at handler (0xabcdef1234567890abcdef1234567890abcdef12)';

    exceptionLogger.log({ level: 'error', message: rawStack, stack: rawStack, exception: true });
    exceptionLogger.log({ level: 'error', message: rawStack, stack: rawStack, rejection: true });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    const output = chunks.join('');
    expect(output).not.toBe('');
    expect(output).not.toContain('password');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('0xabcdef1234567890abcdef1234567890abcdef12');
    exceptionLogger.close();
  });

  it('redact stack, error object va provider payload cho exception/rejection format', () => {
    const rawSecret = 'provider-api-secret';
    const rawIp = '203.0.113.8';
    const rawGps = '10.7769,106.7009';
    const rawStack = `Error: apiKey=${rawSecret} ipAddress=${rawIp} gpsCoordinates=${rawGps}`;
    const safeErrorFormat = createSafeErrorJsonFormat();

    const exceptionRecord = safeErrorFormat.transform({
      level: 'error',
      message: rawStack,
      stack: rawStack,
      errorStack: rawStack,
      error: new Error(`request failed apiKey=${rawSecret}`),
      providerPayload: { apiKey: rawSecret, ipAddress: rawIp },
      exception: true
    });
    const rejectionRecord = safeErrorFormat.transform({
      level: 'error',
      message: rawStack,
      stack: rawStack,
      reason: { apiKey: rawSecret, gpsCoordinates: rawGps },
      rejection: true
    });
    const freeTextReasonRecord = safeErrorFormat.transform({
      level: 'error',
      message: 'unhandled rejection',
      reason: 'Hóa đơn HN-2026-0813 của Nguyễn Văn A tại 12 Điện Biên Phủ',
      rejection: true
    });

    const output = [exceptionRecord, rejectionRecord, freeTextReasonRecord]
      .map(record => {
        if (!record || typeof record !== 'object') return '';
        const message = (record as { [key: symbol]: unknown })[Symbol.for('message')];
        return String(message ?? '');
      })
      .join('\n');
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain(rawIp);
    expect(output).not.toContain(rawGps);
    expect(output).not.toContain('HN-2026-0813');
    expect(output).not.toContain('Nguyễn Văn A');
    expect(output).toContain('[IP_REDACTED]');
    expect(output).toContain('[GPS_REDACTED]');
    expect(output).toContain('[REASON_REDACTED]');
  });

  it('không ghi raw error-like metadata vào facade logger', () => {
    const entries = captureLogOutput();
    const rawSecret = 'raw-provider-secret';

    getLogger().error('Provider failed.', {
      error: `Error: {"apiKey":"${rawSecret}"}`,
      originalError: `privateKey=${rawSecret}`,
      paymasterErrorMessage: `secretKey=${rawSecret}`
    });

    const output = JSON.stringify(entries.at(-1));
    expect(output).not.toContain(rawSecret);
    expect(output).toContain('[REDACTED]');
  });

  it('không ghi raw reason từ request body vào structured log', () => {
    const entries = captureLogOutput();
    const rawSecret = 'raw-request-reason-secret';

    getLogger().info('Sybil status changed.', {
      reason: `apiKey=${rawSecret} email=user@example.com ip=203.0.113.8`
    });

    const output = JSON.stringify(entries.at(-1));
    expect(output).not.toContain(rawSecret);
    expect(output).not.toContain('user@example.com');
    expect(output).not.toContain('203.0.113.8');
    expect(output).toContain('[REASON_REDACTED]');
  });

  it('sanitize sensitive values nằm trực tiếp trong message legacy', () => {
    const entries = captureLogOutput();
    const rawWallet = '0xabcdef1234567890abcdef1234567890abcdef12';
    const rawTransactionHash = `0x${'a'.repeat(64)}`;
    const rawToken = 'raw-message-token';

    getLogger().error(
      `Provider failed wallet=${rawWallet} txHash=${rawTransactionHash} apiKey=${rawToken} ip=203.0.113.8 reason: raw free text`,
    );

    const entry = entries.at(-1)!;
    const message = String(entry.message);
    expect(message).not.toContain(rawWallet);
    expect(message).not.toContain(rawTransactionHash);
    expect(message).not.toContain(rawToken);
    expect(message).not.toContain('203.0.113.8');
    expect(message).not.toContain('raw free text');
  });

  it('loại bỏ payload thô khi error record vượt cap top-level', () => {
    const safeErrorFormat = createSafeErrorJsonFormat();
    const oversizedRecord = {
      level: 'error',
      message: 'apiKey=oversized-secret',
      stack: 'Error: apiKey=oversized-secret',
      exception: { apiKey: 'oversized-exception-secret', stack: 'Error: apiKey=oversized-exception-secret' },
      rejection: { gpsCoordinates: '10.7769,106.7009' },
      ...Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`field_${index}`, index]))
    };
    const formattedRecord = safeErrorFormat.transform(oversizedRecord);
    const output = formattedRecord && typeof formattedRecord === 'object'
      ? String((formattedRecord as { [key: symbol]: unknown })[Symbol.for('message')] ?? '')
      : '';

    expect(output).not.toContain('field_256');
    expect(output).not.toContain('oversized-secret');
    expect(output).not.toContain('oversized-exception-secret');
    expect(output).not.toContain('10.7769,106.7009');
    expect(output).toContain('[METADATA_REDACTED]');
  });

  it('giữ cấu hình rotate theo ngày, nén file và retention', () => {
    const transports = [
      combinedFileTransportOptions,
      errorFileTransportOptions,
      exceptionFileTransportOptions,
      rejectionFileTransportOptions
    ];

    for (const transportOptions of transports) {
      expect(transportOptions).toMatchObject({
        dirname: 'logs',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        utc: true
      });
      expect(transportOptions.auditFile).toMatch(/^logs[\\/]\.dcp-[a-z-]+-audit\.json$/);
    }
    expect(combinedFileTransportOptions.maxFiles).toBe('14d');
    expect(errorFileTransportOptions.maxFiles).toBe('30d');
    expect(exceptionFileTransportOptions.maxFiles).toBe('30d');
    expect(rejectionFileTransportOptions.maxFiles).toBe('30d');
  });
});
