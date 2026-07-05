/**
 * Unit tests cho E2 Multi-channel Delivery.
 * Mock external dependencies (nodemailer, twilio, firebase-admin, fs, path) only.
 * Real service implementations run — fake timers chi can cho email retry delay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliverySuccess, DeliveryFailure } from '../types/delivery.types';

// Hoisted mock refs — chia se giua vi.mock factories va tests
const mocks = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockTwilioCreate: vi.fn(),
  mockFcmSend: vi.fn()
}));

// External deps mock — bao gom default export de tranh loi "No default export"
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
  default: { getMessaging: vi.fn(() => ({ send: mocks.mockFcmSend })) }
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

/**
 * Reset all singleton clients.
 */
async function resetAllSingletons(): Promise<void> {
  const { resetTransporter } = await import('../email.service');
  const { resetTwilioClient } = await import('../sms.service');
  const { resetFirebaseApp } = await import('../push.service');
  resetTransporter();
  resetTwilioClient();
  resetFirebaseApp();
}

/**
 * Setup env vars cho SMTP.
 */
function setupSmtpEnv(): void {
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'test@gmail.com';
  process.env.SMTP_PASS = 'pass';
  process.env.SMTP_FROM = 'DCP <dcp@test.com>';
}

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

/* Email Retry tests moved to e2-email-retry.test.ts (requires fake timers, isolated to avoid state leak) */

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
    expect((result as DeliverySuccess).providerMessageId).toBe('SM1');
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
    expect((result as DeliveryFailure).retryable).toBe(true);
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
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.mockSendMail.mockReset();
    mocks.mockTwilioCreate.mockReset();
    mocks.mockFcmSend.mockReset();
    delete process.env.LARGE_DONATION_EMAIL_THRESHOLD_VND;

    // Reset singletons truoC import — tranh state leak tu test groups truoc do
    await resetAllSingletons();
  });

  it('dispatch EMAIL DELIVERED khi user co email', async () => {
    setupSmtpEnv();
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

  it('dispatch IN_APP DELIVERED (khong goi external services)', async () => {
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
    // Email chi goi 1 lan (Bull xu ly retry) — khong can fake timers
    setupSmtpEnv();
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
    const emailResult = result.channelResults.find(r => r.channel === 'EMAIL');
    expect(emailResult?.result.success).toBe(false);
    const inAppResult = result.channelResults.find(r => r.channel === 'IN_APP');
    expect(inAppResult?.result.success).toBe(true);
  });

  it('PUSH fallback EMAIL khi FCM fail', async () => {
    process.env.FCM_PROJECT_ID = 'test-project';
    process.env.FCM_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n';
    process.env.FCM_CLIENT_EMAIL = 'test@iam.gserviceaccount.com';
    setupSmtpEnv();
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
    process.env.TWILIO_ACCOUNT_SID = 'ACxxx';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+1234567890';
    setupSmtpEnv();
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
    // Email chi goi 1 lan — khong can fake timers
    setupSmtpEnv();
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
    expect(result.channelResults).toHaveLength(1);
    expect(result.channelResults[0].result.success).toBe(false);
  });
});

describe('E2 Types', () => {
  it('DeliveryResult discriminated union', async () => {
    // Dynamic import trả về const sentinel DeliveryResult; dùng typeof DeliveryResult.types làm type annotation
    const { DeliveryResult } = await import('../types/delivery.types');
    const s: typeof DeliveryResult.types = { success: true, channel: 'EMAIL', providerMessageId: 'm1', latencyMs: 150 };
    expect(s.success).toBe(true);
    const f: typeof DeliveryResult.types = { success: false, channel: 'SMS', errorMessage: 'err', retryable: true };
    expect(f.success).toBe(false);
    // Narrow để truy cập retryable — chỉ tồn tại trên DeliveryFailure
    if (!f.success) {
      expect(f.retryable).toBe(true);
    }
    expect(DeliveryResult.isSuccess(s)).toBe(true);
    expect(DeliveryResult.isFailure(f)).toBe(true);
  });

  it('DispatchContext type', async () => {
    const { DispatchContext } = await import('../types/delivery.types');
    const ctx: typeof DispatchContext.contextType = {
      userId: 'u1', userEmail: 'u@e.com', fcmDeviceToken: 'tok',
      phoneNumber: '+84912345678', unsubscribeToken: 'tok', donationAmountVnd: 50_000_000
    };
    expect(ctx.userId).toBe('u1');
    expect(ctx.donationAmountVnd).toBe(50_000_000);
    expect(DispatchContext.hasEmail(ctx)).toBe(true);
    expect(DispatchContext.hasPush(ctx)).toBe(true);
    expect(DispatchContext.hasSms(ctx)).toBe(true);
  });
});
