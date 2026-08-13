import { describe, expect, it } from 'vitest';
import { redactSensitiveData } from '../../utils/redactSensitiveData';

describe('redactSensitiveData — Nhóm A', () => {
  it('che token dài và giữ tám ký tự đầu', () => {
    expect(redactSensitiveData({ token: 'abcdefghijklmnop' })?.token)
      .toBe('abcdefgh...[REDACTED]');
  });

  it('che hoàn toàn token ngắn', () => {
    expect(redactSensitiveData({ token: 'short' })?.token).toBe('[TOKEN_REDACTED]');
  });

  it('thay body bằng độ dài và không redact lần hai', () => {
    const once = redactSensitiveData({ body: 'x'.repeat(50) })!;
    const twice = redactSensitiveData(once)!;

    expect(once.body).toBe('[BODY_LENGTH:50][REDACTED]');
    expect(twice.body).toBe(once.body);
  });

  it.each([
    ['deviceFingerprintHash', 'abc', '[FINGERPRINT_REDACTED]'],
    ['ipAddress', '1.2.3.4', '[IP_REDACTED]'],
    ['clientIp', '10.0.0.1', '[IP_REDACTED]'],
    ['sessionId', 'sess_1', '[SESSION_REDACTED]'],
    ['userAgent', 'Mozilla/5.0 (test)', '[USER_AGENT_REDACTED]']
  ])('che field PII %s', (fieldName, value, expected) => {
    expect(redactSensitiveData({ [fieldName]: value })?.[fieldName]).toBe(expected);
  });

  it('sanitize errorMessage để không lọt URL/token/address từ provider', () => {
    const result = redactSensitiveData({
      errorMessage: 'request failed https://user:password@example.com?apiKey=secret 0xabcdef1234567890abcdef1234567890abcdef12'
    })!;

    expect(result.errorMessage).toContain('[REDACTED_URL]');
    expect(result.errorMessage).not.toContain('password');
    expect(result.errorMessage).not.toContain('secret');
    expect(result.errorMessage).not.toContain('0xabcdef1234567890abcdef1234567890abcdef12');
  });

  it('sanitize error-like fields và JSON provider có prefix', () => {
    const result = redactSensitiveData({
      errorMessage: 'Error: {"apiKey":"raw-api-secret","privateKey":"raw-private-secret"}',
      originalError: 'Error: {"secretKey":"raw-secret-key"}',
      paymasterErrorMessage: 'privateKey=raw-paymaster-secret',
      error: 'Bearer raw-token'
    })!;

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('raw-api-secret');
    expect(serialized).not.toContain('raw-private-secret');
    expect(serialized).not.toContain('raw-secret-key');
    expect(serialized).not.toContain('raw-paymaster-secret');
    expect(serialized).not.toContain('raw-token');
  });

  it('không để lọt secret trong JSON lỗi có escaped quote', () => {
    const escapedProviderError = String.raw`Error: {"apiKey":"prefix\"raw-escaped-secret-value"}`;
    const result = redactSensitiveData({ errorMessage: escapedProviderError })!;

    expect(JSON.stringify(result)).not.toContain('raw-escaped-secret-value');
  });

  it('sanitize reason từ request body ở cả top-level và metadata lồng nhau', () => {
    const rawReason = 'Từ chối: hóa đơn HN-2026-0813 của Nguyễn Văn A tại 12 Điện Biên Phủ';
    const result = redactSensitiveData({
      reason: rawReason,
      context: { reason: rawReason }
    })!;

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(rawReason);
    expect(result.reason).toBe('[REASON_REDACTED]');
    expect(result.context).toEqual({ reason: '[REASON_REDACTED]' });
  });

  it('giữ nguyên reason rỗng hoặc không truyền để không tạo marker giả', () => {
    expect(redactSensitiveData({ reason: '' })?.reason).toBe('');
    expect(redactSensitiveData({ reason: undefined })?.reason).toBeUndefined();
  });

  it('sanitize errorStack và giới hạn stack trace', () => {
    const rawStack = [
      'Error: request failed https://user:password@example.com?apiKey=secret',
      '    at handler (0xabcdef1234567890abcdef1234567890abcdef12)',
      ...Array.from({ length: 90 }, () => '    at nested handler')
    ].join('\n');

    const result = redactSensitiveData({ errorStack: rawStack })!;

    expect(result.errorStack).not.toContain('password');
    expect(result.errorStack).not.toContain('secret');
    expect(result.errorStack).not.toContain('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(result.errorStack).toContain('[STACK_TRUNCATED]');
  });

  it('sanitize secret key phổ biến trong payload lỗi lồng nhau', () => {
    const result = redactSensitiveData({
      providerPayload: {
        apiKey: 'provider-api-secret',
        authorization: 'Bearer raw-token',
        ip: '203.0.113.8',
        latitude: 10.7769,
        longitude: 106.7009
      }
    })!;

    expect(result.providerPayload).toEqual({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      ip: '[IP_REDACTED]',
      latitude: '[GPS_REDACTED]',
      longitude: '[GPS_REDACTED]'
    });
  });
});

describe('redactSensitiveData — Nhóm B và C', () => {
  const fullAddress = '0xabcdef1234567890abcdef1234567890abcdwxyz';

  it.each([
    'walletAddress',
    'smartAccountAddress',
    'guestWalletAddress',
    'claimEOAAddress',
    'donorAddress',
    'beneficiaryAddress',
    'toAddress',
    'fallbackWalletAddress',
    'sender',
    'operator'
  ])('rút gọn địa chỉ public %s thành first6 + last4', (fieldName) => {
    expect(redactSensitiveData({ [fieldName]: fullAddress })?.[fieldName]).toBe('0xabcd...wxyz');
  });

  it('giữ nguyên địa chỉ ngắn hơn mười ký tự theo QĐ-1', () => {
    expect(redactSensitiveData({ walletAddress: '0xabc' })?.walletAddress).toBe('0xabc');
  });

  it.each(['amount', 'amountVnd', 'donationAmount', 'totalAmount', 'transferAmount'])(
    'che giá trị tiền ở field %s, kể cả số 0',
    (fieldName) => {
      expect(redactSensitiveData({ [fieldName]: 0 })?.[fieldName]).toBe('***VND');
    }
  );

  it('che sourceIp và gpsCoordinates', () => {
    expect(redactSensitiveData({ sourceIp: '8.8.8.8' })?.sourceIp).toBe('[IP_REDACTED]');
    expect(redactSensitiveData({ gpsCoordinates: '10.77,106.69' })?.gpsCoordinates)
      .toBe('[GPS_REDACTED]');
  });

  it('che field name dạng snake_case giống policy canonical', () => {
    const result = redactSensitiveData({
      wallet_address: '0xabcdef1234567890abcdef1234567890abcdwxyz',
      user_agent: 'Mozilla/5.0 (raw)',
      amount_vnd: 500000
    })!;

    expect(result.wallet_address).toBe('0xabcd...wxyz');
    expect(result.user_agent).toBe('[USER_AGENT_REDACTED]');
    expect(result.amount_vnd).toBe('***VND');
  });

  it('redact dữ liệu nhạy cảm trong context lồng nhau và không mutate input', () => {
    const input = {
      context: {
        clientIp: '10.0.0.7',
        sessionId: 'session-nested',
        walletAddress: '0xabcdef1234567890abcdef1234567890abcdwxyz',
        amount: 250000,
        gpsCoordinates: '10.77,106.69'
      }
    };

    const result = redactSensitiveData(input)!;

    expect(result.context).toEqual({
      clientIp: '[IP_REDACTED]',
      sessionId: '[SESSION_REDACTED]',
      walletAddress: '0xabcd...wxyz',
      amount: '***VND',
      gpsCoordinates: '[GPS_REDACTED]'
    });
    expect(input.context.sessionId).toBe('session-nested');
  });

  it('không giữ nguyên SDK/class object có thể chứa secret', () => {
    class ProviderPayload {
      public apiKey = 'class-api-secret';
    }

    const result = redactSensitiveData({ providerPayload: new ProviderPayload() })!;

    expect(result.providerPayload).toBe('[NON_PLAIN_METADATA_REDACTED]');
    expect(JSON.stringify(result)).not.toContain('class-api-secret');
  });

  it('redact được object không có prototype', () => {
    const context = Object.create(null) as Record<string, unknown>;
    context.sessionId = 'session-null-prototype';

    expect(redactSensitiveData({ context })?.context).toEqual({
      sessionId: '[SESSION_REDACTED]'
    });
  });

  it('không throw và thay circular reference bằng marker an toàn', () => {
    const context: Record<string, unknown> = { sessionId: 'session-circular' };
    context.self = context;

    expect(redactSensitiveData({ context })).toEqual({
      context: {
        sessionId: '[SESSION_REDACTED]',
        self: '[CIRCULAR_REDACTED]'
      }
    });
  });

  it('giới hạn metadata quá sâu để tránh chi phí đệ quy không bounded', () => {
    let nested: Record<string, unknown> = { sessionId: 'session-too-deep' };
    for (let index = 0; index < 10; index += 1) {
      nested = { context: nested };
    }

    const result = redactSensitiveData(nested)!;

    expect(result.context).toBeDefined();
    expect(JSON.stringify(result)).toContain('[NESTED_METADATA_REDACTED]');
  });

  it('giới hạn object lồng quá lớn để tránh log làm nghẽn event loop', () => {
    const context = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`field_${index}`, index])
    );

    expect(redactSensitiveData({ context })?.context).toBe('[NESTED_METADATA_REDACTED]');
  });

  it('giới hạn metadata top-level quá lớn trước khi shallow clone', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`field_${index}`, index])
    );

    expect(redactSensitiveData(metadata)).toEqual({ _redaction: '[METADATA_REDACTED]' });
  });

  it('không tạo chuỗi rác khi address đã pre-redact ở call site', () => {
    const preRedacted = '0xabcd...[REDACTED]';
    expect(redactSensitiveData({ walletAddress: preRedacted })?.walletAddress).toBe(preRedacted);
  });
});

describe('redactSensitiveData — hợp đồng chung', () => {
  it('trả undefined khi metadata undefined', () => {
    expect(redactSensitiveData(undefined)).toBeUndefined();
  });

  it('không mutate object đầu vào', () => {
    const input = { token: 'abcdefghijklmnop' };
    redactSensitiveData(input);
    expect(input.token).toBe('abcdefghijklmnop');
  });

  it('giữ chuỗi rỗng và giá trị non-string theo contract cũ', () => {
    const result = redactSensitiveData({ token: '', ipAddress: 12345 })!;
    expect(result.token).toBe('');
    expect(result.ipAddress).toBe(12345);
  });
});
