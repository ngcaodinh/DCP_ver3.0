/**
 * Unit tests cho E2 Multi-channel Delivery.
 * Mock external dependencies (nodemailer, twilio, firebase-admin) only.
 * Real service implementations run, avoiding singleton mock state conflicts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock refs
const mocks = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockTwilioCreate: vi.fn(),
  mockFcmSend: vi.fn()
}));

// External deps mock only
vi.mock('../config/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: mocks.mockSendMail, close: vi.fn() })) }
}));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({ messages: { create: mocks.mockTwilioCreate } }))
}));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(() => ({})),
  getApps: vi.fn(() => []),
  cert: vi.fn(() => ({}))
}));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({ send: mocks.mockFcmSend }))
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => '<p>{{content}}</p><a href="{{unsubscribeUrl}}">Unsub</a>')
}));

vi.mock('path', () => ({ resolve: vi.fn(() => '/t.hbs') }));

vi.mock('handlebars', () => ({
  default: {
    compile: vi.fn((t) => (ctx: Record<string, unknown>) => {
      let r = t;
      for (const [k, v] of Object.entries(ctx)) r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), String(v ?? ''));
      return r;
    })
  }
}));

describe('E2 Constants', () => {
  it('EMAIL_MAX_RETRY_ATTEMPTS = 3', async () => {
    const { EMAIL_MAX_RETRY_ATTEMPTS } = await import('../constants/notification.constants');
    expect(EMAIL_MAX_RETRY_ATTEMPTS).toBe(3);
  });

  it('EMAIL_RETRY_INTERVAL_MS = 60000', async () => {
    const { EMAIL_RETRY_INTERVAL_MS } = await import('../constants/notification.constants');
    expect(EMAIL_RETRY_INTERVAL_MS).toBe(60_000);
  });

  it('EMAIL_ALLOWLIST_EVENT_TYPES = 5 events', async () => {
    const { EMAIL_ALLOWLIST_EVENT_TYPES } = await import('../constants/notification.constants');
    expect(EMAIL_ALLOWLIST_EVENT_TYPES).toHaveLength(5);
    expect(EMAIL_ALLOWLIST_EVENT_TYPES).toContain('LARGE_DONATION');
    expect(EMAIL_ALLOWLIST_EVENT_TYPES).toContain('DISBURSEMENT_COMPLETED');
    expect(EMAIL_ALLOWLIST_EVENT_TYPES).toContain('MANUAL_REVIEW_ESCALATION');
    expect(EMAIL_ALLOWLIST_EVENT_TYPES).toContain('OVERRIDE_APPROVED');
    expect(EMAIL_ALLOWLIST_EVENT_TYPES).toContain('SBT_MINT_FAILED');
  });

  it('DEFAULT_LARGE_DONATION_THRESHOLD_VND = 10000000', async () => {
    const { DEFAULT_LARGE_DONATION_THRESHOLD_VND } = await import('../constants/notification.constants');
    expect(DEFAULT_LARGE_DONATION_THRESHOLD_VND).toBe(10_000_000);
  });

  it('PUSH_TIMEOUT_MS = 10000', async () => {
    const { PUSH_TIMEOUT_MS } = await import('../constants/notification.constants');
    expect(PUSH_TIMEOUT_MS).toBe(10_000);
  });

  it('SMS_TIMEOUT_MS = 15000', async () => {
    const { SMS_TIMEOUT_MS } = await import('../constants/notification.constants');
    expect(SMS_TIMEOUT_MS).toBe(15_000);
  });

  it('EMAIL_TIMEOUT_MS = 30000', async () => {
    const { EMAIL_TIMEOUT_MS } = await import('../constants/notification.constants');
    expect(EMAIL_TIMEOUT_MS).toBe(30_000);
  });
});

describe('E2 Email Retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockSendMail.mockReset();
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'test@gmail.com';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_FROM = 'DCP <dcp@test.com>';
  });

  it('retry 3 lan khi SMTP fail', async () => {
    mocks.mockSendMail.mockRejectedValue(new Error('SMTP temp error'));
    const { sendEmailWithRetry } = await import('../email.service');
    const result = await sendEmailWithRetry({ to: 'u@e.com', subject: 'T', html: '<p>T</p>' });
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

describe('E2 SMS Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockTwilioCreate.mockReset();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });

  it('fail khi thieu Twilio credentials', async () => {
    const { sendSms } = await import('../sms.service');
    const result = await sendSms({ to: '+84912345678', body: 'Test' });
    expect(result.success).toBe(false);
    expect(result.channel).toBe('SMS');
  });

  it('success khi twilio thanh cong', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+1234567890';
    mocks.mockTwilioCreate.mockResolvedValue({ sid: 'SM1', status: 'queued' });
    const { sendSms } = await import('../sms.service');
    const result = await sendSms({ to: '+84912345678', body: 'Test' });
    expect(result.success).toBe(true);
    expect(result.channel).toBe('SMS');
    expect(result.providerMessageId).toBe('SM1');
  });

  it('normalize 0xxx thanh +84xxx', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+1234567890';
    mocks.mockTwilioCreate.mockResolvedValue({ sid: 'SM2', status: 'queued' });
    const { sendSms } = await import('../sms.service');
    await sendSms({ to: '0912345678', body: 'T' });
    expect(mocks.mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+84912345678' })
    );
  });

  it('fail khi phone khong hop le', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+1234567890';
    const { sendSms } = await import('../sms.service');
    const result = await sendSms({ to: '1', body: 'T' });
    expect(result.success).toBe(false);
    expect(result.channel).toBe('SMS');
  });

  it('retryable khi Twilio server error', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+1234567890';
    mocks.mockTwilioCreate.mockRejectedValue(new Error('Twilio server error'));
    const { sendSms } = await import('../sms.service');
    const result = await sendSms({ to: '+84912345678', body: 'T' });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

describe('E2 Allowlist & Threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LARGE_DONATION_EMAIL_THRESHOLD_VND;
  });

  it('isEmailAllowed = true for LARGE_DONATION', async () => {
    const { isEmailAllowed } = await import('../notificationDispatcher.service');
    expect(isEmailAllowed('LARGE_DONATION')).toBe(true);
  });

  it('isEmailAllowed = false for DONATION_RECEIVED', async () => {
    const { isEmailAllowed } = await import('../notificationDispatcher.service');
    expect(isEmailAllowed('DONATION_RECEIVED')).toBe(false);
  });

  it('getAllowedChannels filter EMAIL cho non-allowlist type', async () => {
    const { getAllowedChannels } = await import('../notificationDispatcher.service');
    const ch = getAllowedChannels('DONATION_RECEIVED', ['IN_APP', 'EMAIL', 'PUSH']);
    expect(ch).toEqual(['IN_APP']);
  });

  it('getAllowedChannels gia nguyen cho allowlist type', async () => {
    const { getAllowedChannels } = await import('../notificationDispatcher.service');
    const ch = getAllowedChannels('LARGE_DONATION', ['IN_APP', 'EMAIL', 'PUSH']);
    expect(ch).toEqual(['IN_APP', 'EMAIL', 'PUSH']);
  });

  it('threshold true khi >= 10M VND', async () => {
    const { isLargeDonationThresholdMet } = await import('../notificationDispatcher.service');
    expect(isLargeDonationThresholdMet({ donationAmountVnd: 10_000_000 })).toBe(true);
    expect(isLargeDonationThresholdMet({ donationAmountVnd: 50_000_000 })).toBe(true);
  });

  it('threshold false khi < 10M VND', async () => {
    const { isLargeDonationThresholdMet } = await import('../notificationDispatcher.service');
    expect(isLargeDonationThresholdMet({ donationAmountVnd: 5_000_000 })).toBe(false);
  });

  it('threshold true khi khong co amount', async () => {
    const { isLargeDonationThresholdMet } = await import('../notificationDispatcher.service');
    expect(isLargeDonationThresholdMet({})).toBe(true);
    expect(isLargeDonationThresholdMet(undefined)).toBe(true);
  });

  it('env var override threshold', async () => {
    process.env.LARGE_DONATION_EMAIL_THRESHOLD_VND = '5000000';
    const { isLargeDonationThresholdMet } = await import('../notificationDispatcher.service');
    expect(isLargeDonationThresholdMet({ donationAmountVnd: 4_000_000 })).toBe(false);
    expect(isLargeDonationThresholdMet({ donationAmountVnd: 5_000_000 })).toBe(true);
  });
});

describe('E2 Dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockSendMail.mockReset();
    delete process.env.LARGE_DONATION_EMAIL_THRESHOLD_VND;
  });

  it('dispatch EMAIL DELIVERED khi user co email', async () => {
    mocks.mockSendMail.mockResolvedValue({ messageId: 'm1' });

    const { dispatchNotification } = await import('../notificationDispatcher.service');
    const result = await dispatchNotification(
      {
        notificationId: 'N1', notificationType: 'LARGE_DONATION',
        title: 'T', content: 'C', channels: ['EMAIL'],
        metadata: { donationAmountVnd: 50_000_000 }
      },
      { userId: 'u1', userEmail: 'u@e.com', unsubscribeToken: 'tok' }
    );

    expect(result.deliveryState).toBe('DELIVERED');
    expect(result.channelResults).toHaveLength(1);
    expect(result.channelResults[0].result.success).toBe(true);
  });

  it('dispatch IN_APP DELIVERED (khong goi email service)', async () => {
    const { dispatchNotification } = await import('../notificationDispatcher.service');
    const result = await dispatchNotification(
      { notificationId: 'N2', notificationType: 'DONATION_RECEIVED', title: 'T', content: 'C', channels: ['IN_APP'] },
      { userId: 'u1' }
    );

    expect(result.deliveryState).toBe('DELIVERED');
    expect(result.channelResults[0].channel).toBe('IN_APP');
    expect(result.channelResults[0].result.success).toBe(true);
  });

  it('dispatch tra PARTIAL khi EMAIL fail nhung IN_APP success', async () => {
    mocks.mockSendMail.mockRejectedValue(new Error('SMTP err'));

    const { dispatchNotification } = await import('../notificationDispatcher.service');
    const result = await dispatchNotification(
      {
        notificationId: 'N3', notificationType: 'LARGE_DONATION',
        title: 'T', content: 'C', channels: ['IN_APP', 'EMAIL'],
        metadata: { donationAmountVnd: 50_000_000 }
      },
      { userId: 'u1', userEmail: 'u@e.com' }
    );

    expect(result.deliveryState).toBe('PARTIAL');
  });

  it('PUSH fallback EMAIL khi FCM fail', async () => {
    mocks.mockFcmSend.mockRejectedValue(new Error('FCM err'));
    mocks.mockSendMail.mockResolvedValue({ messageId: 'm-fb' });

    const { dispatchNotification } = await import('../notificationDispatcher.service');
    const result = await dispatchNotification(
      {
        notificationId: 'N4', notificationType: 'LARGE_DONATION',
        title: 'T', content: 'C', channels: ['PUSH'],
        metadata: { donationAmountVnd: 50_000_000 }
      },
      { userId: 'u1', userEmail: 'u@e.com', fcmDeviceToken: 'tok', unsubscribeToken: 'tok' }
    );

    expect(result.deliveryState).toBe('DELIVERED');
    const pr = result.channelResults.find(r => r.channel === 'PUSH');
    expect(pr?.result.success).toBe(true);
  });

  it('SMS fallback EMAIL khi Twilio fail', async () => {
    mocks.mockTwilioCreate.mockRejectedValue(new Error('Twilio err'));
    mocks.mockSendMail.mockResolvedValue({ messageId: 'm-sms-fb' });

    const { dispatchNotification } = await import('../notificationDispatcher.service');
    const result = await dispatchNotification(
      {
        notificationId: 'N5', notificationType: 'LARGE_DONATION',
        title: 'T', content: 'C', channels: ['SMS'],
        metadata: { donationAmountVnd: 50_000_000 }
      },
      { userId: 'u1', userEmail: 'u@e.com', phoneNumber: '+84912345678', unsubscribeToken: 'tok' }
    );

    expect(result.deliveryState).toBe('DELIVERED');
    const sr = result.channelResults.find(r => r.channel === 'SMS');
    expect(sr?.result.success).toBe(true);
  });

  it('dispatch tra FAILED khi tat ca channels fail', async () => {
    mocks.mockSendMail.mockRejectedValue(new Error('SMTP err'));

    const { dispatchNotification } = await import('../notificationDispatcher.service');
    const result = await dispatchNotification(
      {
        notificationId: 'N6', notificationType: 'LARGE_DONATION',
        title: 'T', content: 'C', channels: ['EMAIL'],
        metadata: { donationAmountVnd: 50_000_000 }
      },
      { userId: 'u1', userEmail: 'u@e.com' }
    );

    expect(result.deliveryState).toBe('FAILED');
  });
});

describe('E2 Types', () => {
  it('DeliveryResult discriminated union', async () => {
    const { DeliveryResult } = await import('../types/delivery.types');
    const s: DeliveryResult = { success: true, channel: 'EMAIL', providerMessageId: 'm1', latencyMs: 150 };
    expect(s.success).toBe(true);
    const f: DeliveryResult = { success: false, channel: 'SMS', errorMessage: 'err', retryable: true };
    expect(f.success).toBe(false);
    expect(f.retryable).toBe(true);
  });

  it('DispatchContext type', async () => {
    const { DispatchContext } = await import('../types/delivery.types');
    const ctx: DispatchContext = {
      userId: 'u1', userEmail: 'u@e.com', fcmDeviceToken: 'tok',
      phoneNumber: '+84912345678', unsubscribeToken: 'tok', donationAmountVnd: 50_000_000
    };
    expect(ctx.userId).toBe('u1');
    expect(ctx.donationAmountVnd).toBe(50_000_000);
  });
});
