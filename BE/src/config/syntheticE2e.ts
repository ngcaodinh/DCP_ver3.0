import crypto from 'crypto';

const SYNTHETIC_E2E_ACK = 'I_UNDERSTAND_SYNTHETIC_E2E';
const PERFORMANCE_ENVIRONMENTS = new Set(['test', 'performance']);

/** Kiểm tra synthetic E2E chỉ được phép chạy trong môi trường test/performance có xác nhận rõ ràng. */
export function isSyntheticE2eExecutionEnabled(): boolean {
  const requested = process.env.SYNTHETIC_E2E_EXECUTION?.trim().toLowerCase() === 'true';
  const environment = process.env.NODE_ENV?.trim().toLowerCase() || 'development';
  const acknowledged = process.env.SYNTHETIC_E2E_ACK?.trim() === SYNTHETIC_E2E_ACK;
  return requested && PERFORMANCE_ENVIRONMENTS.has(environment) && acknowledged;
}

/** Xác thực token header cho endpoint synthetic, không để endpoint test bị gọi nhầm trong mạng nội bộ. */
export function isSyntheticE2eTokenValid(candidateToken: string | undefined): boolean {
  const configuredToken = process.env.SYNTHETIC_E2E_TOKEN?.trim();
  if (!configuredToken || !candidateToken) return false;
  const candidateBuffer = Buffer.from(candidateToken);
  const configuredBuffer = Buffer.from(configuredToken);
  return candidateBuffer.length === configuredBuffer.length
    && crypto.timingSafeEqual(candidateBuffer, configuredBuffer);
}

export { SYNTHETIC_E2E_ACK };
