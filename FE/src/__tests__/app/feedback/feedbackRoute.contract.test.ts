import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../../../../../');
const frontendRoot = path.join(repositoryRoot, 'FE');

/** Đọc source route để kiểm tra các hợp đồng SSR/no-JS ở nơi test dễ chẩn đoán. */
function readFrontendFile(...segments: string[]): string {
  return fs.readFileSync(path.join(frontendRoot, ...segments), 'utf8');
}

/** Gộp source của route feedback để chắc chắn không có client directive ẩn trong file con. */
function readFeedbackRouteSource(): string {
  const routeDirectory = path.join(frontendRoot, 'app', 'feedback');
  const routeFiles = fs.readdirSync(routeDirectory, { recursive: true, encoding: 'utf8' })
    .filter(entry => /\.(?:tsx?|jsx?)$/u.test(entry));
  return routeFiles
    .map(entry => fs.readFileSync(path.join(routeDirectory, entry), 'utf8'))
    .join('\n');
}

describe('feedback route contract', () => {
  it('giữ route feedback là server-rendered và dynamic', () => {
    const routeSource = readFeedbackRouteSource();
    const pageSource = readFrontendFile('app', 'feedback', '[projectId]', 'page.tsx');

    expect(routeSource).not.toMatch(/^\s*["']use client["']/mu);
    expect(pageSource).toContain("export const dynamic = 'force-dynamic'");
    expect(pageSource).toMatch(/cache:\s*['"]no-store['"]/u);
  });

  it('giữ chính sách no-store và loại route feedback khỏi robots', () => {
    const nextConfigSource = readFrontendFile('next.config.js');
    const robotsSource = readFrontendFile('app', 'robots.ts');

    expect(nextConfigSource).toMatch(/source:\s*['"]\/feedback\(\/:path\*\)\?['"]/u);
    expect(nextConfigSource).toMatch(/value:\s*['"]no-store['"]/u);
    expect(robotsSource).toContain("'/feedback'");
  });

  it('giữ form POST thẳng backend và timeout stats độc lập', () => {
    const formSource = readFrontendFile('app', 'components', 'feedback', 'FeedbackForm.tsx');
    const statsSource = readFrontendFile('app', 'feedback', '[projectId]', 'feedbackStats.ts');

    expect(formSource).toMatch(/method\s*=\s*["']POST["']/u);
    expect(formSource).toMatch(/action=\{\s*buildApiUrl\(\s*["']\/api\/feedback\/single["']\s*\)\s*\}/u);
    expect(statsSource).toContain('new AbortController()');
    expect(statsSource).toContain('2_000');
  });

  it('giữ loading boundary để prefetch không tiêu ticket một lần', () => {
    const loadingPath = path.join(frontendRoot, 'app', 'feedback', '[projectId]', 'loading.tsx');

    expect(fs.existsSync(loadingPath)).toBe(true);
    expect(fs.readFileSync(loadingPath, 'utf8')).toContain('tiêu ticket');
  });
});
