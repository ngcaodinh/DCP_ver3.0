import { isAddress } from 'ethers';

export type ConfiguredCertificateFinalityMode = 'AUTO' | 'RPC_FINALIZED' | 'CONFIRMATIONS';

export interface DonationCertificateConfig {
  enabled: boolean;
  startAt: Date;
  preferredFinalityMode: ConfiguredCertificateFinalityMode;
  pollIntervalMs: number;
  fallbackConfirmations: 12;
  chainId: number;
  networkName: string;
  explorerTransactionBaseUrl: string;
  donationContractAddress: string;
  frontendUrl: string;
}

const FALLBACK_CONFIRMATIONS = 12 as const;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 10_000;

/** Đọc biến môi trường bắt buộc, tránh khởi chạy feature với cấu hình thiếu. */
function readRequiredValue(variableName: string): string {
  const value = String(process.env[variableName] ?? '').trim();
  if (!value) throw new Error(`${variableName} là bắt buộc khi bật Donation Certificate.`);
  return value;
}

/** Xác thực URL public và bỏ dấu gạch chéo cuối để tạo liên kết nhất quán. */
function parsePublicUrl(variableName: string, value: string, allowLocalHttp: boolean): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${variableName} phải là URL hợp lệ.`);
  }
  const isLocalHttp = allowLocalHttp && parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !isLocalHttp) {
    throw new Error(`${variableName} phải dùng HTTPS.`);
  }
  return parsedUrl.toString().replace(/\/$/, '');
}

/** Phân tích cấu hình pipeline certificate từ environment theo nguyên tắc fail-closed. */
export function getDonationCertificateConfig(): DonationCertificateConfig {
  const enabled = String(process.env.DONATION_CERTIFICATE_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    return {
      enabled: false, startAt: new Date(0), preferredFinalityMode: 'AUTO', pollIntervalMs: 2_000,
      fallbackConfirmations: FALLBACK_CONFIRMATIONS, chainId: Number(process.env.BLOCKCHAIN_CHAIN_ID ?? 0) || 0,
      networkName: String(process.env.BLOCKCHAIN_NETWORK_NAME ?? ''), explorerTransactionBaseUrl: String(process.env.BLOCKCHAIN_EXPLORER_TX_BASE_URL ?? '').replace(/\/$/, ''),
      donationContractAddress: String(process.env.DONATION_RANKING_CONTRACT_ADDRESS ?? ''), frontendUrl: String(process.env.FRONTEND_URL ?? '').replace(/\/$/, '')
    };
  }
  const startAtValue = String(process.env.DONATION_CERTIFICATE_START_AT ?? '').trim();
  const parsedStartAt = new Date(startAtValue);
  if (Number.isNaN(parsedStartAt.getTime())) throw new Error('DONATION_CERTIFICATE_START_AT phải là ISO date hợp lệ.');

  const preferredFinalityMode = String(process.env.DONATION_CERTIFICATE_FINALITY_MODE ?? 'AUTO').trim() as ConfiguredCertificateFinalityMode;
  if (!['AUTO', 'RPC_FINALIZED', 'CONFIRMATIONS'].includes(preferredFinalityMode)) {
    throw new Error('DONATION_CERTIFICATE_FINALITY_MODE phải là AUTO, RPC_FINALIZED hoặc CONFIRMATIONS.');
  }
  const pollIntervalMs = Number(process.env.DONATION_CERTIFICATE_FINALITY_POLL_MS ?? '2000');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS || pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new Error(`DONATION_CERTIFICATE_FINALITY_POLL_MS phải trong khoảng ${MIN_POLL_INTERVAL_MS}-${MAX_POLL_INTERVAL_MS}.`);
  }
  if (String(process.env.DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS ?? FALLBACK_CONFIRMATIONS) !== String(FALLBACK_CONFIRMATIONS)) {
    throw new Error('DONATION_CERTIFICATE_FALLBACK_CONFIRMATIONS phải bằng 12.');
  }

  const chainId = Number(readRequiredValue('BLOCKCHAIN_CHAIN_ID'));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('BLOCKCHAIN_CHAIN_ID phải là số nguyên dương hợp lệ.');
  const donationContractAddress = readRequiredValue('DONATION_RANKING_CONTRACT_ADDRESS');
  if (!isAddress(donationContractAddress)) throw new Error('DONATION_RANKING_CONTRACT_ADDRESS không hợp lệ.');

  const allowLocalHttp = process.env.NODE_ENV !== 'production';
  const frontendUrl = parsePublicUrl('FRONTEND_URL', readRequiredValue('FRONTEND_URL'), allowLocalHttp);
  const explorerTransactionBaseUrl = parsePublicUrl(
    'BLOCKCHAIN_EXPLORER_TX_BASE_URL',
    readRequiredValue('BLOCKCHAIN_EXPLORER_TX_BASE_URL'),
    allowLocalHttp
  );
  const networkName = readRequiredValue('BLOCKCHAIN_NETWORK_NAME');

  if (enabled && process.env.NODE_ENV === 'production' && (!frontendUrl.startsWith('https://') || !explorerTransactionBaseUrl.startsWith('https://'))) {
    throw new Error('Production yêu cầu FRONTEND_URL và BLOCKCHAIN_EXPLORER_TX_BASE_URL dùng HTTPS.');
  }
  return { enabled, startAt: parsedStartAt, preferredFinalityMode, pollIntervalMs, fallbackConfirmations: FALLBACK_CONFIRMATIONS, chainId, networkName, explorerTransactionBaseUrl, donationContractAddress, frontendUrl };
}
