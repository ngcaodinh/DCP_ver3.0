'use client';

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactElement } from 'react';
import { TIER_STYLE_MAP, TRUST_FACTOR_WEIGHT_ROWS, TRUST_SOURCE_EXPLANATIONS } from '@/app/constants/fairRanking';
import type { FairRankingTier, FairRankingTrustSource } from '@/app/types/fairRanking';

interface TrustScoreBadgeProps {
  trustScore: number;
  tier: FairRankingTier;
  trustSource: FairRankingTrustSource;
}

/** Định dạng trust score gọn, giữ số 0.3/0.5 dễ đọc trong badge và tooltip. */
function formatTrustScore(trustScore: number): string {
  return trustScore.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Lấy style trung tính cho score fallback hoặc ví chưa xác minh. */
function getBadgeStyle(tier: FairRankingTier, trustSource: FairRankingTrustSource): string {
  if (trustSource !== 'computed') {
    return 'border-slate-300 bg-slate-50 text-slate-600 border-dashed';
  }
  return TIER_STYLE_MAP[tier];
}

/** Badge trust có tooltip trọng số, hỗ trợ hover, focus, click và Escape. */
export function TrustScoreBadge({ trustScore, tier, trustSource }: TrustScoreBadgeProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const badgeContainerRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const explanation = TRUST_SOURCE_EXPLANATIONS[trustSource];
  const scoreLabel = formatTrustScore(trustScore);

  /** Đóng tooltip khi người dùng nhấn chuột bên ngoài badge trên thiết bị cảm ứng. */
  useEffect(() => {
    const handleDocumentMouseDown = (event: MouseEvent): void => {
      if (event.target instanceof Node && !badgeContainerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, []);

  /** Mở tooltip khi badge nhận focus từ bàn phím. */
  const handleFocus = (): void => setIsOpen(true);

  /** Đóng tooltip khi focus rời badge để không giữ panel cũ trên màn hình. */
  const handleBlur = (event: FocusEvent<HTMLButtonElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsOpen(false);
    }
  };

  /** Đóng tooltip và trả focus về badge khi người dùng nhấn Escape. */
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsOpen(false);
    }
  };

  /** Mở tooltip khi badge được chạm hoặc click; việc đóng do đường focus/hover xử lý riêng. */
  const handleClick = (): void => setIsOpen(true);

  return (
    <span
      ref={badgeContainerRef}
      className="relative inline-flex"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        type="button"
        className={`rounded-full border px-2 py-1 text-xs font-semibold transition-colors ${getBadgeStyle(tier, trustSource)}`}
        aria-label={`Trust score ${scoreLabel}, tier ${tier}`}
        aria-describedby={isOpen ? tooltipId : undefined}
        onClick={handleClick}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {tier} · {scoreLabel}
      </button>
      {isOpen && (
        <div
          id={tooltipId}
          role="tooltip"
          className="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-slate-200 bg-white p-3 text-left text-xs text-slate-700 shadow-lg"
        >
          <p className="mb-2 font-semibold text-slate-900">Điểm tin cậy được tính từ 5 yếu tố:</p>
          <dl className="space-y-1">
            {TRUST_FACTOR_WEIGHT_ROWS.map(row => (
              <div className="flex justify-between gap-3" key={row.key}>
                <dt>{row.label}</dt>
                <dd className="font-semibold">{row.percentage}%</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-slate-100 pt-2">
            Điểm của nhà hảo tâm này: <strong>{scoreLabel} ({tier})</strong>
          </p>
          {explanation && <p className="mt-2 text-slate-500">{explanation}</p>}
        </div>
      )}
    </span>
  );
}

export default TrustScoreBadge;
