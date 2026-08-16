import type { ReactElement } from 'react';

interface SbtPolygonScanLinkProps {
  transactionHash: string | null;
}

const BLOCKCHAIN_EXPLORER_TX_BASE_URL = String(
  process.env.NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL || 'https://amoy.polygonscan.com/tx'
).trim();

/** Dựng URL PolygonScan từ tx hash với base URL testnet mặc định của hệ thống. */
function buildExplorerUrl(transactionHash: string): string {
  return `${BLOCKCHAIN_EXPLORER_TX_BASE_URL.replace(/\/$/, '')}/${encodeURIComponent(transactionHash)}`;
}

/** Hiển thị link explorer khi có tx hash hoặc trạng thái thiếu giao dịch khi chưa có. */
export default function SbtPolygonScanLink({ transactionHash }: SbtPolygonScanLinkProps): ReactElement {
  const normalizedHash = transactionHash?.trim() || null;
  if (!normalizedHash) {
    return <p data-testid="sbt-polygon-scan-missing" className="mt-4 text-sm text-slate-500">Chưa có mã giao dịch on-chain</p>;
  }

  return (
    <a
      data-testid="sbt-polygon-scan-link"
      href={buildExplorerUrl(normalizedHash)}
      target="_blank"
      rel="noreferrer"
      className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700"
    >
      Xem trên PolygonScan
    </a>
  );
}
