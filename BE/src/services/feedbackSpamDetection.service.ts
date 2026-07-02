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
