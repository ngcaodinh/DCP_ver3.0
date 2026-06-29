/**
 * Unit tests cho E2 Multi-channel Delivery — Email Retry.
 * Dung fake timers de tranh real 60s sleep delays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock refs
const mocks = vi.hoisted(() => ({
  mockSendMail: vi.fn()
}));

vi.mock('../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mocks.mockSendMail, close: vi.fn() })) }
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '<p>{{content}}</p><a href="{{unsubscribeUrl}}">Unsub</a>')
  },
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => '<p>{{content}}</p><a href="{{unsubscribeUrl}}">Unsub</a>')
}));

vi.mock('path', () => ({
  default: { resolve: vi.fn(() => '/t.hbs') },
  resolve: vi.fn(() => '/t.hbs')
}));

vi.mock('handlebars', () => ({
  default: {
    compile: vi.fn((t) => (ctx: Record<string, unknown>) => {
      let r = t;
      for (const [k, v] of Object.entries(ctx)) r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), String(v ?? ''));
      return r;
    })
  }
}));

function setupSmtpEnv(): void {
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'test@gmail.com';
  process.env.SMTP_PASS = 'pass';
  process.env.SMTP_FROM = 'DCP <dcp@test.com>';
}

describe('E2 Email Retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockSendMail.mockReset();
    setupSmtpEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retry 3 lan khi SMTP fail (fake timers)', async () => {
    // Su dung fake timers de tranh real 60s sleep
    vi.useFakeTimers();

    mocks.mockSendMail.mockRejectedValue(new Error('SMTP temp error'));

    const { sendEmailWithRetry } = await import('../email.service');

    const promise = sendEmailWithRetry({ to: 'u@e.com', subject: 'T', html: '<p>T</p>' });

    // Advance through 3 attempts (2 intervals of 60s each = 120s total)
    await vi.advanceTimersByTimeAsync(120_000);

    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.channel).toBe('EMAIL');
    expect(mocks.mockSendMail).toHaveBeenCalledTimes(3);
  });

  it('success ngay khi lan dau thanh cong', async () => {
    mocks.mockSendMail.mockResolvedValue({ messageId: 'msg-1' });
    const { sendEmailWithRetry } = await import('../email.service');
    const result = await sendEmailWithRetry({ to: 'u@e.com', subject: 'T', html: '<p>T</p>' });
    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe('msg-1');
    expect(mocks.mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('khong retry khi authentication failed', async () => {
    mocks.mockSendMail.mockRejectedValue(new Error('Authentication failed'));
    const { sendEmailWithRetry } = await import('../email.service');
    const result = await sendEmailWithRetry({ to: 'u@e.com', subject: 'T', html: '<p>T</p>' });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(mocks.mockSendMail).toHaveBeenCalledTimes(1);
  });
});
