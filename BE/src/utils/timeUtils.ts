// Ghi chú: Chuyển đổi chuỗi thời lượng sang mili giây theo chuẩn JWT.
export function parseDurationToMilliseconds(duration: string, fallbackMilliseconds: number): number {
  const normalizedValue = duration.trim();
  const durationMatch = normalizedValue.match(/^([0-9]+)(ms|s|m|h|d)$/i);

  if (!durationMatch) {
    return fallbackMilliseconds;
  }

  const value = Number(durationMatch[1]);
  const unit = durationMatch[2].toLowerCase();

  if (Number.isNaN(value) || value <= 0) {
    return fallbackMilliseconds;
  }

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };

  return value * (multipliers[unit] ?? 1);
}

