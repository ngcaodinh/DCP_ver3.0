'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';
import {
  buildIpfsGatewayUrl,
  getIpfsContentType,
  isValidIpfsCid,
  resolveIpfsPreviewKind
} from '@/app/utils/ipfs';

type IpfsEvidencePreviewCardProps = {
  cid: string;
  fileName?: string;
  mimeType?: string;
  documentTypeLabel?: string;
  fileSizeLabel?: string;
  compact?: boolean;
};

type PreviewState = 'loading' | 'ready' | 'error';
type PreviewKind = 'image' | 'pdf' | 'unknown';

/** Hàm cắt ngắn CID để hiển thị gọn trong card. Mục đích: giữ layout ổn định nhưng vẫn giúp người dùng nhận diện tài liệu. */
function formatCompactCid(cidValue: string): string {
  if (cidValue.length <= 18) {
    return cidValue;
  }

  return `${cidValue.slice(0, 10)}...${cidValue.slice(-6)}`;
}

/** Hàm component render card preview IPFS thống nhất. Mục đích: gom logic validate, phân loại file và fallback UI vào một nơi tái sử dụng. */
export default function IpfsEvidencePreviewCard({
  cid,
  fileName,
  mimeType,
  documentTypeLabel,
  fileSizeLabel,
  compact = false
}: IpfsEvidencePreviewCardProps) {
  const trimmedCid = cid.trim();
  const isValidCid = isValidIpfsCid(trimmedCid);
  const gatewayUrl = useMemo(() => buildIpfsGatewayUrl(trimmedCid), [trimmedCid]);
  const initialPreviewKind = useMemo(
    () => resolveIpfsPreviewKind({ mimeType, fileName }),
    [fileName, mimeType]
  );

  const [previewKind, setPreviewKind] = useState<PreviewKind>(initialPreviewKind);
  const [previewState, setPreviewState] = useState<PreviewState>('ready');

  useEffect(() => {
    setPreviewKind(initialPreviewKind);
    setPreviewState(initialPreviewKind === 'unknown' ? 'loading' : 'ready');
  }, [initialPreviewKind, trimmedCid]);

  useEffect(() => {
    if (!isValidCid || initialPreviewKind !== 'unknown') {
      return;
    }

    let isCancelled = false;

    /** Hàm tải content-type theo kiểu best effort. Mục đích: xác định preview khi dữ liệu ban đầu chưa đủ thông tin. */
    async function loadContentType(): Promise<void> {
      const contentType = await getIpfsContentType(trimmedCid);
      if (isCancelled) {
        return;
      }

      // Ghi chú logic phức tạp: request HEAD chỉ còn vai trò tối ưu phân loại renderer,
      // không được phép chặn việc tải asset thực tế vì nhánh unknown đã tự render trực tiếp bằng object.
      const resolvedPreviewKind = resolveIpfsPreviewKind({ mimeType, fileName, contentType });
      setPreviewKind(resolvedPreviewKind);
      setPreviewState('ready');
    }

    loadContentType().catch(() => {
      if (!isCancelled) {
        setPreviewKind('unknown');
        setPreviewState('error');
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [fileName, initialPreviewKind, isValidCid, mimeType, trimmedCid]);

  /** Hàm xử lý lỗi preview từ thẻ ảnh hoặc iframe. Mục đích: hạ cấp về unknown để tránh khung preview làm vỡ giao diện. */
  function handlePreviewError(): void {
    setPreviewKind('unknown');
    setPreviewState('error');
  }

  const cardClassName = compact
    ? 'rounded-lg border border-slate-200 bg-white p-3'
    : 'rounded-xl border border-slate-200 bg-white p-3 shadow-sm';
  const previewFrameClassName = compact ? 'h-32 rounded-lg' : 'h-44 rounded-xl';

  if (!isValidCid) {
    return (
      <div className={`${cardClassName} border-red-200 bg-red-50`}>
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-red-200 bg-white text-center text-xs font-semibold text-red-600">
          CID không hợp lệ
        </div>
        <div className="mt-3 space-y-1">
          <p className="text-xs font-semibold text-slate-900">{fileName || 'Tài liệu IPFS'}</p>
          <p className="break-all font-mono text-[11px] text-red-600">{trimmedCid}</p>
          <p className="text-[11px] text-red-600">Không render link vì CID không đúng định dạng.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cardClassName}>
      <div className={`relative overflow-hidden border border-slate-200 bg-slate-50 ${previewFrameClassName}`}>
        {previewKind === 'image' ? (
          <Image
            src={gatewayUrl}
            alt={fileName || `Tài liệu IPFS ${formatCompactCid(trimmedCid)}`}
            fill
            unoptimized
            sizes={compact ? '(max-width: 640px) 100vw, 50vw' : '(max-width: 768px) 100vw, 50vw'}
            className="object-cover"
            onError={handlePreviewError}
          />
        ) : null}

        {previewKind === 'pdf' ? (
          <iframe
            src={`${gatewayUrl}#view=FitH`}
            title={fileName || `Tài liệu PDF ${formatCompactCid(trimmedCid)}`}
            className="h-full w-full"
            loading="lazy"
            onError={handlePreviewError}
          />
        ) : null}

        {previewKind === 'unknown' ? (
          <object data={gatewayUrl} className="h-full w-full" aria-label={fileName || 'Tài liệu IPFS'}>
            <div className="flex h-full flex-col items-center justify-center px-4 text-center">
              <p className="text-sm font-semibold text-slate-700">Không thể xem trước trực tiếp</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {previewState === 'loading'
                  ? 'Đang tối ưu kiểu xem trước...'
                  : 'Nhấn mở IPFS để xem tài liệu trong tab mới.'}
              </p>
            </div>
          </object>
        ) : null}
      </div>

      <div className="mt-3 space-y-1.5">
        <p className="text-sm font-semibold text-slate-900">{fileName || 'Tài liệu IPFS'}</p>
        {documentTypeLabel || mimeType || fileSizeLabel ? (
          <p className="text-[11px] text-slate-600">
            {[documentTypeLabel, mimeType, fileSizeLabel].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        <p className="break-all font-mono text-[11px] text-cyan-700">
          CID: {compact ? formatCompactCid(trimmedCid) : trimmedCid}
        </p>
        <a
          href={gatewayUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex rounded-md border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-semibold text-cyan-700 transition hover:bg-cyan-100"
        >
          Mở tài liệu IPFS
        </a>
      </div>
    </div>
  );
}
