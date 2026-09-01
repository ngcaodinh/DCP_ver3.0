import { afterEach, describe, expect, it } from 'vitest';
import { getDonationCertificateConfig } from '../../config/donationCertificateConfig';

const originalEnvironment = { ...process.env };

const validCertificateEnvironment = {
  DONATION_CERTIFICATE_ENABLED: 'true',
  DONATION_CERTIFICATE_START_AT: '2026-08-31T00:00:00.000Z',
  DONATION_CERTIFICATE_FINALITY_MODE: 'AUTO',
  DONATION_CERTIFICATE_FINALITY_POLL_MS: '2000',
  DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS: '12',
  FRONTEND_URL: 'https://tuthienminhbach.online',
  BLOCKCHAIN_CHAIN_ID: '80002',
  BLOCKCHAIN_NETWORK_NAME: 'Polygon Amoy',
  BLOCKCHAIN_EXPLORER_TX_BASE_URL: 'https://amoy.polygonscan.com/tx',
  DONATION_RANKING_CONTRACT_ADDRESS: '0xFEBbdF5e03F7Cc62BF8e6214697b319008704Fd6'
};

/** Khôi phục environment để các case parser không rò cấu hình vào test khác. */
function restoreEnvironment(): void { for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]; Object.assign(process.env, originalEnvironment); }

/** Áp dụng cấu hình hợp lệ rồi ghi đè đúng biến môi trường của case đang kiểm thử. */
function setValidCertificateEnvironment(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, validCertificateEnvironment, overrides);
}

afterEach(restoreEnvironment);

describe('getDonationCertificateConfig', () => {
  it('đọc AUTO, poll 2000 ms và fallback 12 từ cấu hình hợp lệ', () => {
    setValidCertificateEnvironment();
    expect(getDonationCertificateConfig()).toMatchObject({ enabled: true, preferredFinalityMode: 'AUTO', pollIntervalMs: 2000, fallbackConfirmations: 12, chainId: 80002 });
  });

  it.each(['0', '13', 'abc'])('từ chối fallback confirmations %s', value => {
    setValidCertificateEnvironment({ DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS: value });
    expect(() => getDonationCertificateConfig()).toThrow('DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS phải bằng 12.');
  });

  it('tắt mặc định mà không yêu cầu các biến bắt buộc của feature', () => {
    process.env.DONATION_CERTIFICATE_ENABLED = 'false';
    delete process.env.BLOCKCHAIN_CHAIN_ID;
    delete process.env.FRONTEND_URL;

    expect(getDonationCertificateConfig()).toMatchObject({ enabled: false, fallbackConfirmations: 12 });
  });

  it('từ chối startAt không phải ISO date', () => {
    setValidCertificateEnvironment({ DONATION_CERTIFICATE_START_AT: 'not-a-date' });
    expect(() => getDonationCertificateConfig()).toThrow('DONATION_CERTIFICATE_START_AT');
  });

  it('từ chối finality mode ngoài enum', () => {
    setValidCertificateEnvironment({ DONATION_CERTIFICATE_FINALITY_MODE: 'LATEST' });
    expect(() => getDonationCertificateConfig()).toThrow('DONATION_CERTIFICATE_FINALITY_MODE');
  });

  it.each(['999', '10001', '2000.5'])('từ chối poll interval không hợp lệ: %s', value => {
    setValidCertificateEnvironment({ DONATION_CERTIFICATE_FINALITY_POLL_MS: value });
    expect(() => getDonationCertificateConfig()).toThrow('DONATION_CERTIFICATE_FINALITY_POLL_MS');
  });

  it.each(['0', '-1', '80002.5', 'abc'])('từ chối chain ID không hợp lệ: %s', value => {
    setValidCertificateEnvironment({ BLOCKCHAIN_CHAIN_ID: value });
    expect(() => getDonationCertificateConfig()).toThrow('BLOCKCHAIN_CHAIN_ID');
  });

  it('từ chối địa chỉ donation contract không hợp lệ', () => {
    setValidCertificateEnvironment({ DONATION_RANKING_CONTRACT_ADDRESS: 'not-an-address' });
    expect(() => getDonationCertificateConfig()).toThrow('DONATION_RANKING_CONTRACT_ADDRESS');
  });

  it.each([
    ['FRONTEND_URL', { FRONTEND_URL: '' }],
    ['BLOCKCHAIN_EXPLORER_TX_BASE_URL', { BLOCKCHAIN_EXPLORER_TX_BASE_URL: '' }],
    ['BLOCKCHAIN_NETWORK_NAME', { BLOCKCHAIN_NETWORK_NAME: '' }]
  ])('từ chối thiếu cấu hình %s', (_name, override) => {
    setValidCertificateEnvironment(override);
    expect(() => getDonationCertificateConfig()).toThrow();
  });

  it.each([
    ['frontend', { FRONTEND_URL: 'http://dcp.example.com' }],
    ['explorer', { BLOCKCHAIN_EXPLORER_TX_BASE_URL: 'http://explorer.example.com/tx' }]
  ])('từ chối URL HTTP trong production cho %s', (_name, override) => {
    process.env.NODE_ENV = 'production';
    setValidCertificateEnvironment(override);
    expect(() => getDonationCertificateConfig()).toThrow('HTTPS');
  });
});
