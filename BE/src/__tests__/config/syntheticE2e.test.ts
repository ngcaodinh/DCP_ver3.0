import { afterEach, describe, expect, it } from 'vitest';
import { isSyntheticE2eExecutionEnabled, isSyntheticE2eTokenValid } from '../../config/syntheticE2e';

const ORIGINAL_ENVIRONMENT = process.env.NODE_ENV;
const ORIGINAL_EXECUTION = process.env.SYNTHETIC_E2E_EXECUTION;
const ORIGINAL_ACK = process.env.SYNTHETIC_E2E_ACK;
const ORIGINAL_TOKEN = process.env.SYNTHETIC_E2E_TOKEN;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENVIRONMENT;
  process.env.SYNTHETIC_E2E_EXECUTION = ORIGINAL_EXECUTION;
  process.env.SYNTHETIC_E2E_ACK = ORIGINAL_ACK;
  process.env.SYNTHETIC_E2E_TOKEN = ORIGINAL_TOKEN;
});

describe('synthetic E2E configuration', () => {
  it('chỉ bật khi đúng môi trường và mã xác nhận', () => {
    process.env.NODE_ENV = 'performance';
    process.env.SYNTHETIC_E2E_EXECUTION = 'true';
    process.env.SYNTHETIC_E2E_ACK = 'I_UNDERSTAND_SYNTHETIC_E2E';
    expect(isSyntheticE2eExecutionEnabled()).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(isSyntheticE2eExecutionEnabled()).toBe(false);
  });

  it('so sánh token synthetic theo cách constant-time và từ chối token sai', () => {
    process.env.SYNTHETIC_E2E_TOKEN = 'test-only-token';
    expect(isSyntheticE2eTokenValid('test-only-token')).toBe(true);
    expect(isSyntheticE2eTokenValid('wrong-token')).toBe(false);
    expect(isSyntheticE2eTokenValid(undefined)).toBe(false);
  });
});
