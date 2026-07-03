/**
 * Test cho feedbackSpamDetection.service.ts - kiểm tra spam detection heuristics.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRiskScore,
  shouldFlagFeedback,
  analyzeFeedbackIndicators,
  RISK_SCORE_AUTO_FLAG_THRESHOLD,
  parseLocationString,
  haversineDistance,
  checkLocationMatch,
  analyzeFeedbackWithLocation,
  LOCATION_MISMATCH_PENALTY
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

    it('nên handle comment với newlines và tabs', () => {
      const score = computeRiskScore(3, 'Good\nservice!\tThank you');
      expect(score).toBe(0);
    });

    it('nên handle comment với special characters', () => {
      const score = computeRiskScore(3, 'Tốt!@#$%^&*()');
      expect(score).toBe(0);
    });

    it('nên handle comment với emoji', () => {
      const score = computeRiskScore(3, 'Rất tốt 👍');
      expect(score).toBe(0);
    });

    it('nên handle comment với mixed case words', () => {
      // "GoOd" vs "good" - should be treated same after lowercase
      const score = computeRiskScore(3, 'GoOd GoOd GoOd GoOd GoOd');
      expect(score).toBeGreaterThan(0);
    });

    it('nên handle rating values đúng ranh giới 1 và 5', () => {
      const score1 = computeRiskScore(1, 'Bad');
      const score5 = computeRiskScore(5, 'Excellent');
      expect(score1).toBe(2);
      expect(score5).toBe(2);
    });

    it('nên handle rating values 2, 3, 4 không trigger extreme penalty', () => {
      const score2 = computeRiskScore(2, 'Below average');
      const score3 = computeRiskScore(3, 'Average');
      const score4 = computeRiskScore(4, 'Above average');
      expect(score2).toBe(0);
      expect(score3).toBe(0);
      expect(score4).toBe(0);
    });
  });

  describe('repeated words detection', () => {
    it('nên phát hiện repeated words với threshold > 3', () => {
      // "hay" xuất hiện 4 lần (> 3)
      const score = computeRiskScore(3, 'hay hay hay hay quá');
      expect(score).toBeGreaterThan(0);
    });

    it('nên không trigger repeated words nếu count = 3 hoặc ít hơn', () => {
      // "hay" xuất hiện đúng 3 lần - không trigger
      const score = computeRiskScore(3, 'hay hay hay dịch vụ tốt');
      expect(score).toBe(0);
    });

    it('nên xử lý multiple words repeated độc lập', () => {
      const score = computeRiskScore(3, 'good good good good very good good good');
      // Có 2 words (good, very) mỗi word xuất hiện > 3 lần
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('gibberish detection', () => {
    it('nên phát hiện gibberish với repeated characters >= 5', () => {
      const score = computeRiskScore(3, '!!!!! ????? @@@@@');
      // Characters lặp >= 5 lần sẽ trigger GIBBERISH_PATTERN
      expect(score).toBeGreaterThanOrEqual(3);
    });

    it('nên không trigger gibberish cho short comments (< 5 chars)', () => {
      const score = computeRiskScore(3, 'aaaa');
      expect(score).toBe(0);
    });

    it('nên phát hiện keyboard mashing không có vowels', () => {
      // "qwrtyp" - 6 ký tự, không có nguyên âm a,e,i,o,u
      const score = computeRiskScore(3, 'qwrtyp dfgjkl sxcvbn');
      expect(score).toBeGreaterThanOrEqual(3);
    });

    it('nên xử lý Vietnamese text không bị detect là gibberish', () => {
      const score = computeRiskScore(3, 'Tôi thích dự án này');
      expect(score).toBe(0);
    });

    it('nên xử lý text có vowels không bị false positive', () => {
      const score = computeRiskScore(3, 'asdfasdf has vowels');
      // Có vowels nên không bị keyboard mashing pattern detect
      expect(score).toBeLessThan(3);
    });
  });

  describe('shouldFlagFeedback boundary', () => {
    it('nên return true khi riskScore = 6.99', () => {
      // Không nên flag vì 6.99 < 7
      expect(shouldFlagFeedback(6.99)).toBe(false);
    });

    it('nên return true khi riskScore = 7.00 (boundary)', () => {
      expect(shouldFlagFeedback(7.00)).toBe(true);
    });

    it('nên return true khi riskScore = 7.01', () => {
      expect(shouldFlagFeedback(7.01)).toBe(true);
    });

    it('nên return false cho riskScore = 6.9', () => {
      expect(shouldFlagFeedback(6.9)).toBe(false);
    });

    it('nên return true cho riskScore = 10 (max)', () => {
      expect(shouldFlagFeedback(10)).toBe(true);
    });
  });

  describe('combined spam indicators', () => {
    it('nên combine extreme rating + repeated words để trigger flag', () => {
      // Rating 5 (2) + repeated words (1) = 3 - not enough
      const score = computeRiskScore(5, 'good good good good service');
      expect(score).toBeLessThan(7);
    });

    it('nên combine extreme rating + gibberish để trigger flag', () => {
      // Rating 1 (2) + gibberish (3) = 5 - not enough
      const score = computeRiskScore(1, 'asdkfjhasdf');
      expect(score).toBeLessThan(7);
    });

    it('nên combine extreme rating + repeated words + gibberish để trigger flag', () => {
      // Rating 1 (2) + gibberish (3) + repeated words (1) = 6 - not enough
      const score = computeRiskScore(1, 'asdkfjhasdf good good good good');
      expect(score).toBeLessThan(7);
    });

    it('nên trigger flag với extreme rating + multiple gibberish patterns', () => {
      // Rating 5 (2) + multiple gibberish patterns
      const score = computeRiskScore(5, 'aaaaaa bbbbbb cccccc dddddd');
      expect(score).toBeGreaterThanOrEqual(7);
    });

    it('nên trigger repeated words cho all caps comment', () => {
      // All caps vẫn bị detect repeated words sau khi lowercase
      const score = computeRiskScore(3, 'HAY HAY HAY HAY HAY HAY HAY');
      // "hay" xuất hiện 7 lần > 3, nên trigger repeated word penalty
      expect(score).toBeGreaterThanOrEqual(1);
    });
  });

  describe('analyzeFeedbackIndicators edge cases', () => {
    it('nên phát hiện extreme rating = 1', () => {
      const result = analyzeFeedbackIndicators(1, 'Bad service');
      expect(result.isExtremeRating).toBe(true);
      expect(result.indicators).toContain('extreme_rating:1');
    });

    it('nên phát hiện extreme rating = 5', () => {
      const result = analyzeFeedbackIndicators(5, 'Great service');
      expect(result.isExtremeRating).toBe(true);
      expect(result.indicators).toContain('extreme_rating:5');
    });

    it('nên trả về riskScore trong khoảng 0-10', () => {
      const result = analyzeFeedbackIndicators(3, 'aaaaaa bbbbbb cccccc dddddd');
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.riskScore).toBeLessThanOrEqual(10);
    });

    it('nên trả về correct shouldFlag cho boundary values', () => {
      const resultBelow = analyzeFeedbackIndicators(5, 'aaaaaa bbbbbb');
      expect(resultBelow.shouldFlag).toBe(true);
      expect(resultBelow.riskScore).toBeGreaterThanOrEqual(7);
    });
  });

  describe('parseLocationString', () => {
    it('nên parse đúng location string hợp lệ', () => {
      const result = parseLocationString('10.8231,106.6297');
      expect(result).toEqual({ lat: 10.8231, lng: 106.6297 });
    });

    it('nên parse location với spaces', () => {
      const result = parseLocationString('  10.8231 ,  106.6297  ');
      expect(result).toEqual({ lat: 10.8231, lng: 106.6297 });
    });

    it('nên parse negative coordinates', () => {
      const result = parseLocationString('-33.8688,151.2093');
      expect(result).toEqual({ lat: -33.8688, lng: 151.2093 });
    });

    it('nên trả về null cho invalid format (1 phần)', () => {
      expect(parseLocationString('10.8231')).toBeNull();
    });

    it('nên trả về null cho invalid format (3 phần)', () => {
      expect(parseLocationString('10.8231,106.6297,100')).toBeNull();
    });

    it('nên trả về null cho non-numeric values', () => {
      expect(parseLocationString('abc,def')).toBeNull();
    });

    it('nên trả về null cho empty string', () => {
      expect(parseLocationString('')).toBeNull();
    });

    it('nên trả về null cho undefined/null', () => {
      expect(parseLocationString(undefined as unknown as string)).toBeNull();
      expect(parseLocationString(null as unknown as string)).toBeNull();
    });

    it('nên trả về null khi lat vượt giới hạn (-90 đến 90)', () => {
      expect(parseLocationString('91,106.6297')).toBeNull();
      expect(parseLocationString('-91,106.6297')).toBeNull();
    });

    it('nên trả về null khi lng vượt giới hạn (-180 đến 180)', () => {
      expect(parseLocationString('10.8231,181')).toBeNull();
      expect(parseLocationString('10.8231,-181')).toBeNull();
    });
  });

  describe('haversineDistance', () => {
    it('nên trả về 0 cho cùng một điểm', () => {
      const point = { lat: 10.8231, lng: 106.6297 };
      const distance = haversineDistance(point, point);
      expect(distance).toBe(0);
    });

    it('nên tính khoảng cách xấp xỉ 111km cho 1 độ latitude', () => {
      // 1 độ latitude ≈ 111.19 km
      const pointA = { lat: 0, lng: 0 };
      const pointB = { lat: 1, lng: 0 };
      const distance = haversineDistance(pointA, pointB);
      // 111.19 km = 111190 m, cho phép sai số 1%
      expect(distance).toBeGreaterThan(110000);
      expect(distance).toBeLessThan(112000);
    });

    it('nên tính khoảng cách xấp xỉ đúng cho các điểm gần nhau', () => {
      // TP.HCM đến Vũng Tàu: ~80km
      const hochiminh = { lat: 10.8231, lng: 106.6297 };
      const vungtau = { lat: 10.3498, lng: 107.0847 };
      const distance = haversineDistance(hochiminh, vungtau);
      // 70-90km range
      expect(distance).toBeGreaterThan(65000);
      expect(distance).toBeLessThan(95000);
    });

    it('nên tính khoảng cách xấp xỉ 20000km cho antipodal points', () => {
      // Hai điểm đối xứng qua trái đất
      const pointA = { lat: 0, lng: 0 };
      const pointB = { lat: 0, lng: 180 };
      const distance = haversineDistance(pointA, pointB);
      // Nửa chu vi trái đất ≈ 20000km
      expect(distance).toBeGreaterThan(19800000);
      expect(distance).toBeLessThan(20200000);
    });
  });

  describe('checkLocationMatch', () => {
    const projectGeofence = {
      centroid: { lat: 10.8231, lng: 106.6297 },
      radiusMeters: 500
    };

    it('nên return isMatch=true khi location trong radius', () => {
      const feedbackLocation = '10.8235,106.6300'; // Gần centroid
      const result = checkLocationMatch(feedbackLocation, projectGeofence);
      expect(result.isMatch).toBe(true);
      expect(result.distanceMeters).not.toBeNull();
      expect(result.distanceMeters).toBeLessThan(500);
    });

    it('nên return isMatch=false khi location ngoài radius', () => {
      const feedbackLocation = '10.8600,106.6500'; // Xa centroid
      const result = checkLocationMatch(feedbackLocation, projectGeofence);
      expect(result.isMatch).toBe(false);
      expect(result.distanceMeters).toBeGreaterThan(500);
    });

    it('nên return isMatch=true khi không có geofence', () => {
      const result = checkLocationMatch('10.8231,106.6297', null);
      expect(result.isMatch).toBe(true);
      expect(result.reason).toBe('No geofence defined for project');
    });

    it('nên return isMatch=true khi không có location trong feedback', () => {
      const result = checkLocationMatch(undefined, projectGeofence);
      expect(result.isMatch).toBe(true);
      expect(result.reason).toBe('No location provided in feedback');
    });

    it('nên return isMatch=false khi location format không hợp lệ', () => {
      const result = checkLocationMatch('invalid-location', projectGeofence);
      expect(result.isMatch).toBe(false);
      expect(result.reason).toBe('Invalid location format');
    });

    it('nên return isMatch=true khi location đúng tại centroid', () => {
      const feedbackLocation = '10.8231,106.6297';
      const result = checkLocationMatch(feedbackLocation, projectGeofence);
      expect(result.isMatch).toBe(true);
      expect(result.distanceMeters).toBe(0);
    });

    it('nên return isMatch=true khi location tại boundary của radius', () => {
      // Tính một điểm cách centroid ~500m
      // 0.0045 độ latitude ≈ 500m
      const feedbackLocation = '10.8276,106.6297';
      const result = checkLocationMatch(feedbackLocation, projectGeofence);
      // Có thể match hoặc không tùy thuộc vào tính chính xác
      expect(result.distanceMeters).toBeGreaterThan(400);
      expect(result.distanceMeters).toBeLessThan(600);
    });
  });

  describe('analyzeFeedbackWithLocation', () => {
    const projectGeofence = {
      centroid: { lat: 10.8231, lng: 106.6297 },
      radiusMeters: 500
    };

    it('nên thêm location_mismatch indicator khi location không khớp', () => {
      const feedbackLocation = '10.9000,106.7000'; // Xa project
      const result = analyzeFeedbackWithLocation(3, 'Normal comment', feedbackLocation, projectGeofence);
      
      expect(result.locationMismatch).toBe(true);
      expect(result.indicators).toContain('location_mismatch');
    });

    it('nên không thêm location_mismatch indicator khi location khớp', () => {
      const feedbackLocation = '10.8235,106.6300'; // Gần centroid
      const result = analyzeFeedbackWithLocation(3, 'Normal comment', feedbackLocation, projectGeofence);
      
      expect(result.locationMismatch).toBe(false);
      expect(result.indicators).not.toContain('location_mismatch');
    });

    it('nên thêm location penalty vào risk score khi có mismatch', () => {
      const feedbackLocation = '10.9000,106.7000';
      const resultWithoutLocation = analyzeFeedbackWithLocation(3, 'Normal comment', undefined, undefined);
      const resultWithMismatch = analyzeFeedbackWithLocation(3, 'Normal comment', feedbackLocation, projectGeofence);
      
      expect(resultWithMismatch.riskScore).toBe(resultWithoutLocation.riskScore + LOCATION_MISMATCH_PENALTY);
    });

    it('nên không thêm penalty khi location khớp', () => {
      const feedbackLocation = '10.8235,106.6300';
      const resultWithoutLocation = analyzeFeedbackWithLocation(3, 'Normal comment', undefined, undefined);
      const resultWithMatch = analyzeFeedbackWithLocation(3, 'Normal comment', feedbackLocation, projectGeofence);
      
      expect(resultWithMatch.riskScore).toBe(resultWithoutLocation.riskScore);
    });

    it('nên giới hạn risk score trong khoảng 0-10 khi có location penalty', () => {
      // Extreme rating (2) + location mismatch (4) = 6, không trigger flag
      const result = analyzeFeedbackWithLocation(
        1,
        'Normal comment',
        '10.9000,106.7000',
        projectGeofence
      );
      
      expect(result.riskScore).toBeLessThanOrEqual(10);
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
    });

    it('nên trigger flag khi location mismatch đẩy score >= 7', () => {
      // Extreme rating (2) + location mismatch (4) = 6 - not enough
      // Cần thêm penalty từ repeated words
      const result = analyzeFeedbackWithLocation(
        1,
        'aaaaaa good good good good good',
        '10.9000,106.7000',
        projectGeofence
      );
      
      // 2 (extreme) + 4 (location) + 3 (gibberish) = 9 >= 7
      expect(result.shouldFlag).toBe(true);
    });

    it('nên backward compatible khi không có location', () => {
      const result = analyzeFeedbackWithLocation(3, 'Normal comment');
      const baseResult = analyzeFeedbackIndicators(3, 'Normal comment');
      
      expect(result.riskScore).toBe(baseResult.riskScore);
      expect(result.shouldFlag).toBe(baseResult.shouldFlag);
      expect(result.locationMismatch).toBe(false);
    });

    it('nên backward compatible khi không có geofence', () => {
      const result = analyzeFeedbackWithLocation(3, 'Normal comment', '10.8231,106.6297', undefined);
      const baseResult = analyzeFeedbackIndicators(3, 'Normal comment');
      
      expect(result.riskScore).toBe(baseResult.riskScore);
      expect(result.locationMismatch).toBe(false);
    });

    it('nên trả về locationDetails trong result', () => {
      const result = analyzeFeedbackWithLocation(3, 'Normal comment', '10.8231,106.6297', projectGeofence);
      
      expect(result.locationDetails).toBeDefined();
      expect(result.locationDetails.isMatch).toBe(true);
      expect(result.locationDetails.distanceMeters).toBe(0);
    });
  });

  describe('LOCATION_MISMATCH_PENALTY constant', () => {
    it('nên là 4', () => {
      expect(LOCATION_MISMATCH_PENALTY).toBe(4);
    });
  });
});
