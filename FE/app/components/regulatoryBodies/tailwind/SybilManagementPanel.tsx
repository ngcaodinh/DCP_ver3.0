'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatVietnameseDateTime,
  formatVndAmount,
  getRiskScoreBarClass,
  getShortWalletAddress,
  getSybilRiskLevelClass,
  getSybilStatusClass,
} from './helpers';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '../../../utils/authSession';
import type { SybilRiskLevel, SybilUser } from './types';

/** Kiểu response từ API lấy danh sách Sybil users. */
type SybilUserListApiResponse = {
  users: SybilUser[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
};

/** Kiểu response metrics tổng hợp. */
type SybilSummaryMetricsApiResponse = {
  totalMarkedCount: number;
  pendingReviewCount: number;
  totalAffectedDonations: number;
  totalAffectedAmount: number;
};

/** Props của SybilManagementPanel — component quản lý Sybil Attack (FR5/UC5.1). */
type SybilManagementPanelProps = {
  onPushToast?: (message: string, type?: 'success' | 'error' | 'warning') => void;
};

// =============================================================================
// TOAST NOTIFICATION
// =============================================================================

type ToastItem = { id: string; message: string; type: 'success' | 'error' | 'warning' };

/** Hàm hiển thị một notification toast nhỏ gọn bên dưới cùng màn hình. */
function ToastNotification({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      className="fixed bottom-5 right-5 z-50 flex flex-col gap-2"
      role="region"
      aria-label="Thông báo"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`min-w-72 rounded-lg border px-4 py-3 text-sm font-medium shadow-md ${toast.type === 'success'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
            : toast.type === 'error'
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-amber-300 bg-amber-50 text-amber-800'
            }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// DETAIL MODAL
// =============================================================================

/** Props cho modal chi tiết người dùng Sybil. */
type DetailModalProps = {
  user: SybilUser;
  onClose: () => void;
  onMarkSybil: (user: SybilUser) => void;
};

/** Modal hiển thị chi tiết người dùng: thông tin, yếu tố rủi ro, lịch sử donation. */
function DetailModal({ user, onClose, onMarkSybil }: DetailModalProps) {
  const statusInfo = getSybilStatusClass(user.isSybil);
  const riskLevelClass = getSybilRiskLevelClass(user.riskLevel);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-emerald-900/15 bg-white shadow-xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-emerald-900/15 bg-white px-5 py-4">
          <div>
            <h2 id="detail-modal-title" className="text-base font-bold text-slate-900">
              Chi tiết người dùng
            </h2>
            <p className="mt-0.5 font-mono text-xs text-slate-500">{user.walletAddress}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex rounded-md border px-2.5 py-1 text-xs font-semibold ${statusInfo.badgeClass}`}>
              {statusInfo.label}
            </span>
            <span className={`inline-flex rounded-md border px-2.5 py-1 text-xs font-semibold ${riskLevelClass}`}>
              {user.riskLevel === 'critical' ? 'Nguy cơ cao' : user.riskLevel === 'high' ? 'Cao' : user.riskLevel === 'medium' ? 'Trung bình' : 'Thấp'}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="ml-2 rounded-lg border border-slate-200 p-1.5 text-slate-500 transition hover:bg-slate-100"
              aria-label="Đóng modal chi tiết"
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {/* Thông tin tổng quát */}
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Thông tin người dùng</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-[10px] text-slate-400">Tên hiển thị</p>
                <p className="text-sm font-semibold text-slate-900">{user.displayName}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Email</p>
                <p className="text-sm text-slate-700">{user.email}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Vai trò</p>
                <p className="text-sm text-slate-700">{user.role}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Tổng donation</p>
                <p className="text-sm font-semibold text-slate-900">{user.donationCount} lần</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Tổng giá trị</p>
                <p className="text-sm font-semibold text-slate-900">{formatVndAmount(user.totalDonationAmount)}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Địa chỉ IP</p>
                <p className="text-sm font-mono text-slate-700">{user.ipAddresses.join(', ')}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Device Fingerprint</p>
                <p className="text-xs font-mono text-slate-600">{user.deviceFingerprint ?? 'Không có'}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Hoạt động đầu tiên</p>
                <p className="text-xs text-slate-700">{formatVietnameseDateTime(user.firstActivity)}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-400">Hoạt động cuối</p>
                <p className="text-xs text-slate-700">{formatVietnameseDateTime(user.lastActivity)}</p>
              </div>
            </div>
            {user.reviewedAt && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-xs font-semibold text-emerald-700">📋 Đã xem xét: {user.reviewedBy}</p>
                <p className="text-xs text-emerald-600">{formatVietnameseDateTime(user.reviewedAt)}</p>
                {user.reviewNote && <p className="mt-1 text-xs italic text-emerald-700">{user.reviewNote}</p>}
              </div>
            )}
          </div>

          {/* Điểm rủi ro */}
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
              Điểm rủi ro (tổng: <span className="text-red-600">{user.totalRiskScore}</span>)
            </h3>
            <div className="space-y-2.5">
              {user.riskFactors.map((factor) => {
                const percentage = (factor.score / factor.maxScore) * 100;
                return (
                  <div key={factor.factorKey} className="grid grid-cols-[140px_1fr_50px] items-center gap-2 text-xs">
                    <span className="text-slate-700">{factor.factorName}</span>
                    <div className="h-2 rounded-full bg-slate-200">
                      <div
                        className={`h-2 rounded-full ${getRiskScoreBarClass(factor.score)}`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <span className="text-right font-semibold text-slate-800">{factor.score}/{factor.maxScore}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Lịch sử donation — chỉ hiển thị khi có dữ liệu (từ detail endpoint) */}
          {user.donationHistory && user.donationHistory.length > 0 && (
            <div>
              <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
                Lịch sử Donation ({user.donationHistory.length} giao dịch)
              </h3>
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
                    <tr>
                      <th className="px-3 py-2.5 font-semibold">Dự án</th>
                      <th className="px-3 py-2.5 font-semibold">Số tiền</th>
                      <th className="px-3 py-2.5 font-semibold">Thời gian</th>
                      <th className="px-3 py-2.5 font-semibold">TX Hash</th>
                      <th className="px-3 py-2.5 font-semibold">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.donationHistory.map((donation, idx) => (
                      <tr key={donation.donationId} className={`border-t border-slate-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}`}>
                        <td className="px-3 py-2 text-slate-700">{donation.projectName}</td>
                        <td className="px-3 py-2 font-semibold text-slate-900">{formatVndAmount(donation.amount)}</td>
                        <td className="px-3 py-2 text-slate-600">{formatVietnameseDateTime(donation.timestamp)}</td>
                        <td className="px-3 py-2 font-mono text-cyan-600">{getShortWalletAddress(donation.txHash)}</td>
                        <td className="px-3 py-2 font-mono text-slate-600">{donation.ipAddress}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-emerald-900/15 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={() => onMarkSybil(user)}
              className={`rounded-lg px-4 py-2 text-xs font-bold text-white transition ${user.isSybil
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-red-600 hover:bg-red-700'
                }`}
            >
              {user.isSybil ? '↩ Bỏ đánh dấu Sybil' : '🚫 Đánh dấu Sybil'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// CONFIRMATION MODAL
// =============================================================================

type ConfirmModalProps = {
  user: SybilUser;
  reason: string;
  isSubmitting: boolean;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Modal xác nhận đánh dấu / bỏ đánh dấu Sybil, yêu cầu nhập lý do. */
function ConfirmModal({ user, reason, isSubmitting, onReasonChange, onConfirm, onCancel }: ConfirmModalProps) {

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="w-full max-w-md rounded-xl border border-emerald-900/15 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${user.isSybil ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'
            }`}>
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              {user.isSybil
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />}
            </svg>
          </div>
          <div>
            <h3 id="confirm-modal-title" className="text-sm font-bold text-slate-900">
              {user.isSybil ? 'Bỏ đánh dấu Sybil?' : 'Xác nhận đánh dấu Sybil?'}
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              {user.isSybil
                ? `Bỏ đánh dấu ví ${getShortWalletAddress(user.walletAddress)} khỏi danh sách Sybil. Họ sẽ được tính vào QF bình thường.`
                : `Đánh dấu ví ${getShortWalletAddress(user.walletAddress)} là Sybil. Ví sẽ bị loại khỏi tính toán QF.`}
            </p>
          </div>
        </div>

        <div className="mb-4">
          <label htmlFor="sybil-reason" className="mb-1.5 block text-xs font-semibold text-slate-700">
            Lý do <span className="text-red-500">*</span>
          </label>
          <textarea
            id="sybil-reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Nhập lý do thay đổi trạng thái Sybil..."
            rows={3}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:border-[#1AAE97] focus:outline-none focus:ring-1 focus:ring-[#1AAE97]/30"
            aria-required="true"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={() => onConfirm()}
            disabled={isSubmitting || reason.trim().length < 5}
            className={`rounded-lg px-4 py-2 text-xs font-bold text-white disabled:opacity-50 ${user.isSybil ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
              }`}
          >
            {isSubmitting ? 'Đang xử lý...' : user.isSybil ? 'Xác nhận bỏ đánh dấu' : 'Xác nhận đánh dấu'}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

/** Component chính quản lý Sybil Attack — FR5 (Sybil Detection & Prevention). */
export default function SybilManagementPanel({ onPushToast }: SybilManagementPanelProps) {
  // States
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [sybilUserList, setSybilUserList] = useState<SybilUser[]>([]);
  const [metrics, setMetrics] = useState<SybilSummaryMetricsApiResponse>({
    totalMarkedCount: 0,
    pendingReviewCount: 0,
    totalAffectedDonations: 0,
    totalAffectedAmount: 0
  });

  // Pagination state — lưu trữ thông tin trang từ API response
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [pageSize, setPageSize] = useState(10); // Số bản ghi mỗi trang (5/10/20/50)

  // Search & filter
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRiskLevel, setFilterRiskLevel] = useState<SybilRiskLevel | 'all'>('all');
  const [filterSybilStatus, setFilterSybilStatus] = useState<'all' | 'sybil' | 'normal'>('all');

  // Detail modal
  const [selectedUser, setSelectedUser] = useState<SybilUser | null>(null);

  // Confirm modal
  const [confirmTarget, setConfirmTarget] = useState<SybilUser | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Toast
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  /** Hàm thêm toast notification. */
  const pushToast = useCallback((message: string, type: 'success' | 'error' | 'warning' = 'success') => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
    onPushToast?.(message, type);
  }, [onPushToast]);

  /** Hàm load dữ liệu từ API thật — bao gồm query params page/limit. */
  const loadData = useCallback(async (page = currentPage) => {
    setIsLoading(true);
    setHasError(false);
    try {
      // Đọc accessToken từ session để gửi kèm request (chuẩn OWASP A01: Access Control)
      const authSession = readAuthSession();
      const authHeaders = { Authorization: `Bearer ${authSession.accessToken}` };

      // Build URL với query params phân trang (buildApiUrl chỉ nhận pathname)
      const apiUrl = buildApiUrl('/api/sybil/users');
      const paginationUrl = `${apiUrl}?page=${page}&limit=${pageSize}`;
      const [userListResponse, metricsResponse] = await Promise.all([
        fetchApi<SybilUserListApiResponse>(paginationUrl, { headers: authHeaders }),
        fetchApi<SybilSummaryMetricsApiResponse>(buildApiUrl('/api/sybil/summary-metrics'), { headers: authHeaders })
      ]);
      setSybilUserList(userListResponse.data.users);
      // Cập nhật pagination state từ response
      setCurrentPage(userListResponse.data.pageNumber);
      setTotalPages(userListResponse.data.totalPages);
      setMetrics(metricsResponse.data);
    } catch {
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  }, [currentPage, pageSize]);

  useEffect(() => { loadData(); }, [loadData]);

  // =============================================================================
  // AUTO SYBIL DETECTION
  // =============================================================================

  /** Kiểm tra điều kiện Time Pattern — các ví donate cùng lúc (±5 giây).
   *  Trả về Set chứa walletAddress của các ví liên quan.
   *  So sánh timestamp trong donationHistory (chi tiết) hoặc lastActivity (thô).
   */
  const detectTimePattern = useCallback((users: SybilUser[]): Set<string> => {
    const TIME_THRESHOLD_MS = 5000; // ±5 giây
    const affectedWallets = new Set<string>();

    // Bước 1: Thu thập tất cả timestamp donation từ mọi ví
    // Mỗi entry: { walletAddress, timestamp }
    const allDonationTimestamps: { walletAddress: string; timestamp: number }[] = [];

    for (const user of users) {
      // Ưu tiên lấy từ donationHistory nếu có (chi tiết hơn)
      if (user.donationHistory && user.donationHistory.length > 0) {
        for (const donation of user.donationHistory) {
          allDonationTimestamps.push({
            walletAddress: user.walletAddress,
            timestamp: new Date(donation.timestamp).getTime()
          });
        }
      } else if (user.lastActivity) {
        // Fallback: dùng lastActivity
        allDonationTimestamps.push({
          walletAddress: user.walletAddress,
          timestamp: new Date(user.lastActivity).getTime()
        });
      }
    }

    // Bước 2: Với mỗi timestamp, tìm các ví khác donate trong vòng ±5 giây
    for (let i = 0; i < allDonationTimestamps.length; i++) {
      const current = allDonationTimestamps[i];
      for (let j = i + 1; j < allDonationTimestamps.length; j++) {
        const other = allDonationTimestamps[j];
        // Bỏ qua nếu cùng một ví
        if (current.walletAddress === other.walletAddress) continue;

        // Kiểm tra chênh lệch thời gian
        const diff = Math.abs(current.timestamp - other.timestamp);
        if (diff <= TIME_THRESHOLD_MS) {
          // Tìm thấy 2 ví khác nhau donate cùng lúc → cả 2 đều bị ảnh hưởng
          affectedWallets.add(current.walletAddress);
          affectedWallets.add(other.walletAddress);
        }
      }
    }

    return affectedWallets;
  }, []);

  /** Kiểm tra điều kiện điểm rủi ro tối đa — ví có totalRiskScore === 100.
   *  Trả về Set chứa walletAddress của các ví thỏa điều kiện.
   */
  const detectMaxRiskScore = useCallback((users: SybilUser[]): Set<string> => {
    const affectedWallets = new Set<string>();
    for (const user of users) {
      if (user.totalRiskScore === 100 && !user.isSybil) {
        affectedWallets.add(user.walletAddress);
      }
    }
    return affectedWallets;
  }, []);

  /** Lấy danh sách user cần auto-mark từ 2 điều kiện, loại trừ ví đã được đánh dấu. */
  const getAutoMarkTargets = useCallback((users: SybilUser[]): SybilUser[] => {
    const timePatternWallets = detectTimePattern(users);
    const maxRiskWallets = detectMaxRiskScore(users);

    // Merge 2 Set — tất cả ví thỏa điều kiện
    const allTargetWallets = new Set<string>([...timePatternWallets, ...maxRiskWallets]);

    // Chỉ giữ lại những ví chưa được đánh dấu Sybil
    return users.filter((u) => allTargetWallets.has(u.walletAddress) && !u.isSybil);
  }, [detectTimePattern, detectMaxRiskScore]);

  /** Hàm gọi API đánh dấu Sybil cho một ví (dùng bởi auto-mark).
   *  Tự động điền reason/reviewedBy, không cần user confirm.
   */
  const autoMarkSybil = useCallback(async (user: SybilUser) => {
    try {
      const authSession = readAuthSession();
      const authHeaders = { Authorization: `Bearer ${authSession.accessToken}` };
      const apiUrl = buildApiUrl('/api/sybil/toggle');

      await fetchApi<{ success: boolean; message: string }>(apiUrl, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          userId: user.userId,
          walletAddress: user.walletAddress,
          action: 'mark',
          reason: 'Tự động chặn do nguy cơ tìm ẩn cao',
          reviewedBy: 'Hệ thống tự động'
        })
      });

      // Log hành động tự động để debug
      console.log(
        `[Sybil Auto-Mark] Đã đánh dấu tự động: ${user.walletAddress} | ` +
        `Risk Score: ${user.totalRiskScore} | Reason: Tự động chặn do nguy cơ tìm ẩn cao`
      );

      return true;
    } catch (err) {
      console.error(`[Sybil Auto-Mark] Lỗi khi đánh dấu ${user.walletAddress}:`, err);
      return false;
    }
  }, []);

  /** Effect chạy sau khi danh sách người dùng được load/cập nhật.
   *  Kiểm tra điều kiện tự động đánh dấu và batch các lời gọi API.
   */
  useEffect(() => {
    // Chỉ chạy khi đã load xong và không có lỗi, và có dữ liệu
    if (isLoading || hasError || sybilUserList.length === 0) return;

    const targets = getAutoMarkTargets(sybilUserList);
    if (targets.length === 0) return;

    // Log tổng quan
    console.log(`[Sybil Auto-Mark] Phát hiện ${targets.length} ví cần đánh dấu tự động:`);
    targets.forEach((u) => console.log(`  → ${u.walletAddress} (score: ${u.totalRiskScore})`));

    // Batch: gọi API song song cho tất cả các ví (Promise.allSettled để không dừng khi 1 cái lỗi)
    Promise.allSettled(targets.map((user) => autoMarkSybil(user))).then((results) => {
      // Sau khi API hoàn tất → cập nhật local state cho những ví thành công
      const successfulWallets = results
        .map((r, idx) => ({ success: r.status === 'fulfilled' && r.value === true, wallet: targets[idx].walletAddress }))
        .filter((r) => r.success)
        .map((r) => r.wallet);

      if (successfulWallets.length > 0) {
        const now = new Date().toISOString();
        setSybilUserList((prev) =>
          prev.map((u) =>
            successfulWallets.includes(u.walletAddress)
              ? { ...u, isSybil: true, reviewedAt: now, reviewedBy: 'Hệ thống tự động', reviewNote: 'Tự động chặn do nguy cơ tìm ẩn cao' }
              : u
          )
        );
        pushToast(`Đã tự động đánh dấu ${successfulWallets.length} ví Sybil nghi ngờ.`, 'warning');
      }
    });
  }, [sybilUserList, isLoading, hasError, getAutoMarkTargets, autoMarkSybil, pushToast]);

  /** Lọc danh sách theo search query, risk level và sybil status. */
  const filteredList = useMemo(() => {
    return sybilUserList.filter((user) => {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        !searchQuery ||
        user.walletAddress.toLowerCase().includes(query) ||
        user.displayName.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query) ||
        user.userId.toLowerCase().includes(query);
      const matchesRisk = filterRiskLevel === 'all' || user.riskLevel === filterRiskLevel;
      const matchesStatus =
        filterSybilStatus === 'all' ||
        (filterSybilStatus === 'sybil' && user.isSybil) ||
        (filterSybilStatus === 'normal' && !user.isSybil);
      return matchesSearch && matchesRisk && matchesStatus;
    });
  }, [sybilUserList, searchQuery, filterRiskLevel, filterSybilStatus]);

  /** Hàm mở modal chi tiết người dùng. */
  const handleViewDetail = useCallback((user: SybilUser) => {
    setSelectedUser(user);
  }, []);

  /** Hàm đóng modal chi tiết. */
  const handleCloseDetail = useCallback(() => {
    setSelectedUser(null);
  }, []);

  /** Hàm mở modal xác nhận toggle Sybil. */
  const handleMarkSybil = useCallback((user: SybilUser) => {
    setSelectedUser(null);
    setConfirmReason('');
    setConfirmTarget(user);
  }, []);

  /** Hàm xử lý submit toggle Sybil — gọi API thật. */
  const handleConfirmToggle = useCallback(async () => {
    if (!confirmTarget) return;
    setIsSubmitting(true);
    try {
      // Đọc accessToken từ session để gửi kèm request (chuẩn OWASP A01: Access Control)
      const authSession = readAuthSession();
      const authHeaders = { Authorization: `Bearer ${authSession.accessToken}` };

      const action = confirmTarget.isSybil ? 'unmark' : 'mark';
      const apiUrl = buildApiUrl('/api/sybil/toggle');
      const response = await fetchApi<{ success: boolean; message: string }>(apiUrl, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          userId: confirmTarget.userId,
          walletAddress: confirmTarget.walletAddress,
          action,
          reason: confirmReason
        })
      });
      setSybilUserList((prev) =>
        prev.map((u) =>
          u.userId === confirmTarget.userId
            ? { ...u, isSybil: !u.isSybil, reviewedAt: new Date().toISOString(), reviewedBy: response.data.message }
            : u
        )
      );
      setConfirmTarget(null);
      setConfirmReason('');
      pushToast(response.data.message, 'success');
    } catch {
      pushToast('Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  }, [confirmTarget, confirmReason, pushToast]);

  /** Hàm reset filters. */
  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setFilterRiskLevel('all');
    setFilterSybilStatus('all');
  }, []);

  const hasActiveFilters = searchQuery !== '' || filterRiskLevel !== 'all' || filterSybilStatus !== 'all';

  // ===== PAGINATION HANDLERS =====
  /** Chuyển sang trang trước — disable khi đang ở trang 1. */
  const handlePreviousPage = useCallback(() => {
    if (currentPage <= 1) return;
    loadData(currentPage - 1);
  }, [currentPage, loadData]);

  /** Chuyển sang trang sau — disable khi đang ở trang cuối. */
  const handleNextPage = useCallback(() => {
    if (currentPage >= totalPages) return;
    loadData(currentPage + 1);
  }, [currentPage, totalPages, loadData]);

  /** Nhảy đến trang cụ thể. */
  const handleGoToPage = useCallback((page: number) => {
    if (page < 1 || page > totalPages || page === currentPage) return;
    loadData(page);
  }, [currentPage, totalPages, loadData]);

  /** Thay đổi số bản ghi mỗi trang — reset về trang 1 và fetch lại. */
  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setCurrentPage(1); // Reset về trang 1 khi thay đổi page size
    loadData(1);
  }, [loadData]);

  return (
    <div className="space-y-4">
      {/* ===== HEADER ===== */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Quản lý Sybil Attack</h2>
          <p className="mt-1 text-xs text-slate-500">Phát hiện và đánh dấu các ví Sybil ảnh hưởng đến tính công bằng của QF</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700">
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
            {sybilUserList.filter((u) => u.isSybil).length} đã đánh dấu
          </span>
        </div>
      </div>

      {/* ===== SEARCH & FILTER BAR ===== */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-900/15 bg-white px-5 py-3">
        <div className="relative flex-1 min-w-48">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm ví, tên, email, user ID..."
            className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-700 placeholder-slate-400 focus:border-[#1AAE97] focus:outline-none focus:ring-1 focus:ring-[#1AAE97]/30"
            aria-label="Tìm kiếm người dùng"
          />
        </div>
        <select
          value={filterRiskLevel}
          onChange={(e) => setFilterRiskLevel(e.target.value as SybilRiskLevel | 'all')}
          className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 focus:border-[#1AAE97] focus:outline-none"
          aria-label="Lọc theo mức rủi ro"
        >
          <option value="all">Tất cả mức rủi ro</option>
          <option value="critical">🔴 Nguy cơ cao</option>
          <option value="high">🟠 Cao</option>
          <option value="medium">🟡 Trung bình</option>
          <option value="low">🟢 Thấp</option>
        </select>
        <select
          value={filterSybilStatus}
          onChange={(e) => setFilterSybilStatus(e.target.value as 'all' | 'sybil' | 'normal')}
          className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-700 focus:border-[#1AAE97] focus:outline-none"
          aria-label="Lọc theo trạng thái Sybil"
        >
          <option value="all">Tất cả trạng thái</option>
          <option value="sybil">🚫 Đã đánh dấu Sybil</option>
          <option value="normal">✅ Bình thường</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleResetFilters}
            className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
          >
            ↺ Đặt lại
          </button>
        )}
      </div>

      {/* ===== SUMMARY METRICS ===== */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-emerald-900/15 bg-white p-4">
          <p className="text-2xl font-bold text-slate-900">{metrics.totalMarkedCount}</p>
          <span className="mt-1 inline-flex rounded-md border border-red-100 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700">
            Tổng người dùng bị đánh dấu
          </span>
        </div>
        <div className="rounded-xl border border-emerald-900/15 bg-white p-4">
          <p className="text-2xl font-bold text-slate-900">{metrics.pendingReviewCount}</p>
          <span className="mt-1 inline-flex rounded-md border border-amber-100 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
            Đang chờ xem xét
          </span>
        </div>
        <div className="rounded-xl border border-emerald-900/15 bg-white p-4">
          <p className="text-2xl font-bold text-slate-900">{metrics.totalAffectedDonations}</p>
          <span className="mt-1 inline-flex rounded-md border border-cyan-100 bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-700">
            Tổng quyên góp bị ảnh hưởng
          </span>
        </div>
        <div className="rounded-xl border border-emerald-900/15 bg-white p-4">
          <p className="text-2xl font-bold text-slate-900">{formatVndAmount(metrics.totalAffectedAmount)}</p>
          <span className="mt-1 inline-flex rounded-md border border-slate-100 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">
            Tổng giá trị (VNĐ)
          </span>
        </div>
      </div>

      {/* ===== DATA TABLE ===== */}
      <div className="overflow-hidden rounded-xl border border-emerald-900/15 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left" aria-label="Danh sách người dùng nghi ngờ Sybil">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.08em] text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-semibold">Địa chỉ ví</th>
                <th className="px-5 py-2.5 font-semibold">Điểm rủi ro</th>
                <th className="px-5 py-2.5 font-semibold">Mức rủi ro</th>
                <th className="px-5 py-2.5 font-semibold">Trạng thái</th>
                <th className="px-5 py-2.5 font-semibold">Tổng donation</th>
                <th className="px-5 py-2.5 font-semibold">Tổng giá trị</th>
                <th className="px-5 py-2.5 font-semibold">Hành động</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                // Loading skeleton rows
                Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={`skel-${idx}`} className="border-t border-slate-100">
                    <td className="px-5 py-4"><div className="h-4 w-36 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-5 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-5 py-4"><div className="h-5 w-20 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-5 py-4"><div className="h-5 w-16 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-5 py-4"><div className="h-4 w-12 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-5 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
                    <td className="px-5 py-4"><div className="h-7 w-20 animate-pulse rounded bg-slate-200" /></td>
                  </tr>
                ))
              ) : hasError ? (
                // Error state
                <tr>
                  <td colSpan={7} className="px-5 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <svg className="text-red-400" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                      <p className="text-sm font-semibold text-red-700">Không thể tải dữ liệu</p>
                      <p className="text-xs text-slate-500">Đã xảy ra lỗi khi tải danh sách người dùng. Vui lòng thử lại.</p>
                      <button
                        type="button"
                        onClick={() => loadData()}
                        className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-700"
                      >
                        Thử lại
                      </button>
                    </div>
                  </td>
                </tr>
              ) : filteredList.length === 0 ? (
                // Empty state
                <tr>
                  <td colSpan={7} className="px-5 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <svg className="text-slate-300" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>
                      <p className="text-sm font-semibold text-slate-700">Không tìm thấy người dùng nào</p>
                      <p className="text-xs text-slate-500">
                        {hasActiveFilters ? 'Không có kết quả phù hợp với bộ lọc hiện tại.' : 'Chưa có người dùng nào trong hệ thống.'}
                      </p>
                      {hasActiveFilters && (
                        <button
                          type="button"
                          onClick={handleResetFilters}
                          className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
                        >
                          Đặt lại bộ lọc
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                // Data rows
                filteredList.map((user, idx) => {
                  const statusInfo = getSybilStatusClass(user.isSybil);
                  const riskLevelClass = getSybilRiskLevelClass(user.riskLevel);
                  return (
                    <tr
                      key={user.userId}
                      className={`border-t border-slate-100 text-sm transition ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'} hover:bg-slate-50`}
                    >
                      <td className="px-5 py-3">
                        <div className="max-w-44">
                          <p className="truncate font-mono text-xs font-semibold text-slate-900">{user.walletAddress}</p>
                          <p className="text-[10px] text-slate-400">{user.displayName}</p>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 rounded-full bg-slate-100">
                            <div
                              className={`h-1.5 rounded-full ${getRiskScoreBarClass(user.totalRiskScore)}`}
                              style={{ width: `${Math.min((user.totalRiskScore / 100) * 100, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold text-slate-700">{user.totalRiskScore}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold ${riskLevelClass}`}>
                          {user.riskLevel === 'critical' ? 'Nguy cơ cao' : user.riskLevel === 'high' ? 'Cao' : user.riskLevel === 'medium' ? 'Trung bình' : 'Thấp'}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex rounded-md border px-2.5 py-1 text-[11px] font-semibold ${statusInfo.badgeClass}`}>
                          {statusInfo.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-700">{user.donationCount}</td>
                      <td className="px-5 py-3 font-semibold text-xs text-slate-900">{formatVndAmount(user.totalDonationAmount)}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleViewDetail(user)}
                            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-[#0E7C6B] hover:text-white hover:border-[#0E7C6B]"
                            aria-label={`Xem chi tiết ${user.displayName}`}
                          >
                            Chi tiết
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMarkSybil(user)}
                            className={`rounded-md px-2.5 py-1.5 text-[11px] font-bold text-white transition ${user.isSybil
                              ? 'bg-emerald-600 hover:bg-emerald-700'
                              : 'bg-red-600 hover:bg-red-700'
                              }`}
                            aria-label={user.isSybil ? `Bỏ đánh dấu Sybil cho ${user.displayName}` : `Đánh dấu Sybil cho ${user.displayName}`}
                          >
                            {user.isSybil ? '↩ Bỏ đánh dấu' : '🚫 Đánh dấu'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {!isLoading && !hasError && filteredList.length > 0 && (
          <div className="flex items-center justify-between border-t border-emerald-900/15 bg-slate-50 px-5 py-3">
            {/* Bộ chọn số bản ghi mỗi trang */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Hiển thị</span>
              <select
                value={pageSize}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:border-[#1AAE97] focus:outline-none"
                aria-label="Số bản ghi mỗi trang"
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
              <span className="text-xs text-slate-500">bản ghi / trang</span>
            </div>
            <div className="flex items-center gap-1">
              {/* Nút Previous — disable khi đang ở trang 1 */}
              <button
                type="button"
                onClick={() => handlePreviousPage()}
                disabled={currentPage <= 1}
                className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Trang trước"
              >
                ‹
              </button>

              {/* Danh sách số trang */}
              {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((page) => (
                <button
                  key={page}
                  type="button"
                  onClick={() => handleGoToPage(page)}
                  className={`h-7 min-w-7 rounded-md border text-xs font-medium transition ${page === currentPage
                    ? 'border-[#0F2040] bg-[#0F2040] text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'
                    }`}
                  aria-label={`Trang ${page}`}
                  aria-current={page === currentPage ? 'page' : undefined}
                >
                  {page}
                </button>
              ))}

              {/* Nút Next — disable khi đang ở trang cuối */}
              <button
                type="button"
                onClick={() => handleNextPage()}
                disabled={currentPage >= totalPages}
                className="h-7 w-7 rounded-md border border-slate-200 bg-white text-xs text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Trang sau"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===== DETAIL MODAL ===== */}
      {selectedUser && (
        <DetailModal
          user={selectedUser}
          onClose={handleCloseDetail}
          onMarkSybil={handleMarkSybil}
        />
      )}

      {/* ===== CONFIRM MODAL ===== */}
      {confirmTarget && (
        <ConfirmModal
          user={confirmTarget}
          reason={confirmReason}
          isSubmitting={isSubmitting}
          onReasonChange={setConfirmReason}
          onConfirm={handleConfirmToggle}
          onCancel={() => { setConfirmTarget(null); setConfirmReason(''); }}
        />
      )}

      {/* ===== TOAST ===== */}
      {toasts.length > 0 && <ToastNotification toasts={toasts} />}
    </div>
  );
}
