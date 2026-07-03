/**
 * Service spam detection cơ bản cho feedback beneficiary.
 * Sử dụng heuristics đơn giản để detect spam patterns.
 * F2 sẽ mở rộng với ML model và API tích hợp.
 */

/**
 * Ngưỡng auto-flag cho risk score.
 * Rows có riskScore >= threshold sẽ được tự động flag.
 */
export const RISK_SCORE_AUTO_FLAG_THRESHOLD = 7;

/**
 * Điểm penalty cho rating 1 hoặc 5 (extreme ratings).
 */
const EXTREME_RATING_PENALTY = 2;

/**
 * Điểm penalty cho từ lặp lại nhiều lần trong comment.
 */
const REPEATED_WORD_PENALTY = 1;

/**
 * Số lần tối đa cho phép một từ xuất hiện trước khi bị coi là spam.
 */
const REPEATED_WORD_THRESHOLD = 3;

/**
 * Điểm penalty cho comment chứa gibberish (ký tự ngẫu nhiên).
 */
const GIBBERISH_PENALTY = 3;

/**
 * Regex pattern cho gibberish detection - ký tự ngẫu nhiên liên tiếp.
 * Phát hiện các chuỗi ký tự không có nghĩa như "asdf1234" hoặc "zzzxxxccc".
 */
const GIBBERISH_PATTERN = /(.)\1{4,}/;

/**
 * Regex pattern cho gibberish dạng keyboard mashing.
 */
const KEYBOARD_MASH_PATTERN = /^[a-z]{5,}$/i;

/**
 * Điểm penalty cho location mismatch (feedback location không khớp với project geofence).
 */
export const LOCATION_MISMATCH_PENALTY = 4;

/**
 * Tọa độ GPS (latitude, longitude).
 */
export type GpsCoordinate = {
  lat: number;
  lng: number;
};

/**
 * Kết quả kiểm tra location match.
 */
export interface LocationCheckResult {
  isMatch: boolean;
  distanceMeters: number | null;
  reason: string;
}

/**
 * Parse location string thành tọa độ GPS.
 * Hỗ trợ format "lat,lng" (ví dụ: "10.8231,106.6297").
 * @param location Chuỗi location từ feedback
 * @returns GpsCoordinate hoặc null nếu parse thất bại
 */
export function parseLocationString(location: string): GpsCoordinate | null {
  if (!location || typeof location !== 'string') {
    return null;
  }

  const trimmed = location.trim();
  const parts = trimmed.split(',');

  if (parts.length !== 2) {
    return null;
  }

  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());

  if (isNaN(lat) || isNaN(lng)) {
    return null;
  }

  // Kiểm tra giới hạn hợp lệ của lat/lng
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}

/**
 * Tính khoảng cách Haversine giữa 2 điểm GPS.
 * @param a Điểm GPS thứ nhất
 * @param b Điểm GPS thứ hai
 * @returns Khoảng cách tính bằng mét
 */
export function haversineDistance(a: GpsCoordinate, b: GpsCoordinate): number {
  const EARTH_RADIUS_METERS = 6371000;

  const toRadians = (degrees: number): number => degrees * (Math.PI / 180);

  const lat1Rad = toRadians(a.lat);
  const lat2Rad = toRadians(b.lat);
  const deltaLatRad = toRadians(b.lat - a.lat);
  const deltaLngRad = toRadians(b.lng - a.lng);

  // Công thức Haversine
  const sinDeltaLat = Math.sin(deltaLatRad / 2);
  const sinDeltaLng = Math.sin(deltaLngRad / 2);
  const squareHalfChordLength =
    sinDeltaLat * sinDeltaLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDeltaLng * sinDeltaLng;

  const angularDistance =
    2 * Math.atan2(Math.sqrt(squareHalfChordLength), Math.sqrt(1 - squareHalfChordLength));

  return EARTH_RADIUS_METERS * angularDistance;
}

/**
 * Kiểm tra xem feedback location có khớp với project geofence hay không.
 * @param feedbackLocation Location string từ feedback
 * @param geofence Geofence của project (centroid + radiusMeters)
 * @returns LocationCheckResult với isMatch, distanceMeters, reason
 */
export function checkLocationMatch(
  feedbackLocation: string | undefined,
  geofence: { centroid: GpsCoordinate; radiusMeters: number } | null
): LocationCheckResult {
  // Không có geofence - bỏ qua check
  if (!geofence) {
    return {
      isMatch: true,
      distanceMeters: null,
      reason: 'No geofence defined for project'
    };
  }

  // Không có location trong feedback - bỏ qua check
  if (!feedbackLocation) {
    return {
      isMatch: true,
      distanceMeters: null,
      reason: 'No location provided in feedback'
    };
  }

  // Parse feedback location
  const parsedLocation = parseLocationString(feedbackLocation);

  if (!parsedLocation) {
    return {
      isMatch: false,
      distanceMeters: null,
      reason: 'Invalid location format'
    };
  }

  // Tính khoảng cách Haversine
  const distance = haversineDistance(parsedLocation, geofence.centroid);

  // Kiểm tra xem location có nằm trong radius không
  const isMatch = distance <= geofence.radiusMeters;

  return {
    isMatch,
    distanceMeters: Math.round(distance),
    reason: isMatch
      ? 'Location within project geofence'
      : `Location ${Math.round(distance)}m from project centroid (radius: ${geofence.radiusMeters}m)`
  };
}

/**
 * Kiểm tra xem comment có chứa từ lặp lại nhiều lần hay không.
 * @param comment Nội dung comment cần kiểm tra
 * @returns Số điểm penalty cho repeated words
 */
function detectRepeatedWords(comment: string): number {
  const words = comment.toLowerCase().split(/\s+/);
  const wordCount = new Map<string, number>();

  for (const word of words) {
    const cleanedWord = word.replace(/[^a-zA-ZÀ-ỹ]/g, '');
    if (cleanedWord.length < 2) continue;
    const currentCount = wordCount.get(cleanedWord) || 0;
    wordCount.set(cleanedWord, currentCount + 1);
  }

  let penalty = 0;
  for (const count of wordCount.values()) {
    if (count > REPEATED_WORD_THRESHOLD) {
      penalty += REPEATED_WORD_PENALTY;
    }
  }

  return penalty;
}

/**
 * Kiểm tra xem comment có chứa gibberish hay không.
 * @param comment Nội dung comment cần kiểm tra
 * @returns Số điểm penalty cho gibberish
 */
function detectGibberish(comment: string): number {
  let penalty = 0;

  // Kiểm tra repeated characters như "aaaaaa" hoặc "!!!!!"
  if (GIBBERISH_PATTERN.test(comment)) {
    penalty += GIBBERISH_PENALTY;
  }

  // Kiểm tra keyboard mashing patterns
  const words = comment.split(/\s+/);
  for (const word of words) {
    if (word.length >= 5 && KEYBOARD_MASH_PATTERN.test(word)) {
      // Kiểm tra nếu không có nguyên âm - có thể là gibberish
      if (!/[aeiouà-ỹ]/i.test(word)) {
        penalty += GIBBERISH_PENALTY;
        break;
      }
    }
  }

  return penalty;
}

/**
 * Tính risk score cho một feedback row dựa trên heuristics.
 * 
 * Heuristics hiện tại:
 * 1. Extreme ratings (1 hoặc 5) - có thể là spam
 * 2. Repeated words trong comment - pattern spam phổ biến
 * 3. Gibberish detection - keyboard mashing hoặc random characters
 * 
 * @param rating Điểm rating (1-5)
 * @param comment Nội dung comment
 * @returns Risk score từ 0-10
 */
export function computeRiskScore(rating: number, comment: string): number {
  let score = 0;

  // Extreme rating penalty
  if (rating === 1 || rating === 5) {
    score += EXTREME_RATING_PENALTY;
  }

  // Repeated words penalty
  score += detectRepeatedWords(comment);

  // Gibberish penalty
  score += detectGibberish(comment);

  // Giới hạn score trong khoảng 0-10
  return Math.min(10, Math.max(0, score));
}

/**
 * Kiểm tra xem feedback có nên được flag hay không.
 * @param riskScore Risk score đã tính
 * @returns true nếu feedback nên được flag
 */
export function shouldFlagFeedback(riskScore: number): boolean {
  return riskScore >= RISK_SCORE_AUTO_FLAG_THRESHOLD;
}

/**
 * Phân tích chi tiết một feedback và trả về các indicators.
 * @param rating Điểm rating (1-5)
 * @param comment Nội dung comment
 * @returns Object chứa các indicators và risk breakdown
 */
export function analyzeFeedbackIndicators(rating: number, comment: string): {
  isExtremeRating: boolean;
  hasRepeatedWords: boolean;
  hasGibberish: boolean;
  riskScore: number;
  shouldFlag: boolean;
  indicators: string[];
} {
  const indicators: string[] = [];
  const isExtremeRating = rating === 1 || rating === 5;
  const repeatedWordPenalty = detectRepeatedWords(comment);
  const hasRepeatedWords = repeatedWordPenalty > 0;
  const gibberishPenalty = detectGibberish(comment);
  const hasGibberish = gibberishPenalty > 0;

  if (isExtremeRating) {
    indicators.push(`extreme_rating:${rating}`);
  }
  if (hasRepeatedWords) {
    indicators.push('repeated_words');
  }
  if (hasGibberish) {
    indicators.push('gibberish_detected');
  }

  const riskScore = computeRiskScore(rating, comment);
  const shouldFlagResult = shouldFlagFeedback(riskScore);

  return {
    isExtremeRating,
    hasRepeatedWords,
    hasGibberish,
    riskScore,
    shouldFlag: shouldFlagResult,
    indicators
  };
}

/**
 * Kiểu geofence context cho việc kiểm tra location.
 */
export type GeofenceContext = {
  centroid: GpsCoordinate;
  radiusMeters: number;
};

/**
 * Kết quả phân tích feedback với location check mở rộng.
 */
export interface ExtendedFeedbackAnalysis {
  isExtremeRating: boolean;
  hasRepeatedWords: boolean;
  hasGibberish: boolean;
  locationMismatch: boolean;
  riskScore: number;
  shouldFlag: boolean;
  indicators: string[];
  locationDetails: LocationCheckResult;
}

/**
 * Phân tích chi tiết một feedback với kiểm tra location (F2.1).
 * Phiên bản mở rộng của analyzeFeedbackIndicators với geolocation check.
 * 
 * @param rating Điểm rating (1-5)
 * @param comment Nội dung comment
 * @param feedbackLocation Location string từ feedback (optional)
 * @param geofence Geofence context của project (optional)
 * @returns ExtendedFeedbackAnalysis với location mismatch indicator
 */
export function analyzeFeedbackWithLocation(
  rating: number,
  comment: string,
  feedbackLocation?: string,
  geofence?: GeofenceContext | null
): ExtendedFeedbackAnalysis {
  // Gọi hàm gốc để lấy các indicators cơ bản
  const baseAnalysis = analyzeFeedbackIndicators(rating, comment);

  // Kiểm tra location match
  const locationCheck = checkLocationMatch(feedbackLocation, geofence || null);
  const locationMismatch = !locationCheck.isMatch;

  // Xây dựng indicators array
  const indicators = [...baseAnalysis.indicators];

  // Thêm indicator cho location mismatch nếu có
  if (locationMismatch) {
    indicators.push('location_mismatch');
  }

  // Tính lại risk score với location penalty (nếu có mismatch)
  let riskScore = baseAnalysis.riskScore;
  if (locationMismatch) {
    riskScore += LOCATION_MISMATCH_PENALTY;
    riskScore = Math.min(10, riskScore); // Giới hạn trong khoảng 0-10
  }

  return {
    isExtremeRating: baseAnalysis.isExtremeRating,
    hasRepeatedWords: baseAnalysis.hasRepeatedWords,
    hasGibberish: baseAnalysis.hasGibberish,
    locationMismatch,
    riskScore,
    shouldFlag: shouldFlagFeedback(riskScore),
    indicators,
    locationDetails: locationCheck
  };
}
