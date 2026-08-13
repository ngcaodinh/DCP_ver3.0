import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface LifecycleLogRecord {
  message?: string;
  stack?: string;
  error?: string;
  exception?: boolean;
  rejection?: boolean;
}

/** Chạy child process production-like để kiểm tra chính lifecycle sink của Winston. */
function runLifecycleProbe(logDirectory: string, script: string): void {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    LOG_DRIVER: 'winston',
    LOG_FILE_ENABLED: 'true',
    LOG_DIR: logDirectory,
    LOG_LEVEL: 'info'
  };
  delete childEnvironment.VITEST;

  const result = spawnSync(
    process.execPath,
    ['-r', 'tsx/cjs', '-e', script, '--', 'raw-process-argument-secret'],
    {
      cwd: resolve(__dirname, '../../..'),
      env: childEnvironment,
      encoding: 'utf8',
      timeout: 15_000
    }
  );

  expect(result.error, result.stderr || result.stdout).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

/** Đọc record JSON cuối cùng từ file lifecycle và bảo đảm file không còn là placeholder. */
function readLifecycleRecord(logDirectory: string, filePrefix: string): LifecycleLogRecord {
  const fileName = readdirSync(logDirectory).find(
    candidate => candidate.startsWith(filePrefix) && candidate.endsWith('.log')
  );
  expect(fileName).toBeDefined();

  const content = readFileSync(join(logDirectory, fileName!), 'utf8').trim();
  expect(content).not.toBe('undefined');
  const lines = content.split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines.at(-1)!) as LifecycleLogRecord;
}

describe('E6 — Winston lifecycle exception/rejection transports', () => {
  it.each([
    ['uncaught exception', 'dcp-exception-', 'setTimeout(() => { throw new Error(PROBE_ERROR); }, 10);'],
    ['unhandled rejection', 'dcp-rejection-', 'setTimeout(() => Promise.reject(new Error(PROBE_ERROR)), 10);']
  ])('ghi JSON record đã redact cho %s trong file transport thật', (_label, filePrefix, trigger) => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'dcp-e6-lifecycle-'));
    const rawSecret = 'raw-lifecycle-secret';
    const rawWallet = '0xabcdef1234567890abcdef1234567890abcdef12';
    const script = [
      "require('./src/utils/logger');",
      `const PROBE_ERROR = ${JSON.stringify(`lifecycle https://user:password@example.com?apiKey=${rawSecret} Bearer bearer-secret 203.0.113.8 ${rawWallet}`)};`,
      trigger,
      'setTimeout(() => undefined, 300);'
    ].join('\n');

    try {
      runLifecycleProbe(logDirectory, script);
      const record = readLifecycleRecord(logDirectory, filePrefix);
      const serialized = JSON.stringify(record);

      expect(serialized).toContain('[REDACTED_URL]');
      expect(serialized).toContain('[REDACTED]');
      expect(serialized).not.toContain(rawSecret);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('bearer-secret');
      expect(serialized).not.toContain('203.0.113.8');
      expect(serialized).not.toContain(rawWallet);
      expect(serialized).not.toContain('raw-process-argument-secret');
      expect(record.message || record.stack || record.error).toBeTruthy();
    } finally {
      rmSync(logDirectory, { recursive: true, force: true });
    }
  });
});
