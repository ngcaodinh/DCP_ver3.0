/**
 * Test cho feedbackSpamDetection.service.ts - kiểm tra spam detection heuristics.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRiskScore,
  shouldFlagFeedback,
  analyzeFeedbackIndicators,
  RISK_SCORE_AUTO_FLAG_THRESHOLD
} from '../../services/feedbackSpamDetection.service';

describe('feedbackSpamDetection.service', () => {
  describe('RISK_SCORE_AUTO_FLAG_THRESHOLD', () => {
    it('nên là 7', () => {
      expect(RISK_SCORE_AUTO_FLAG_THRESHOLD).toBe(7);
    });
  });

  describe('computeRiskScore', () => {
    it('nên trả về 0 cho normal feedback', () => {
      const score = computeRiskScore(3, 'This is a normal comment about the service.');
      expect(score).toBe(0);
    });

    it('nên add penalty cho extreme rating (1 hoặc 5)', () => {
      const scoreRating1 = computeRiskScore(1, 'Normal comment');
      const scoreRating5 = computeRiskScore(5, 'Normal comment');
      const scoreRating3 = computeRiskScore(3, 'Normal comment');

      // Rating 1/5 có penalty 2
      expect(scoreRating1).toBe(2);
      expect(scoreRating5).toBe(2);
      // Rating 3 không có penalty
      expect(scoreRating3).toBe(0);
    });

    it('nên detect repeated words pattern', () => {
      // Comment với từ lặp lại nhiều lần
      const spamComment = 'good good good good good service is good good good';
      const score = computeRiskScore(3, spamComment);

      // Repeated words > 3x sẽ có penalty
      expect(score).toBeGreaterThanOrEqual(1);
    });

    it('nên detect gibberish characters', () => {
      // Comment với characters lặp lại
      const gibberishComment = 'aaaaaa bbbbbb cccccc';
      const score = computeRiskScore(3, gibberishComment);

      expect(score).toBeGreaterThanOrEqual(3); // Có gibberish penalty
    });

    it('nên handle keyboard mashing patterns', () => {
      // Keyboard mashing thực sự cần characters lặp lại như "asdddd" hoặc "xxxxxx"
      const keyboardMash = 'xxxxx yyyyy zzzzzz aaaaaa bbbbbb';
      const score = computeRiskScore(3, keyboardMash);

      // Characters lặp lại sẽ bị detect như gibberish
      expect(score).toBeGreaterThanOrEqual(3);
    });

    it('nên giới hạn score trong khoảng 0-10', () => {
      // Comment với nhiều spam indicators
      const worstCase = 'aaaaaa bbbbbb cccccc zzzzzz good good good good good good';
      const score = computeRiskScore(1, worstCase);

      expect(score).toBeLessThanOrEqual(10);
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('nên combine multiple penalties', () => {
      // Extreme rating + repeated words + gibberish
      const combinedSpam = '1 aaaaaa bbbbbb cccccc good good good good good';
      const score = computeRiskScore(1, combinedSpam);

      // Nên có multiple penalties
      expect(score).toBeGreaterThan(5);
    });
  });

  describe('shouldFlagFeedback', () => {
    it('nên return true khi riskScore >= 7', () => {
      expect(shouldFlagFeedback(7)).toBe(true);
      expect(shouldFlagFeedback(8)).toBe(true);
      expect(shouldFlagFeedback(10)).toBe(true);
    });

    it('nên return false khi riskScore < 7', () => {
      expect(shouldFlagFeedback(6)).toBe(false);
      expect(shouldFlagFeedback(5)).toBe(false);
      expect(shouldFlagFeedback(0)).toBe(false);
    });
  });

  describe('analyzeFeedbackIndicators', () => {
    it('nên trả về indicators cho extreme rating', () => {
      const result = analyzeFeedbackIndicators(1, 'Normal comment');

      expect(result.isExtremeRating).toBe(true);
      expect(result.indicators).toContain('extreme_rating:1');
    });

    it('nên trả về indicators cho repeated words', () => {
      const result = analyzeFeedbackIndicators(3, 'good good good good good service');

      expect(result.hasRepeatedWords).toBe(true);
      expect(result.indicators).toContain('repeated_words');
    });

    it('nên trả về indicators cho gibberish', () => {
      const result = analyzeFeedbackIndicators(3, 'aaaaaa bbbbbb');

      expect(result.hasGibberish).toBe(true);
      expect(result.indicators).toContain('gibberish_detected');
    });

    it('nên trả về shouldFlag = true khi score >= threshold', () => {
      const result = analyzeFeedbackIndicators(1, 'aaaaaa bbbbbb cccccc good good good good');

      expect(result.shouldFlag).toBe(true);
      expect(result.riskScore).toBeGreaterThanOrEqual(7);
    });

    it('nên trả về shouldFlag = false cho normal feedback', () => {
      const result = analyzeFeedbackIndicators(3, 'This is a good service. Thank you.');

      expect(result.shouldFlag).toBe(false);
      expect(result.riskScore).toBe(0);
    });

    it('nên trả về empty indicators cho normal feedback', () => {
      const result = analyzeFeedbackIndicators(3, 'This is a good service.');

      expect(result.indicators).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('nên handle empty comment', () => {
      const score = computeRiskScore(3, '');
      expect(score).toBe(0);
    });

    it('nên handle comment với unicode', () => {
      const score = computeRiskScore(3, 'Dịch vụ rất tốt! Cảm ơn!');
      expect(score).toBe(0);
    });

    it('nên handle comment với numbers và symbols', () => {
      // Comment có rating 5 (extreme) sẽ có penalty 2
      const score = computeRiskScore(5, 'Rate: 5/5 Stars! Great service');
      expect(score).toBe(2); // Rating 5 extreme penalty
    });
  });
});
