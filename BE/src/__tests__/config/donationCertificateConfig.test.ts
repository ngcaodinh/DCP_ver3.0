import { afterEach, describe, expect, it } from 'vitest';
import { getDonationCertificateConfig } from '../../config/donationCertificateConfig';

const originalEnvironment = { ...process.env };

/** Khôi phục environment để các case parser không rò cấu hình vào test khác. */
function restoreEnvironment(): void { for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]; Object.assign(process.env, originalEnvironment); }

afterEach(restoreEnvironment);

describe('getDonationCertificateConfig', () => {
  it('đọc AUTO, poll 2000 ms và fallback 12 từ cấu hình hợp lệ', () => {
    Object.assign(process.env, { DONATION_CERTIFICATE_ENABLED: 'true', DONATION_CERTIFICATE_START_AT: '2026-08-31T00:00:00.000Z', DONATION_CERTIFICATE_FINALITY_MODE: 'AUTO', DONATION_CERTIFICATE_FINALITY_POLL_MS: '2000', DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS: '12', FRONTEND_URL: 'https://tuthienminhbach.online', BLOCKCHAIN_CHAIN_ID: '80002', BLOCKCHAIN_NETWORK_NAME: 'Polygon Amoy', BLOCKCHAIN_EXPLORER_TX_BASE_URL: 'https://amoy.polygonscan.com/tx', DONATION_RANKING_CONTRACT_ADDRESS: '0xFEBbdF5e03F7Cc62BF8e6214697b319008704Fd6' });
    expect(getDonationCertificateConfig()).toMatchObject({ enabled: true, preferredFinalityMode: 'AUTO', pollIntervalMs: 2000, fallbackConfirmations: 12, chainId: 80002 });
  });

  it.each(['0', '13', 'abc'])('từ chối fallback confirmations %s', value => {
    Object.assign(process.env, { DONATION_CERTIFICATE_ENABLED: 'true', DONATION_CERTIFICATE_START_AT: '2026-08-31T00:00:00.000Z', DONATION_CERTIFICATE_FINALITY_MODE: 'AUTO', DONATION_CERTIFICATE_FINALITY_POLL_MS: '2000', DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS: value, FRONTEND_URL: 'https://tuthienminhbach.online', BLOCKCHAIN_CHAIN_ID: '80002', BLOCKCHAIN_NETWORK_NAME: 'Polygon Amoy', BLOCKCHAIN_EXPLORER_TX_BASE_URL: 'https://amoy.polygonscan.com/tx', DONATION_RANKING_CONTRACT_ADDRESS: '0xFEBbdF5e03F7Cc62BF8e6214697b319008704Fd6' });
    expect(() => getDonationCertificateConfig()).toThrow('DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS phải bằng 12.');
  });
});
