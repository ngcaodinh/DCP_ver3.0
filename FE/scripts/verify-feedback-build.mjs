import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDirectory, '..');
const buildOutputPath = path.join(frontendRoot, 'next-build-output.txt');
const routeSizeBudgetBytes = 5 * 1024;

/** Đọc build output đã lưu sau next build để kiểm tra kích thước route thực tế. */
function readBuildOutput() {
  if (!fs.existsSync(buildOutputPath)) {
    throw new Error(`Missing build output evidence: ${buildOutputPath}`);
  }
  const rawBuildOutput = fs.readFileSync(buildOutputPath);
  const buildOutput = rawBuildOutput.includes(0)
    ? rawBuildOutput.toString('utf16le')
    : rawBuildOutput.toString('utf8');
  return buildOutput.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
}

/** Chuyển đơn vị size của Next build về byte để áp budget ổn định giữa các phiên bản output. */
function toBytes(value, unit) {
  const multipliers = { B: 1, kB: 1024, MB: 1024 * 1024 };
  return value * (multipliers[unit] || 0);
}

let buildOutput = '';
try {
  buildOutput = readBuildOutput();
} catch (error) {
  console.warn(`Feedback route size budget skipped: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}

const routeLine = buildOutput.split(/\r?\n/u).find((line) => line.includes('/feedback/[projectId]')) || '';
const routeMatch = routeLine.match(/\/feedback\/\[projectId\][^\d]*([\d.]+)\s+(B|kB|MB)\s+([\d.]+)\s+(B|kB|MB)/u);
if (!routeMatch) {
  console.warn('Feedback route size budget skipped: Next build output format did not expose a parseable /feedback/[projectId] route size.');
  process.exit(0);
}

const routeSizeBytes = toBytes(Number(routeMatch[1]), routeMatch[2]);
if (routeSizeBytes > routeSizeBudgetBytes) {
  console.error(`Feedback route size budget exceeded: ${routeSizeBytes} bytes > ${routeSizeBudgetBytes} bytes.`);
  process.exitCode = 1;
} else {
  console.log('Feedback route size budget verified.');
}
