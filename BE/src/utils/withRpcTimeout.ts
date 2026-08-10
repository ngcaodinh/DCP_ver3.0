import { getLogger } from '../config/logger';

const logger = getLogger();
export const SBT_RPC_READ_TIMEOUT_MS = 5_000;
let orphanedRpcPromiseCount = 0;

/** Bao timeout cho RPC read để request hoặc projector không bị giữ vô hạn khi provider không phản hồi. */
export function withRpcTimeout<T>(
  promise: Promise<T>,
  timeoutMs = SBT_RPC_READ_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      const timeoutError = Object.assign(new Error('RPC read timeout.'), { code: 'TIMEOUT' });
      logger.warn('RPC read SBT đã timeout; promise provider tiếp tục chạy nền.', {
        timeoutMs,
        orphanedPromiseCount: orphanedRpcPromiseCount += 1
      });
      reject(timeoutError);
    }, timeoutMs);

    promise.then(
      value => {
        clearTimeout(timeout);
        if (timedOut) return;
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        if (timedOut) return;
        reject(error);
      }
    );
  });
}
