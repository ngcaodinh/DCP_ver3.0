import { sanitizeProviderError } from './sanitizeProviderError';

const MAX_ERROR_STACK_LINES = 80;
const MAX_ERROR_STACK_LENGTH = 12_000;

/** Sanitize và giới hạn stack trace trước khi ghi ra transport exception/rejection. */
export function sanitizeErrorStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;

  const stackLines = stack.split(/\r?\n/);
  const sanitizedLines = stackLines
    .slice(0, MAX_ERROR_STACK_LINES)
    .map(line => sanitizeProviderError(line) ?? '')
    .join('\n');
  const lineLimitedStack = stackLines.length > MAX_ERROR_STACK_LINES
    ? `${sanitizedLines}\n[STACK_TRUNCATED]`
    : sanitizedLines;

  return lineLimitedStack.length > MAX_ERROR_STACK_LENGTH
    ? `${lineLimitedStack.slice(0, MAX_ERROR_STACK_LENGTH)}\n[STACK_TRUNCATED]`
    : lineLimitedStack;
}
