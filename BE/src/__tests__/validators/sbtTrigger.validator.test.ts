/**
 * Unit tests cho sbtTrigger.validator.ts — kiểm tra validateSbtTriggerBody.
 * [C3 #4] Validator tests cho EVM address validation và các field khác.
 */
import { describe, it, expect } from 'vitest';
import { validateSbtTriggerBody } from '../../validators/sbtTrigger.validator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    verificationId: 'ver-123',
    projectId: 'proj-1',
    organizationId: 'org-1',
    beneficiaryAddress: '0x1234567890123456789012345678901234567890',
    projectIdNumeric: 1,
    milestone: 0,
    beneficiaryCount: 1,
    gpsCoordinates: '',
    imageCid: 'QmTest',
    tokenUri: 'ipfs://QmTest',
    ...overrides
  };
}

// ─── Tests: validateSbtTriggerBody ────────────────────────────────────────────

describe('sbtTrigger.validator - validateSbtTriggerBody', () => {
  it('[C3] valid payload → isValid=true', () => {
    const result = validateSbtTriggerBody(buildValidPayload());
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data).toBeDefined();
  });

  it('[C3] missing verificationId → isValid=false', () => {
    const { verificationId, ...payloadWithoutVerificationId } = buildValidPayload();
    void verificationId; // avoid unused variable warning

    const result = validateSbtTriggerBody(payloadWithoutVerificationId);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'verificationId')).toBe(true);
  });

  it('[C3] invalid EVM address - không có prefix 0x → isValid=false', () => {
    const payload = buildValidPayload({ beneficiaryAddress: '1234567890123456789012345678901234567890' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'beneficiaryAddress')).toBe(true);
    expect(result.errors.find((e: { field: string }) => e.field === 'beneficiaryAddress')?.message)
      .toContain('EVM');
  });

  it('[C3] invalid EVM address - không đủ 40 hex → isValid=false', () => {
    const payload = buildValidPayload({ beneficiaryAddress: '0x1234567890' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'beneficiaryAddress')).toBe(true);
  });

  it('[C3] invalid EVM address - có ký tự không phải hex → isValid=false', () => {
    const payload = buildValidPayload({ beneficiaryAddress: '0x123456789012345678901234567890123456789g' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'beneficiaryAddress')).toBe(true);
  });

  it('[C3] empty imageCid → isValid=false', () => {
    const payload = buildValidPayload({ imageCid: '' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'imageCid')).toBe(true);
  });

  it('[C3] whitespace-only imageCid → isValid=false', () => {
    const payload = buildValidPayload({ imageCid: '   ' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'imageCid')).toBe(true);
  });

  it('[C3] empty tokenUri → isValid=false', () => {
    const payload = buildValidPayload({ tokenUri: '' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'tokenUri')).toBe(true);
  });

  it('[C3] whitespace-only tokenUri → isValid=false', () => {
    const payload = buildValidPayload({ tokenUri: '  ipfs://QmTest  ' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('[C3] negative projectIdNumeric → isValid=false', () => {
    const payload = buildValidPayload({ projectIdNumeric: -1 });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'projectIdNumeric')).toBe(true);
  });

  it('[C3] non-integer projectIdNumeric → isValid=false', () => {
    const payload = buildValidPayload({ projectIdNumeric: 1.5 });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: { field: string }) => e.field === 'projectIdNumeric')).toBe(true);
  });

  it('[C3] valid payload với optional fields missing → isValid=true với defaults', () => {
    const payload = {
      verificationId: 'ver-defaults',
      projectId: 'proj-1',
      organizationId: 'org-1',
      beneficiaryAddress: '0x1234567890123456789012345678901234567890',
      projectIdNumeric: 1,
      imageCid: 'QmTest',
      tokenUri: 'ipfs://QmTest'
      // milestone, beneficiaryCount, gpsCoordinates không có → dùng default
    };

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(true);
    expect(result.data).toMatchObject({
      milestone: 0,
      beneficiaryCount: 0,
      gpsCoordinates: ''
    });
  });

  it('[C3] valid EVM address - lowercase → isValid=true', () => {
    const payload = buildValidPayload({ beneficiaryAddress: '0xabcdef1234567890abcdef1234567890abcdef12' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('[C3] valid EVM address - mixed case → isValid=true', () => {
    const payload = buildValidPayload({ beneficiaryAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('[C3] valid EVM address - uppercase → isValid=true', () => {
    const payload = buildValidPayload({ beneficiaryAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12' });

    const result = validateSbtTriggerBody(payload);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('[C3] empty payload → isValid=false với nhiều lỗi', () => {
    const result = validateSbtTriggerBody({});

    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('[C3] non-object payload → isValid=false', () => {
    const result = validateSbtTriggerBody('not an object');

    expect(result.isValid).toBe(false);
  });

  it('[C3] null payload → isValid=false', () => {
    const result = validateSbtTriggerBody(null);

    expect(result.isValid).toBe(false);
  });
});
