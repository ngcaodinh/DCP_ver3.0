import { describe, expect, it } from 'vitest';
import { validateSbtTriggerBody } from '../../validators/sbtTrigger.validator';

describe('sbtTrigger.validator - validateSbtTriggerBody', () => {
  it('accepts only verificationId and strips client-controlled mint fields', () => {
    const result = validateSbtTriggerBody({
      verificationId: 'ver-123',
      projectId: 'client-forged-project',
      beneficiaryAddress: '0x0000000000000000000000000000000000000000',
      milestone: 999
    });

    expect(result.isValid).toBe(true);
    expect(result.data).toEqual({ verificationId: 'ver-123' });
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing, empty and non-string verificationId', () => {
    for (const payload of [{}, { verificationId: '' }, { verificationId: 123 }]) {
      const result = validateSbtTriggerBody(payload);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(error => error.field === 'verificationId')).toBe(true);
    }
  });

  it('rejects non-object payloads', () => {
    expect(validateSbtTriggerBody(null).isValid).toBe(false);
    expect(validateSbtTriggerBody('not an object').isValid).toBe(false);
  });
});
