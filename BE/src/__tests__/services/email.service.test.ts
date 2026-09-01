import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import { resetTransporter, sendEmail, setTransporter } from '../../services/email.service';

const sendMailMock = vi.fn();

/** Tạo context giả lập cố định để kiểm tra format chứng nhận và dữ liệu email transactional. */
function createTemplateContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    certificateId: 'DCP-TEST-2026-0001',
    statusLabel: 'Đã ghi nhận thành công',
    donorName: 'Nguyễn Minh An',
    projectName: 'Quỹ học bổng cộng đồng',
    organizationName: 'DCP Foundation',
    amountVndFormatted: '250.000',
    currencyCode: 'VNĐ',
    paymentMethodLabel: 'Chuyển khoản ngân hàng',
    networkName: 'Polygon Amoy',
    chainId: '80002',
    transactionHash: '0x1234567890abcdef',
    blockNumber: '7123456',
    blockHash: '0xabcdef',
    finalityModeLabel: 'Finalized bởi Polygon PoS',
    donatedAtVietnam: '01/09/2026 10:00:00',
    ...overrides
  };
}

describe('email.service transactional certificate delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SMTP_HOST', 'smtp.gmail.com');
    vi.stubEnv('SMTP_PORT', '465');
    vi.stubEnv('SMTP_USER', 'sender@example.com');
    vi.stubEnv('SMTP_PASS', 'test-app-password');
    vi.stubEnv('SMTP_FROM', 'DCP <sender@example.com>');
    setTransporter({ sendMail: sendMailMock } as unknown as Transporter);
  });

  afterEach(() => {
    resetTransporter();
    vi.unstubAllEnvs();
  });

  it('truyền đúng PDF attachment và render đủ nội dung chứng nhận trước khi gửi SMTP', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'gmail-message-1' });
    const pdf = Buffer.from('%PDF-demo');

    const result = await sendEmail({
      to: 'donor@example.com',
      templateName: 'donation-certificate-issued',
      subject: 'DCP – Giấy xác nhận đóng góp DCP-TEST-2026-0001',
      templateContext: createTemplateContext(),
      includeUnsubscribeLink: false,
      attachments: [{ filename: 'DCP-Certificate-DCP-TEST-2026-0001.pdf', content: pdf, contentType: 'application/pdf' }]
    });

    expect(result).toMatchObject({ success: true, providerMessageId: 'gmail-message-1' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const message = sendMailMock.mock.calls[0][0] as { html: string; attachments: Array<{ filename: string; content: Buffer; contentType: string }> };
    expect(message.html).toContain('GIẤY XÁC NHẬN ĐÓNG GÓP');
    expect(message.html).toContain('250.000');
    expect(message.html).toContain('Chuyển khoản ngân hàng');
    expect(message.html).not.toContain('{{');
    expect(message.attachments).toEqual([{ filename: 'DCP-Certificate-DCP-TEST-2026-0001.pdf', content: pdf, contentType: 'application/pdf' }]);
  });

  it('escape dữ liệu donor đúng một lần qua cơ chế mặc định của Handlebars', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'gmail-message-2' });

    const result = await sendEmail({
      to: 'donor@example.com',
      templateName: 'donation-certificate-issued',
      subject: 'DCP – Certificate',
      templateContext: createTemplateContext({ donorName: '<img src=x onerror=alert(1)>' }),
      includeUnsubscribeLink: false
    });

    expect(result.success).toBe(true);
    const message = sendMailMock.mock.calls[0][0] as { html: string };
    expect(message.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(message.html).toContain('&lt;img');
  });

  it('hiển thị đúng ký tự ampersand trong tên tổ chức mà không double-escape', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'gmail-message-3' });

    await sendEmail({
      to: 'donor@example.com',
      templateName: 'donation-certificate-issued',
      subject: 'DCP – Certificate',
      templateContext: createTemplateContext({ organizationName: 'Quỹ Bảo trợ & Người khuyết tật' }),
      includeUnsubscribeLink: false
    });

    const message = sendMailMock.mock.calls[0][0] as { html: string };
    expect(message.html).toContain('Quỹ Bảo trợ &amp; Người khuyết tật');
    expect(message.html).not.toContain('&amp;amp;');
  });
});
