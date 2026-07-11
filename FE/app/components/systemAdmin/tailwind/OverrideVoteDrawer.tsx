'use client';

// =============================================================================
// OverrideVoteDrawer — B4: Drawer biểu quyết ghi đè GPS
// Hiển thị danh sách override request PENDING để commissioner vote APPROVE/REJECT.
// Pattern: cùng file chứa cả 3 sub-component (ListView, DetailView, VoteConfirmationDialog)
// để tránh prop-drilling qua nhiều file.
// =============================================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { formatVietnameseDateTime } from './helpers';
import type { ToastItem } from './types';
import { GpsMarkerOnlyMap } from '@/app/components/oracle/GpsMarkerOnlyMap';
import { useOverrideRequests, useSubmitOverrideVote } from '@/app/hooks/useOverrideRequests';
import {
  MIN_VOTE_REASON_LENGTH,
  GEOFENCE_DISTANCE_WARNING_METERS,
  OVERRIDE_POLLING_SIGNAL_ID,
  type OverrideRequestItem,
  type OverrideReason,
  type CommissionerSnapshotEntry,
  type GpsCoordinate
} from './overrideVoting.types';

// Re-export OverrideRequestItem as PendingOverrideItem alias để giữ
// tương thích ngược với code cũ — giảm diff trong các file test.
export type PendingOverrideItem = OverrideRequestItem;

export type OverrideVoteDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  /** ID request cụ thể để auto-select khi mở từ socket notification. */
  initialRequestId?: string | null;
  currentUserId: string;
  /**
   * @deprecated Prop không còn sử dụng — giữ optional để tương thích ngược với
   * callers cũ (AdminPage/RegulatoryPage). Có thể xóa sau khi refactor callers.
   */
  currentUserRole?: string;
  onToast: (toast: Omit<ToastItem, 'id'>) => void;
  /** Callback để AdminPage cập nhật badge số lượng pending. */
  onItemsCountChange?: (count: number) => void;
};

// =============================================================================
// HELPERS
// =============================================================================

/** Chuyển mã lý do override sang câu mô tả tiếng Việt hiển thị cho admin. */
function mapReasonToText(reason: OverrideReason): string {
  if (reason === 'OUT_OF_GEOFENCE') return 'Ảnh chụp ngoài vùng địa lý dự án';
  if (reason === 'GPS_EXIF_MISSING') return 'Ảnh không có dữ liệu GPS (EXIF thiếu)';
  return 'Dự án chưa thiết lập vùng địa lý';
}

/** Format tọa độ GPS sang chuỗi N/E/S/W với 6 chữ số thập phân. */
function formatGps(coord: GpsCoordinate): string {
  const latDir = coord.lat >= 0 ? 'N' : 'S';
  const lngDir = coord.lng >= 0 ? 'E' : 'W';
  return `${Math.abs(coord.lat).toFixed(6)}°${latDir}, ${Math.abs(coord.lng).toFixed(6)}°${lngDir}`;
}

/** Map role sang nhãn tiếng Việt để hiển thị cho người dùng. */
function mapRoleToLabel(role: string): string {
  if (role === 'admin') return 'Quản trị viên';
  if (role === 'regulatory') return 'Cơ quan giám sát';
  return role;
}


/**
 * Kiểm tra tính nhất quán nội bộ của payload override request từ BE.
 * Mục đích: phát hiện dữ liệu bất thường khi BE bị compromise hoặc có bug
 * (không có on-chain oracle để cross-check trong codebase này — xem Blockchain/ folder).
 * Trả về false + log lỗi nếu phát hiện bất kỳ invariant nào bị vi phạm.
 * [P6-fix] Optimize từ O(n²) sang O(n) bằng single-pass reduce.
 */
function validateVoteConsistency(item: PendingOverrideItem): boolean {
  const { overrideRequestId, commissionerSnapshot, votes, status } = item;

  // Không vote quá số lượng commissioner trong snapshot
  if (votes.length > commissionerSnapshot.length) {
    console.error('[OverrideVoteDrawer] Số phiếu vượt quá số ủy viên trong snapshot', {
      overrideRequestId,
      votesLength: votes.length,
      snapshotLength: commissionerSnapshot.length
    });
    return false;
  }

  // Single-pass reduce: check duplicate commissionerId + hasReject cùng lúc
  const { uniqueIds, hasReject } = votes.reduce(
    (acc, v) => {
      acc.uniqueIds.add(v.commissionerId);
      if (v.vote === 'REJECT') acc.hasReject = true;
      return acc;
    },
    { uniqueIds: new Set<string>(), hasReject: false }
  );

  // Không có commissionerId trùng lặp trong danh sách phiếu
  if (uniqueIds.size !== votes.length) {
    console.error('[OverrideVoteDrawer] Duplicate commissionerId trong danh sách phiếu biểu quyết', {
      overrideRequestId,
      votesLength: votes.length,
      uniqueVoterIdsSize: uniqueIds.size
    });
    return false;
  }

  // Nếu status là APPROVED → tất cả ủy viên phải vote APPROVE, không có REJECT
  if (status === 'APPROVED') {
    if (votes.length < commissionerSnapshot.length) {
      console.error('[OverrideVoteDrawer] Request APPROVED nhưng chưa đủ phiếu', {
        overrideRequestId,
        votesLength: votes.length,
        snapshotLength: commissionerSnapshot.length
      });
      return false;
    }
    if (hasReject) {
      console.error('[OverrideVoteDrawer] Request APPROVED nhưng có phiếu REJECT', {
        overrideRequestId
      });
      return false;
    }
  }

  // Nếu status là REJECTED → phải có ít nhất 1 phiếu REJECT
  if (status === 'REJECTED') {
    if (!hasReject) {
      console.error('[OverrideVoteDrawer] Request REJECTED nhưng không có phiếu REJECT', {
        overrideRequestId
      });
      return false;
    }
  }

  return true;
}

// =============================================================================
// VoteConfirmationDialog — dialog xác nhận trước khi gửi vote
// =============================================================================

type VoteConfirmationDialogProps = {
  vote: 'APPROVE' | 'REJECT';
  isSubmitting: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

function VoteConfirmationDialog({ vote, isSubmitting, onConfirm, onCancel }: VoteConfirmationDialogProps) {
  const [reason, setReason] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea ngay khi dialog mở để tránh thêm click
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const isValid = reason.trim().length >= MIN_VOTE_REASON_LENGTH;
  const isApprove = vote === 'APPROVE';

  return (
    // z-[60] để nằm trên drawer (z-50) và backdrop của drawer (z-40)
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 backdrop-blur-[1px] px-4"
      role="dialog"
      aria-modal="true"
      aria-label={isApprove ? 'Xác nhận đồng ý ghi đè' : 'Xác nhận từ chối ghi đè'}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${isApprove ? 'bg-emerald-100' : 'bg-red-100'}`}>
            {isApprove ? (
              <svg className="h-5 w-5 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {isApprove ? 'Xác nhận Đồng ý Ghi đè' : 'Xác nhận Từ chối Ghi đè'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {isApprove
                ? 'Phiếu của bạn sẽ được ghi nhận không thể chỉnh sửa.'
                : 'Một phiếu từ chối sẽ kết thúc ngay quá trình biểu quyết.'}
            </p>
          </div>
        </div>

        {/* Reason input */}
        <div className="mb-5">
          <label htmlFor="vote-reason" className="mb-1.5 block text-xs font-medium text-slate-700">
            Lý do biểu quyết <span className="text-red-500">*</span>
            <span className="ml-1 font-normal text-slate-400">(tối thiểu 10 ký tự)</span>
          </label>
          <textarea
            id="vote-reason"
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Nhập lý do biểu quyết..."
            rows={3}
            disabled={isSubmitting}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-50 resize-none"
          />
          <p className={`mt-1 text-xs tabular-nums ${reason.trim().length >= 10 ? 'text-emerald-600' : 'text-slate-400'}`}>
            {reason.trim().length} / 10 ký tự tối thiểu
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="flex-1 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={() => isValid && onConfirm(reason.trim())}
            disabled={!isValid || isSubmitting}
            data-testid="vote-confirm-submit"
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 ${
              isApprove ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Đang gửi...
              </span>
            ) : (
              isApprove ? 'Đồng ý Ghi đè' : 'Từ chối'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ListView — danh sách pending override requests
// =============================================================================

type ListViewProps = {
  items: PendingOverrideItem[];
  isLoading: boolean;
  errorText: string;
  currentUserId: string;
  onOpenDetail: (item: PendingOverrideItem) => void;
  onRetry: () => void;
};

function ListView({ items, isLoading, errorText, currentUserId, onOpenDetail, onRetry }: ListViewProps) {
  if (isLoading) {
    return (
      <div className="p-5 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="animate-pulse rounded-xl border border-slate-100 p-4 space-y-2">
            <div className="h-4 w-36 rounded bg-slate-200" />
            <div className="h-3 w-56 rounded bg-slate-100" />
            <div className="h-1.5 w-full rounded-full bg-slate-100" />
          </div>
        ))}
      </div>
    );
  }

  if (errorText) {
    return (
      <div className="flex flex-col items-center gap-4 p-10 text-center">
        <svg className="h-10 w-10 text-red-300" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-sm text-slate-600">{errorText}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-[#0E7C6B] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#0d6b5c]"
        >
          Thử lại
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <svg className="h-14 w-14 text-slate-200" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
        </svg>
        <p className="text-sm font-medium text-slate-600">Không có yêu cầu ghi đè GPS nào đang chờ</p>
        <p className="text-xs text-slate-400">Hệ thống sẽ tự động thông báo khi có yêu cầu mới.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {items.map((item) => {
        const myVote = item.votes.find((v) => v.commissionerId === currentUserId)?.vote ?? null;
        const total = item.commissionerSnapshot.length;
        const approveCount = item.votes.filter((v) => v.vote === 'APPROVE').length;
        const voteCount = item.votes.length;
        const hasReject = item.votes.some((v) => v.vote === 'REJECT');

      return (
        <button
          key={item.overrideRequestId}
          type="button"
          onClick={() => onOpenDetail(item)}
          className="w-full rounded-xl border border-slate-100 bg-white p-4 text-left transition hover:border-emerald-200 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{item.projectDisplayName ?? item.projectId}</p>
              <p className="mt-0.5 text-xs text-slate-500">{mapReasonToText(item.reason)}</p>
            </div>
              {myVote ? (
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
                  myVote === 'APPROVE'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  {myVote === 'APPROVE' ? 'Đã đồng ý' : 'Đã từ chối'}
                </span>
              ) : (
                <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                  Chưa vote
                </span>
              )}
            </div>

            {/* Progress bar */}
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs text-slate-400">Tiến độ biểu quyết</span>
                <span className="text-xs font-medium text-slate-600">{voteCount}/{total}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full transition-all ${hasReject ? 'bg-red-400' : 'bg-emerald-500'}`}
                  style={{ width: total > 0 ? `${(approveCount / total) * 100}%` : '0%' }}
                />
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-400">{formatVietnameseDateTime(item.createdAt)}</p>
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// DetailView — chi tiết một override request
// =============================================================================

type DetailViewProps = {
  item: PendingOverrideItem;
  currentUserId: string;
  myVote: 'APPROVE' | 'REJECT' | null;
  approveCount: number;
  voteCount: number;
  totalVoters: number;
  remainingVotes: number;
  isFullyApproved: boolean;
  isRejected: boolean;
  isResolved: boolean;
  consistencyWarning: string | null;
  onVote: (vote: 'APPROVE' | 'REJECT') => void;
  onRetry: () => void;
};

function DetailView({
  item, currentUserId, myVote, approveCount, voteCount,
  totalVoters, remainingVotes, isFullyApproved, isRejected, isResolved,
  consistencyWarning, onVote, onRetry
}: DetailViewProps) {
  const isInSnapshot = item.commissionerSnapshot.some((c) => c.isCurrentUser);

  return (
    <div className="divide-y divide-slate-100">
      {/* B2: Warning banner khi dữ liệu biểu quyết không nhất quán */}
      {consistencyWarning && (
        <div className="p-4 bg-amber-50 border-b border-amber-200">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">{consistencyWarning}</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 text-xs font-semibold text-amber-700 underline hover:text-amber-900"
              >
                Tải lại dữ liệu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status banners */}
      {(isFullyApproved || isRejected || (!isResolved && approveCount > 0)) && (
        <div className="p-4">
          {isFullyApproved && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <svg className="h-5 w-5 shrink-0 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-emerald-700">Đã duyệt — Toàn bộ ủy viên đã đồng ý ghi đè GPS</p>
            </div>
          )}
          {isRejected && !isFullyApproved && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <svg className="h-5 w-5 shrink-0 text-red-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-red-700">Đã bị từ chối — Yêu cầu không được phê duyệt</p>
            </div>
          )}
          {/* "Cần X phiếu nữa" — chỉ show khi còn pending và có ít nhất 1 approve */}
          {!isResolved && !isRejected && remainingVotes === 1 && approveCount > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <svg className="h-5 w-5 shrink-0 text-amber-600" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <p className="text-sm font-medium text-amber-700">
                Cần 1 phiếu nữa để approve — {approveCount}/{totalVoters} đã đồng ý
              </p>
            </div>
          )}
          {!isResolved && !isRejected && remainingVotes > 1 && approveCount > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <svg className="h-5 w-5 shrink-0 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <p className="text-sm text-slate-600">
                <span className="font-medium">{voteCount}/{totalVoters}</span> ủy viên đã biểu quyết ·
                Cần {remainingVotes} phiếu đồng ý nữa
              </p>
            </div>
          )}
        </div>
      )}

      {/* Project info */}
      <section className="p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Thông tin dự án</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoRow
            label="Tên dự án"
            value={item.projectDisplayName ?? item.projectId}
            valueClass={item.projectName ? 'text-slate-900 font-medium' : 'text-slate-500 italic'}
          />
          <InfoRow label="Project ID" value={item.projectId} mono />
          <InfoRow label="Tổ chức" value={item.organizationId} mono />
          {item.disbursementRequestId && (
            <InfoRow label="Giải ngân liên kết" value={item.disbursementRequestId} mono />
          )}
          <InfoRow label="Mã IPFS minh chứng" value={item.evidenceCid ? `${item.evidenceCid.slice(0, 24)}…` : 'Không có'} mono />
          <InfoRow label="Tạo lúc" value={formatVietnameseDateTime(item.createdAt)} />
        </div>
      </section>

      {/* GPS info */}
      <section className="p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Thông tin GPS</h3>
        <div className="space-y-2.5">
          {item.gpsFromImage ? (
            <InfoRow label="GPS từ ảnh (EXIF)" value={formatGps(item.gpsFromImage)} mono />
          ) : (
            <InfoRow label="GPS từ ảnh (EXIF)" value="Không có dữ liệu GPS" valueClass="text-red-600" />
          )}
          <InfoRow label="GPS dự án (trung tâm)" value={formatGps(item.gpsFromProject)} mono />
          {item.distanceMeters !== null && (
            <InfoRow
              label="Khoảng cách Haversine"
              value={`${item.distanceMeters.toFixed(1)} m${item.distanceMeters > GEOFENCE_DISTANCE_WARNING_METERS ? ' — Vượt ngưỡng' : ''}`}
              valueClass={item.distanceMeters > GEOFENCE_DISTANCE_WARNING_METERS ? 'text-red-600 font-semibold' : 'text-slate-700'}
            />
          )}
        </div>
        {/* Warning reason */}
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2">
          <p className="text-xs font-medium text-orange-700">Lý do cảnh báo: {mapReasonToText(item.reason)}</p>
        </div>

        {/* GPS marker map — hiển thị 2 điểm GPS để commissioner đánh giá trực quan.
            Dùng GpsMarkerOnlyMap (không fetch API) thay GeofenceMapLazy để tránh
            20 concurrent API calls khi drawer liệt kê 20 items (spec B4, không cần polygon). */}
        {item.reason !== 'NO_GEOFENCE' && (
          <GpsMarkerOnlyMap
            gpsFromImage={item.gpsFromImage}
            gpsFromProject={item.gpsFromProject}
            className="mt-1"
          />
        )}
      </section>

      {/* Vote progress */}
      <section className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tiến độ biểu quyết</h3>
          <span className="text-xs font-medium text-slate-600 tabular-nums">{voteCount}/{totalVoters}</span>
        </div>

        {/* Progress bar */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isRejected ? 'bg-red-500' : isFullyApproved ? 'bg-emerald-500' : 'bg-emerald-400'
            }`}
            style={{ width: totalVoters > 0 ? `${((isRejected ? voteCount : approveCount) / totalVoters) * 100}%` : '0%' }}
          />
        </div>

        {/* Step indicators */}
        <div className="flex flex-wrap gap-2">
          {item.commissionerSnapshot.map((commissioner, idx) => {
            // [B4-fix #3] BE đã redact userId → chỉ biết isCurrentUser. Không thể tra vote
            // của người khác khi PENDING (anti-collusion), nên hiển thị "Chưa vote" cho non-me.
            const castVote = commissioner.isCurrentUser
              ? item.votes.find((v) => v.commissionerId === currentUserId)
              : undefined;
            const isMe = commissioner.isCurrentUser;
            return (
              <div
                key={`${commissioner.role}-${idx}`}
                title={`${mapRoleToLabel(commissioner.role)}${isMe ? ' (Bạn)' : ''}: ${
                  castVote ? (castVote.vote === 'APPROVE' ? 'Đồng ý' : 'Từ chối') : 'Chưa vote'
                }`}
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 text-xs font-bold transition-all ${
                  !castVote
                    ? 'border-slate-200 bg-slate-50 text-slate-400'
                    : castVote.vote === 'APPROVE'
                    ? 'border-emerald-300 bg-emerald-100 text-emerald-700'
                    : 'border-red-300 bg-red-100 text-red-700'
                } ${isMe ? 'ring-2 ring-emerald-400 ring-offset-1' : ''}`}
              >
                {isMe ? (
                  // Icon người thay chữ "T" mơ hồ — tooltip đã giải thích rõ "(Bạn)"
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M10 10a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0H3z" />
                  </svg>
                ) : (idx + 1).toString()}
              </div>
            );
          })}
        </div>

        {/* Vote detail list */}
        {item.votes.length > 0 && (
          <div className="space-y-2 pt-1">
            {item.votes.map((v) => (
              <div key={v.commissionerId} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 font-medium ${
                  v.vote === 'APPROVE'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  {v.vote === 'APPROVE' ? '✓ Đồng ý' : '✗ Từ chối'}
                </span>
                <div className="min-w-0">
                  <span className="text-slate-600">{mapRoleToLabel(v.commissionerRole)}</span>
                  {v.commissionerId === currentUserId && (
                    <span className="ml-1 font-medium text-emerald-600">(Bạn)</span>
                  )}
                  <p className="truncate text-slate-400">{v.reason}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Vote action section */}
      <section className="p-4">
        {isResolved ? (
          // Không còn action khi đã resolve
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm text-slate-500">
            Yêu cầu đã {isFullyApproved ? 'được duyệt' : 'bị từ chối'} — không thể thay đổi.
          </div>
        ) : !isInSnapshot ? (
          // Admin không trong snapshot của request này
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm text-slate-500">
            Bạn không có trong danh sách ủy viên của yêu cầu này.
          </div>
        ) : myVote ? (
          // Đã vote rồi — hiển thị badge, disable button
          <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 ${
            myVote === 'APPROVE' ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'
          }`}>
            <svg
              className={`h-4 w-4 shrink-0 ${myVote === 'APPROVE' ? 'text-emerald-600' : 'text-red-600'}`}
              fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
            >
              {myVote === 'APPROVE'
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />}
            </svg>
            <p className={`text-sm font-medium ${myVote === 'APPROVE' ? 'text-emerald-700' : 'text-red-700'}`}>
              {myVote === 'APPROVE' ? 'Bạn đã Đồng ý ghi đè' : 'Bạn đã Từ chối ghi đè'}
            </p>
          </div>
        ) : (
          // Chưa vote — hiển thị nút biểu quyết
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
              Biểu quyết Ghi đè GPS
            </h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onVote('APPROVE')}
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
              >
                Đồng ý Ghi đè
              </button>
              <button
                type="button"
                onClick={() => onVote('REJECT')}
                className="flex-1 rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1"
              >
                Từ chối
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// =============================================================================
// InfoRow — helper hiển thị một cặp label/value
// =============================================================================

function InfoRow({
  label, value, mono = false, valueClass
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-0.5 break-all ${mono ? 'font-mono text-xs' : 'text-sm'} ${valueClass ?? 'text-slate-700'}`}>
        {value}
      </p>
    </div>
  );
}

// =============================================================================
// OverrideVoteDrawer — main export
// =============================================================================

export default function OverrideVoteDrawer({
  isOpen,
  onClose,
  initialRequestId,
  currentUserId,
  // currentUserRole: kept in props type for backward compat, intentionally omitted here.
  onToast,
  onItemsCountChange
}: OverrideVoteDrawerProps) {
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [selectedItem, setSelectedItem] = useState<PendingOverrideItem | null>(null);
  const [voteDialogVote, setVoteDialogVote] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Flag để biết đã load xong lần đầu chưa — tránh auto-select khi items còn []
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // B2: Cảnh báo khi dữ liệu biểu quyết từ BE không nhất quán nội bộ
  const [consistencyWarning, setConsistencyWarning] = useState<string | null>(null);

  // I1: Thay thế manual useState/useCallback bằng TanStack Query hooks
  // [A3-fix] Truyền isOpen để tắt refetchInterval khi drawer đóng — tránh waste network
  const { data: items = [], isLoading, error, refetch } = useOverrideRequests(isOpen);
  const submitVoteMutation = useSubmitOverrideVote();

  // Sync hasLoadedOnce khi loading hoàn tất (không có error)
  // Fix: thay vì kiểm tra items.length > 0 || error, kiểm tra !isLoading
  // để handle trường hợp API trả về empty array mà không có error
  useEffect(() => {
    if (!isLoading) {
      setHasLoadedOnce(true);
    }
  }, [isLoading]);

  // [B4-fix perf] Cập nhật số lượng badge cho AdminPageClient CHỈ khi drawer mở.
  // Trước đây effect chạy liên tục cả khi drawer đóng → cascade re-render lên parent.
  const lastReportedCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isOpen) {
      // Reset cache khi drawer đóng để lần mở sau vẫn report lại
      lastReportedCountRef.current = null;
      return;
    }
    if (isLoading) return;
    if (lastReportedCountRef.current === items.length) return;
    lastReportedCountRef.current = items.length;
    onItemsCountChange?.(items.length);
  }, [items.length, isLoading, isOpen, onItemsCountChange]);

  // B2: Tính errorText từ TanStack Query error để truyền cho ListView
  const errorText = error
    ? 'Không thể tải danh sách yêu cầu ghi đè. Vui lòng thử lại.'
    : '';

  // I1: Cache pre-open focus target để restore đúng element khi đóng drawer
  const preOpenFocusRef = useRef<HTMLElement | null>(null);

  // I3: Scroll lock khi drawer mở + lưu/restore focus để focus trap hoạt động
  useEffect(() => {
    if (isOpen) {
      // Lưu element đang được focus TRƯỚC KHI drawer mở
      preOpenFocusRef.current = document.activeElement as HTMLElement | null;
      document.body.style.overflow = 'hidden';
      // Focus vào panel khi mở (panel có tabIndex={-1} để focus được programmatically)
      document.querySelector<HTMLElement>('[data-override-drawer-panel]')?.focus();
    } else {
      // Restore focus về element trước khi mở drawer
      if (preOpenFocusRef.current && typeof preOpenFocusRef.current.focus === 'function') {
        preOpenFocusRef.current.focus();
      }
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  // I1: Wrapper refetch để đồng bộ với behavior cũ của loadItems (bao gồm consistency check)
  const loadItems = useCallback(async () => {
    const result = await refetch();
    if (result.error) return;
    const loaded = result.data ?? [];

    // Đồng bộ selectedItem — reload vote list mới nhất nếu đang xem detail
    setSelectedItem((prev) => {
      if (!prev) return null;
      const refreshed = loaded.find((i) => i.overrideRequestId === prev.overrideRequestId);
      if (!refreshed) {
        setView('list');
        return null;
      }
      // B2: Kiểm tra tính nhất quán dữ liệu từ BE
      setConsistencyWarning(validateVoteConsistency(refreshed) ? null : 'Dữ liệu biểu quyết không nhất quán, vui lòng tải lại.');
      return refreshed;
    });
  }, [refetch]);

  // Load khi mở, reset khi đóng
  useEffect(() => {
    if (isOpen) {
      // Trigger TanStack Query fetch khi drawer mở
      refetch();
    } else {
      setView('list');
      setSelectedItem(null);
      setVoteDialogVote(null);
      setHasLoadedOnce(false);
      setConsistencyWarning(null);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select initialRequestId sau khi load xong lần đầu (từ socket notification)
  useEffect(() => {
    if (!isOpen || !initialRequestId || !hasLoadedOnce || isLoading) return;
    // [B4-fix #4] Polling signal — không phải real request, bỏ qua
    if (initialRequestId === OVERRIDE_POLLING_SIGNAL_ID) return;
    const target = items.find((i) => i.overrideRequestId === initialRequestId);
    if (target) {
      setSelectedItem(target);
      setView('detail');
      // B2: Validate khi auto-select từ socket
      setConsistencyWarning(validateVoteConsistency(target) ? null : 'Dữ liệu biểu quyết không nhất quán, vui lòng tải lại.');
    }
  }, [isOpen, initialRequestId, items, hasLoadedOnce, isLoading]);

  const handleOpenDetail = useCallback((item: PendingOverrideItem) => {
    setSelectedItem(item);
    setView('detail');
    setVoteDialogVote(null);
    // B2: Validate khi click vào item từ list
    setConsistencyWarning(validateVoteConsistency(item) ? null : 'Dữ liệu biểu quyết không nhất quán, vui lòng tải lại.');
  }, []);

  const handleBackToList = useCallback(() => {
    setView('list');
    setSelectedItem(null);
    setVoteDialogVote(null);
  }, []);

  const handleSubmitVote = useCallback(async (reason: string) => {
    if (!selectedItem || !voteDialogVote) return;

    setIsSubmitting(true);
    try {
      const res = await submitVoteMutation.mutateAsync({
        overrideRequestId: selectedItem.overrideRequestId,
        vote: voteDialogVote,
        reason
      });

      setVoteDialogVote(null);

      const { outcome } = res;
      if (outcome === 'VOTE_RECORDED') {
        onToast({
          titleText: 'Đã ghi nhận phiếu biểu quyết',
          bodyText: `Còn ${res.pendingVoters ?? 0} ủy viên cần biểu quyết.`,
          tone: 'success'
        });
      } else if (outcome === 'RESOLVED_APPROVED') {
        const extra = res.disbursementAutoApproved ? ' Yêu cầu giải ngân đã được tự động duyệt.' : '';
        onToast({
          titleText: 'Yêu cầu ghi đè đã được DUYỆT',
          bodyText: `Toàn bộ ủy viên đã đồng ý.${extra}`,
          tone: 'success'
        });
      } else if (outcome === 'RESOLVED_REJECTED') {
        onToast({
          titleText: 'Yêu cầu ghi đè bị TỪ CHỐI',
          bodyText: 'Tổ chức sẽ nhận được thông báo.',
          tone: 'warning'
        });
      }
    } catch (err) {
      const apiErr = err as { errorCode?: string; message?: string; statusCode?: number };
      setVoteDialogVote(null);

      if (apiErr?.statusCode === 409 && apiErr?.errorCode === 'ALREADY_VOTED') {
        onToast({ titleText: 'Bạn đã biểu quyết rồi', bodyText: 'Mỗi ủy viên chỉ được vote một lần.', tone: 'warning' });
      } else if (apiErr?.statusCode === 410) {
        onToast({
          titleText: 'Yêu cầu đã hết hiệu lực',
          bodyText: 'Danh sách ủy viên thay đổi. Một yêu cầu mới sẽ được tạo khi tổ chức re-submit.',
          tone: 'warning'
        });
      } else if (apiErr?.statusCode === 403) {
        onToast({ titleText: 'Không có quyền biểu quyết', bodyText: 'Bạn không có trong danh sách ủy viên của yêu cầu này.', tone: 'error' });
      } else {
        onToast({
          titleText: 'Biểu quyết thất bại',
          bodyText: apiErr?.message ?? 'Không thể gửi phiếu biểu quyết. Vui lòng thử lại.',
          tone: 'error'
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedItem, voteDialogVote, onToast, submitVoteMutation]);

  // Tính toán trạng thái vote cho detail view (N1: dùng useMemo tránh recalc mỗi render)
  // Phải đặt TRƯỚC early return if (!isOpen) để tuân thủ Rules of Hooks
  const voteState = useMemo(() => {
    const myVote = selectedItem?.votes.find((v) => v.commissionerId === currentUserId)?.vote ?? null;
    const totalVoters = selectedItem?.commissionerSnapshot.length ?? 0;
    const approveCount = selectedItem?.votes.filter((v) => v.vote === 'APPROVE').length ?? 0;
    const voteCount = selectedItem?.votes.length ?? 0;
    const remainingVotes = totalVoters - voteCount;
    const isFullyApproved = selectedItem?.status === 'APPROVED';
    const isRejected = selectedItem?.status === 'REJECTED';
    const isResolved = selectedItem?.status !== 'PENDING';
    return { myVote, totalVoters, approveCount, voteCount, remainingVotes, isFullyApproved, isRejected, isResolved };
  }, [selectedItem, currentUserId]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 animate-[fadeIn_200ms_ease-out] bg-slate-900/50 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — trượt từ phải với animation, giống RequestDrawer */}
      {/* [B4-fix animation] Thêm transition + transform slide-in từ translate-x-full */}
      {/* I3: Focus trap — Tab/Shift+Tab cycle trong drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Biểu quyết ghi đè GPS"
        data-override-drawer-panel
        tabIndex={-1}
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[600px] flex-col bg-white shadow-2xl transition-transform duration-300 ease-out translate-x-0"
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const panel = e.currentTarget as HTMLElement;
          const focusableSelectors = [
            'a[href]', 'button:not([disabled])', 'input:not([disabled])',
            'select:not([disabled])', 'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])'
          ].join(', ');
          const focusable = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelectors));
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            {view === 'detail' && (
              <button
                type="button"
                onClick={handleBackToList}
                aria-label="Quay lại danh sách"
                className="flex items-center justify-center rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {view === 'list' ? 'Yêu cầu Ghi đè GPS' : 'Chi tiết Biểu quyết'}
              </h2>
              {view === 'list' && !isLoading && items.length > 0 && (
                <p className="text-xs text-slate-500">{items.length} yêu cầu đang chờ</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {view === 'list' && (
              <button
                type="button"
                onClick={loadItems}
                disabled={isLoading}
                aria-label="Làm mới danh sách"
                className="flex items-center justify-center rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <svg
                  className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`}
                  fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng"
              className="flex items-center justify-center rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {view === 'list' ? (
            <ListView
              items={items}
              isLoading={isLoading}
              errorText={errorText}
              currentUserId={currentUserId}
              onOpenDetail={handleOpenDetail}
              onRetry={loadItems}
            />
          ) : selectedItem ? (
            <DetailView
              item={selectedItem}
              currentUserId={currentUserId}
              myVote={voteState.myVote}
              approveCount={voteState.approveCount}
              voteCount={voteState.voteCount}
              totalVoters={voteState.totalVoters}
              remainingVotes={voteState.remainingVotes}
              isFullyApproved={voteState.isFullyApproved}
              isRejected={voteState.isRejected}
              isResolved={voteState.isResolved}
              consistencyWarning={consistencyWarning}
              onVote={(v) => setVoteDialogVote(v)}
              onRetry={loadItems}
            />
          ) : null}
        </div>
      </div>

      {/* Vote Confirmation Dialog — z-[60] nằm trên panel */}
      {voteDialogVote && (
        <VoteConfirmationDialog
          vote={voteDialogVote}
          isSubmitting={isSubmitting}
          onConfirm={handleSubmitVote}
          onCancel={() => setVoteDialogVote(null)}
        />
      )}
    </>
  );
}
