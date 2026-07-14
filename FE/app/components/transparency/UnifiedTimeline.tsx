'use client';

// =============================================================================
// UnifiedTimeline — D4: Trực quan hóa dòng tiền hợp nhất dưới dạng timeline dọc.
// Render theo eventType (DEPOSIT/DONATION/DISBURSEMENT/MINT/UNKNOWN), che bớt
// walletAddress, link chainTxHash sang PolygonScan, nối các sự kiện cùng
// correlationId bằng đường nối. Có empty state và error state (nút thử lại).
// Phân trang "Xem thêm" (fetchNextPage), KHÔNG virtualization (BE cap 50/trang).
// =============================================================================

import { useMemo } from 'react';
import type { TimelineEvent, TimelineEventType, ChainStatus } from './types';
import { formatVnd } from './format';

/** Thuộc tính cho UnifiedTimeline. */
export interface UnifiedTimelineProps {
  events: TimelineEvent[];
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/** Base URL explorer để dựng link giao dịch on-chain (fallback Amoy PolygonScan). */
const BLOCKCHAIN_EXPLORER_TX_BASE_URL = String(
  process.env.NEXT_PUBLIC_BLOCKCHAIN_EXPLORER_TX_BASE_URL || 'https://amoy.polygonscan.com/tx'
).trim();

/** Nhãn tiếng Việt cho từng loại sự kiện. */
const EVENT_TYPE_LABELS: Record<TimelineEventType, string> = {
  DEPOSIT: 'Nạp tiền',
  DONATION: 'Quyên góp',
  DISBURSEMENT: 'Giải ngân',
  MINT: 'Phát hành token',
  UNKNOWN: 'Không xác định'
};

/** Biểu tượng (emoji) đại diện cho từng loại sự kiện — thuần text, không cần thư viện icon. */
const EVENT_TYPE_ICONS: Record<TimelineEventType, string> = {
  DEPOSIT: '₫',
  DONATION: '♥',
  DISBURSEMENT: '↗',
  MINT: '✦',
  UNKNOWN: '?'
};

/** Màu viền/nền chấm mốc theo loại sự kiện. */
const EVENT_TYPE_DOT_CLASSES: Record<TimelineEventType, string> = {
  DEPOSIT: 'bg-amber-100 text-amber-700 border-amber-300',
  DONATION: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  DISBURSEMENT: 'bg-blue-100 text-blue-700 border-blue-300',
  MINT: 'bg-violet-100 text-violet-700 border-violet-300',
  UNKNOWN: 'bg-slate-100 text-slate-600 border-slate-300'
};

/** Nhãn tiếng Việt cho trạng thái on-chain. */
const CHAIN_STATUS_LABELS: Record<ChainStatus, string> = {
  PENDING: 'Đang chờ',
  CONFIRMED: 'Đã xác nhận',
  FAILED: 'Thất bại',
  REORGED: 'Bị tổ chức lại'
};

/** Lớp màu badge theo trạng thái on-chain. */
const CHAIN_STATUS_BADGE_CLASSES: Record<ChainStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700',
  CONFIRMED: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-700',
  REORGED: 'bg-orange-50 text-orange-700'
};

/** Hàm định dạng mốc thời gian ISO sang giờ Việt Nam. Trả chuỗi gốc nếu không parse được. */
function formatTimestamp(isoValue: string): string {
  const parsedDate = new Date(isoValue);
  if (Number.isNaN(parsedDate.getTime())) {
    return isoValue;
  }
  return parsedDate.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Che bớt địa chỉ ví để hiển thị gọn (6 ký tự đầu + 4 ký tự cuối).
 * Địa chỉ ngắn hơn 11 ký tự giữ nguyên.
 *
 * @param walletAddress Địa chỉ ví gốc
 * @returns Chuỗi đã che dạng 0x1234...5678
 */
function maskWalletAddress(walletAddress: string): string {
  if (!walletAddress || walletAddress.length <= 10) {
    return walletAddress;
  }
  return `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
}

/**
 * Dựng URL explorer cho một tx hash. Trả rỗng nếu không có hash.
 *
 * @param transactionHashValue Mã giao dịch on-chain
 * @returns URL đầy đủ tới trang explorer, hoặc rỗng
 */
function buildTransactionExplorerUrl(transactionHashValue: string): string {
  if (!transactionHashValue) {
    return '';
  }
  return `${BLOCKCHAIN_EXPLORER_TX_BASE_URL.replace(/\/$/, '')}/${encodeURIComponent(transactionHashValue)}`;
}

/**
 * Render phần nội dung chi tiết theo từng loại sự kiện.
 * DEPOSIT: mã đơn PayOS + số tiền. DONATION: ví (che) + link tx.
 * DISBURSEMENT: trạng thái chuyển khoản + mã đơn PayOS.
 *
 * @param event Sự kiện timeline cần hiển thị
 */
function TimelineEventDetail({ event }: { event: TimelineEvent }) {
  const explorerUrl = buildTransactionExplorerUrl(event.chainTxHash ?? '');

  if (event.eventType === 'DEPOSIT') {
    return (
      <div className="space-y-1 text-sm text-slate-600">
        <p>
          Mã đơn PayOS: <span className="font-mono text-slate-900">{event.payosOrderCode || '—'}</span>
        </p>
        <p className="font-mono text-slate-900">{formatVnd(event.amountVnd)} VND</p>
      </div>
    );
  }

  if (event.eventType === 'DONATION') {
    return (
      <div className="space-y-1 text-sm text-slate-600">
        <p>
          Ví quyên góp: <span className="font-mono text-slate-900">{maskWalletAddress(event.walletAddress)}</span>
        </p>
        <p className="font-mono text-slate-900">{formatVnd(event.amountVnd)} VND</p>
        {explorerUrl ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-800"
          >
            Xem trên PolygonScan
          </a>
        ) : (
          <span className="text-xs text-slate-400">Chưa có mã giao dịch on-chain</span>
        )}
      </div>
    );
  }

  if (event.eventType === 'DISBURSEMENT') {
    return (
      <div className="space-y-1 text-sm text-slate-600">
        <p>
          Trạng thái chuyển khoản:{' '}
          <span className="font-mono text-slate-900">{event.payosStatus || CHAIN_STATUS_LABELS[event.chainStatus]}</span>
        </p>
        <p>
          Mã đơn PayOS: <span className="font-mono text-slate-900">{event.payosOrderCode || '—'}</span>
        </p>
        <p className="font-mono text-slate-900">{formatVnd(event.amountVnd)} VND</p>
      </div>
    );
  }

  // MINT và UNKNOWN: hiển thị thông tin cơ bản (số tiền + tx nếu có).
  return (
    <div className="space-y-1 text-sm text-slate-600">
      <p className="font-mono text-slate-900">{formatVnd(event.amountVnd)} VND</p>
      {explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-800"
        >
          Xem trên PolygonScan
        </a>
      )}
    </div>
  );
}

/**
 * Một dòng sự kiện trong timeline dọc.
 * `isCorrelated` = true khi sự kiện thuộc nhóm correlationId có nhiều hơn 1 sự kiện,
 * dùng để tô đậm đường nối thể hiện các bước liên quan.
 *
 * @param event Sự kiện cần render
 * @param isCorrelated Có thuộc nhóm tương quan nhiều sự kiện hay không
 * @param isLast Có phải phần tử cuối (ẩn đường nối phía dưới) hay không
 */
function TimelineRow({
  event,
  isCorrelated,
  isLast
}: {
  event: TimelineEvent;
  isCorrelated: boolean;
  isLast: boolean;
}) {
  return (
    <li className="relative flex gap-4 pb-6">
      {/* Đường nối dọc giữa các mốc; đậm hơn khi thuộc nhóm tương quan. */}
      {!isLast && (
        <span
          aria-hidden="true"
          className={`absolute left-[19px] top-10 h-full w-0.5 ${isCorrelated ? 'bg-emerald-300' : 'bg-slate-200'}`}
        />
      )}

      {/* Chấm mốc kèm icon theo loại sự kiện. */}
      <span
        aria-hidden="true"
        className={`z-10 flex h-10 w-10 flex-none items-center justify-center rounded-full border text-lg ${EVENT_TYPE_DOT_CLASSES[event.eventType]}`}
      >
        {EVENT_TYPE_ICONS[event.eventType]}
      </span>

      <div className="min-w-0 flex-1 rounded-lg border border-emerald-900/15 bg-white p-3 shadow-sm">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-slate-900">{EVENT_TYPE_LABELS[event.eventType]}</span>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${CHAIN_STATUS_BADGE_CLASSES[event.chainStatus]}`}>
            {CHAIN_STATUS_LABELS[event.chainStatus]}
          </span>
        </div>
        <p className="mb-2 text-xs text-slate-400">{formatTimestamp(event.timestamp)}</p>
        <TimelineEventDetail event={event} />
      </div>
    </li>
  );
}

/**
 * Component timeline dòng tiền hợp nhất.
 * Nhận sẵn danh sách events đã flatten từ các trang (client orchestrate),
 * cùng cờ trạng thái loading/error và callback phân trang.
 *
 * @param props Xem UnifiedTimelineProps
 */
export default function UnifiedTimeline({
  events,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore
}: UnifiedTimelineProps) {
  // Đếm số sự kiện theo correlationId để biết mốc nào thuộc nhóm tương quan (nhiều bước).
  // Memoize theo events để không tính lại khi chỉ cờ trạng thái (vd isFetchingNextPage) đổi.
  const correlationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of events) {
      counts.set(event.correlationId, (counts.get(event.correlationId) ?? 0) + 1);
    }
    return counts;
  }, [events]);

  if (isError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="mb-3 text-sm text-red-700">{errorMessage || 'Không thể tải dòng tiền. Vui lòng thử lại.'}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"
        >
          Thử lại
        </button>
      </div>
    );
  }

  if (isLoading) {
    return <div className="rounded-lg border border-emerald-900/15 bg-white p-6 text-center text-slate-500">Đang tải dòng tiền...</div>;
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-900/15 bg-white p-6 text-center text-slate-500">
        Chưa có giao dịch nào
      </div>
    );
  }

  return (
    <div>
      <ol className="relative">
        {events.map((event, index) => (
          <TimelineRow
            key={event.eventId}
            event={event}
            isCorrelated={(correlationCounts.get(event.correlationId) ?? 0) > 1}
            isLast={index === events.length - 1}
          />
        ))}
      </ol>

      {hasNextPage && (
        <div className="mt-2 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
            className="rounded-md border border-emerald-900/15 bg-white px-5 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetchingNextPage ? 'Đang tải thêm...' : 'Xem thêm'}
          </button>
        </div>
      )}
    </div>
  );
}
