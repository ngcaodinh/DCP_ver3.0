import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../../../../');

/** Đọc các biến cấu hình trong template mà không cần nạp bất kỳ secret runtime nào. */
function readExampleEnvironment(filePath: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match) entries.set(match[1], match[2]);
  }
  return entries;
}

describe('public feedback production runtime contract', () => {
  it('declares every backend runtime variable in the GHCR env template', () => {
    const backendEnvironment = readExampleEnvironment(
      path.join(repositoryRoot, 'deploy', 'env', 'backend.env.example')
    );

    expect(backendEnvironment.get('CORS_ALLOWED_ORIGINS')).toBe('https://dcp.example.com');
    expect(backendEnvironment.get('FRONTEND_URL')).toBe('https://dcp.example.com');
    expect(backendEnvironment.get('FEEDBACK_TICKET_HMAC_KEY')).toBe('');
    expect(backendEnvironment.get('FEEDBACK_IP_HASH_SALT')).toBe('');
    expect(backendEnvironment.has('FEEDBACK_CLIENT_IP_HMAC_KEY')).toBe(false);
    expect(backendEnvironment.has('CORS_ALLOWED_ORIGIN')).toBe(false);
  });

  it('uses one read-only shared HMAC source for FE, BE and worker', () => {
    const frontendEnvironment = readExampleEnvironment(
      path.join(repositoryRoot, 'deploy', 'env', 'frontend.env.example')
    );
    const sharedKeyExample = fs.readFileSync(
      path.join(repositoryRoot, 'deploy', 'env', 'feedback-client-ip-hmac.key.example'),
      'utf8'
    );
    const composeFiles = ['docker-compose.prod.yml', 'docker-compose.ghcr.yml'];

    expect(frontendEnvironment.has('FEEDBACK_CLIENT_IP_HMAC_KEY')).toBe(false);
    expect(sharedKeyExample).toContain('/opt/dcp/env/feedback-client-ip-hmac.key');
    for (const composeFile of composeFiles) {
      const compose = fs.readFileSync(path.join(repositoryRoot, composeFile), 'utf8');
      expect(compose).toContain('feedback_client_ip_hmac_key');
      expect(compose).toContain('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE: /run/secrets/feedback_client_ip_hmac_key');
      expect(compose).toContain('file: /opt/dcp/env/feedback-client-ip-hmac.key');
    }
  });

  it('loads backend.env at runtime and keeps backend secrets out of compose interpolation', () => {
    const ghcrCompose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.ghcr.yml'), 'utf8');
    const composeEnvironment = fs.readFileSync(path.join(repositoryRoot, 'deploy', 'compose.env.example'), 'utf8');

    expect(ghcrCompose).toContain('/opt/dcp/env/backend.env');
    expect(composeEnvironment).not.toMatch(/^FEEDBACK_(?:TICKET_HMAC_KEY|IP_HASH_SALT|CLIENT_IP_HMAC_KEY)=/mu);
  });

  it('overrides the frontend edge cache policy for every feedback path', () => {
    const nginxConfiguration = fs.readFileSync(
      path.join(repositoryRoot, 'deploy', 'nginx', 'dcp.conf.example'),
      'utf8'
    );
    const feedbackLocations = [
      nginxConfiguration.match(/location\s*=\s*\/feedback\s+\{([\s\S]*?)\n\s{2}\}/u)?.[1] || '',
      nginxConfiguration.match(/location\s+\^~\s+\/feedback\/\s+\{([\s\S]*?)\n\s{2}\}/u)?.[1] || ''
    ];

    expect(feedbackLocations).toHaveLength(2);
    for (const feedbackLocation of feedbackLocations) {
      expect(feedbackLocation).toContain('proxy_hide_header Cache-Control;');
      expect(feedbackLocation).toContain('add_header Cache-Control "no-store" always;');
      expect(feedbackLocation).toContain('proxy_set_header X-Feedback-Client-IP $remote_addr;');
      expect(feedbackLocation).toContain('add_header X-Frame-Options "SAMEORIGIN" always;');
      expect(feedbackLocation).toContain('add_header X-Content-Type-Options "nosniff" always;');
      expect(feedbackLocation).toContain('add_header Referrer-Policy "strict-origin-when-cross-origin" always;');
      expect(feedbackLocation).toContain('add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;');
      expect(feedbackLocation).not.toContain('s-maxage');
    }
  });

  it('keeps SSR on the internal backend URL while stripping client identity headers at the public API proxy', () => {
    const frontendEnvironment = readExampleEnvironment(
      path.join(repositoryRoot, 'deploy', 'env', 'frontend.env.example')
    );
    const nginxConfiguration = fs.readFileSync(
      path.join(repositoryRoot, 'deploy', 'nginx', 'dcp.conf.example'),
      'utf8'
    );
    const apiLocation = nginxConfiguration.match(
      /server_name\s+api\.dcp\.example\.com;([\s\S]*?)\n\}/u
    )?.[1] || '';

    expect(nginxConfiguration).not.toContain('/health/feedback-identity');
    expect(frontendEnvironment.get('BACKEND_INTERNAL_URL')).toBe('http://backend:4000');
    for (const composeFile of ['docker-compose.prod.yml', 'docker-compose.ghcr.yml']) {
      const compose = fs.readFileSync(path.join(repositoryRoot, composeFile), 'utf8');
      const frontendService = compose.split('\n  frontend:\n')[1]?.split('\nvolumes:\n')[0] || '';
      expect(frontendService).toContain('- /opt/dcp/env/frontend.env');
    }
    expect(apiLocation).toContain('proxy_set_header X-Feedback-Client-IP "";');
    expect(apiLocation).toContain('proxy_set_header X-Feedback-Client-IP-Signature "";');
    expect(apiLocation).toContain('proxy_set_header X-DCP-SSR-Request "";');
    expect(nginxConfiguration).toContain('proxy_set_header X-DCP-SSR-Request "";');
  });

  it('keeps frontend liveness local instead of probing backend identity', () => {
    const healthcheckScript = fs.readFileSync(
      path.join(repositoryRoot, 'FE', 'scripts', 'check-frontend-liveness.mjs'),
      'utf8'
    );
    const composeFiles = ['docker-compose.prod.yml', 'docker-compose.ghcr.yml'];

    expect(healthcheckScript).not.toContain('backend:4000');
    expect(healthcheckScript).not.toContain('FEEDBACK_CLIENT_IP_HMAC_KEY');
    for (const composeFile of composeFiles) {
      const compose = fs.readFileSync(path.join(repositoryRoot, composeFile), 'utf8');
      expect(compose).toContain('test: ["CMD", "node", "scripts/check-frontend-liveness.mjs"]');
    }
  });
});
