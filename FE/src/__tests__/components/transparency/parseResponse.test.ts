/**
 * Tests cho parseResponse — D4.
 * Tập trung vào: throw khi payload không phải object / thiếu timeline,
 * fallback an toàn cho trường số thiếu/sai kiểu, và chuẩn hóa envelope hợp lệ.
 */
import { describe, it, expect } from 'vitest';
import {
  parseProjectSummary,
  parseUnifiedTimeline
} from '@/app/components/transparency/parseResponse';

describe('parseProjectSummary', () => {
  it('payload không phải object → throw lỗi chuẩn INVALID_RESPONSE', () => {
    expect(() => parseProjectSummary(null)).toThrowError();
    try {
      parseProjectSummary('bậy');
    } catch (error) {
      expect((error as { errorCode: string }).errorCode).toBe('INVALID_RESPONSE');
    }
  });

  it('trường số thiếu/sai kiểu → fallback 0, disbursedAmounts thiếu → mảng rỗng', () => {
    const result = parseProjectSummary({ projectId: 'p1' });
    expect(result.totalRaised).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.disbursedAmounts).toEqual([]);
    expect(result.excludedReorgedVnd).toBe(0);
    expect(result.excludedReorgedCount).toBe(0);
    expect(result.overDisbursed).toBe(false);
    expect(result.projectId).toBe('p1');
  });

  it('envelope hợp lệ → giữ nguyên giá trị số và cờ boolean', () => {
    const result = parseProjectSummary({
      projectId: 'p1',
      totalRaised: 1000000,
      totalDisbursed: 400000,
      remaining: 600000,
      donorCount: 12,
      transactionCount: 12,
      disbursementCount: 2,
      disbursedAmounts: [300000, 100000],
      excludedReorgedVnd: 50000,
      excludedReorgedCount: 1,
      overDisbursed: true,
      cached: true,
      fallbackMode: false
    });
    expect(result.totalRaised).toBe(1000000);
    expect(result.disbursedAmounts).toEqual([300000, 100000]);
    expect(result.cached).toBe(true);
    expect(result.excludedReorgedVnd).toBe(50000);
    expect(result.excludedReorgedCount).toBe(1);
    expect(result.overDisbursed).toBe(true);
  });

  it('NaN/Infinity trong trường số → fallback 0 (chống vỡ dasharray donut)', () => {
    const result = parseProjectSummary({ totalRaised: Number.NaN, remaining: Number.POSITIVE_INFINITY });
    expect(result.totalRaised).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

describe('parseUnifiedTimeline', () => {
  it('payload không phải object → throw', () => {
    expect(() => parseUnifiedTimeline(null)).toThrowError();
  });

  it('thiếu mảng timeline → throw (không thể flatten an toàn)', () => {
    expect(() => parseUnifiedTimeline({ nextCursor: null })).toThrowError();
  });

  it('envelope hợp lệ → giữ timeline và nextCursor', () => {
    const result = parseUnifiedTimeline({
      timeline: [{ eventId: 'e1' }],
      nextCursor: 'cursor-2',
      cached: false,
      grouped: {},
      count: 1,
      fallbackMode: false
    });
    expect(result.timeline).toHaveLength(1);
    expect(result.nextCursor).toBe('cursor-2');
  });

  it('nextCursor không phải string → chuẩn hóa về null', () => {
    const result = parseUnifiedTimeline({ timeline: [], nextCursor: 123 });
    expect(result.nextCursor).toBeNull();
  });

  it('grouped sai kiểu → fallback object rỗng', () => {
    const result = parseUnifiedTimeline({ timeline: [], grouped: 'bậy' });
    expect(result.grouped).toEqual({});
  });
});
