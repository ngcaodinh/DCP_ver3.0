import type { ReactElement } from 'react';
import type { SbtTokenOffChainDetail, SbtTokenOnChainDetail } from '@/app/types/impactSbt';
import { isAllowedIpfsGatewayUrl } from '@/app/utils/ipfs';

interface SbtMetadataPanelProps {
  onChainTokenId: number;
  onChain: SbtTokenOnChainDetail;
  offChain: SbtTokenOffChainDetail | null;
  imageGatewayUrl: string | null;
  ipfsMetadata: unknown;
  ipfsError: string | null;
}

/** Định dạng timestamp ISO cho người dùng Việt Nam và giữ chuỗi gốc khi dữ liệu lỗi. */
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) return value;
  return parsedDate.toLocaleString('vi-VN', { hour12: false });
}

/** Chỉ cho phép link tới gateway IPFS HTTPS nằm trong allowlist public của frontend. */
function getSafeHttpUrl(value: string | null): string | null {
  return value && isAllowedIpfsGatewayUrl(value) ? value : null;
}

/** Serialize metadata động để hiển thị trong vùng details mà không làm hỏng trang. */
function stringifyMetadata(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return 'Không thể hiển thị metadata JSON.';
  }
}

/** Hiển thị các field public on-chain, off-chain và metadata IPFS của một SBT. */
export default function SbtMetadataPanel({
  onChainTokenId,
  onChain,
  offChain,
  imageGatewayUrl,
  ipfsMetadata,
  ipfsError
}: SbtMetadataPanelProps): ReactElement {
  const safeImageGatewayUrl = getSafeHttpUrl(imageGatewayUrl);

  return (
    <section data-testid="sbt-metadata-panel" className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Thông tin SBT</h2>
      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Token ID</dt>
          <dd className="mt-1 font-mono font-semibold text-slate-900">#{onChainTokenId}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Trạng thái on-chain</dt>
          <dd className="mt-1 font-mono font-semibold text-slate-900">{onChain.tokenStatus ?? 'UNKNOWN'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Project ID on-chain</dt>
          <dd className="mt-1 font-mono text-slate-900">{onChain.projectId}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Milestone on-chain</dt>
          <dd className="mt-1 font-mono text-slate-900">{onChain.milestone}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Người thụ hưởng</dt>
          <dd className="mt-1 font-mono text-slate-900">{onChain.beneficiaryCount}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Minted lúc</dt>
          <dd className="mt-1 text-slate-900">{formatDateTime(onChain.mintedAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-slate-500">GPS</dt>
          <dd className="mt-1 font-mono text-slate-900">{onChain.gpsCoordinates || 'Không có dữ liệu'}</dd>
        </div>
      </dl>

      {offChain ? (
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Metadata off-chain</h3>
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Project ID</dt>
              <dd className="mt-1 font-mono text-slate-900">{offChain.projectId}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Milestone</dt>
              <dd className="mt-1 font-mono text-slate-900">{offChain.milestone}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Người thụ hưởng</dt>
              <dd className="mt-1 font-mono text-slate-900">{offChain.beneficiaryCount}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Xác nhận lúc</dt>
              <dd className="mt-1 text-slate-900">{formatDateTime(offChain.confirmedAt)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">Image CID</dt>
              <dd className="mt-1 break-all font-mono text-xs text-slate-900">{offChain.imageCid || '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">Token URI</dt>
              <dd className="mt-1 break-all font-mono text-xs text-slate-900">{offChain.tokenUri || '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">Transaction hash</dt>
              <dd className="mt-1 break-all font-mono text-xs text-slate-900">{offChain.transactionHash ?? '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">Lý do trạng thái</dt>
              <dd className="mt-1 text-slate-900">{offChain.tokenStatusReason ?? '—'}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">Chưa có metadata off-chain.</p>
      )}

      <div className="mt-6 border-t border-slate-100 pt-5">
        <h3 className="text-sm font-semibold text-slate-900">IPFS</h3>
        {safeImageGatewayUrl ? (
          <a
            href={safeImageGatewayUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block break-all text-sm font-semibold text-cyan-700 underline underline-offset-2 hover:text-cyan-900"
          >
            Mở ảnh qua IPFS gateway
          </a>
        ) : (
          <p className="mt-2 text-sm text-slate-500">Không có URL gateway ảnh.</p>
        )}
        {ipfsError && (
          <p data-testid="sbt-ipfs-error" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Không tải được metadata IPFS: {ipfsError}
          </p>
        )}
        <details className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">Xem JSON metadata</summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-700">
            {stringifyMetadata(ipfsMetadata)}
          </pre>
        </details>
      </div>
    </section>
  );
}
