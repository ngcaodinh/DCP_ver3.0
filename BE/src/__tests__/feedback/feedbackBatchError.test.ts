/**
 * Test cho feedbackBatchError.ts - kiểm tra custom error classes.
 */
import { describe, it, expect } from 'vitest';
import { ApplicationError } from '../../utils/applicationError';
import {
  BatchSizeExceededError,
  EmptyBatchError,
  FileTooLargeError,
  InvalidCsvError,
  PayloadMustBeArrayError,
  isFeedbackBatchError
} from '../../utils/feedbackBatchError';

describe('feedbackBatchError', () => {
  describe('BatchSizeExceededError', () => {
    it('nên có statusCode là 400', () => {
      const error = new BatchSizeExceededError();
      expect(error.statusCode).toBe(400);
    });

    it('nên có errorCode là BATCH_SIZE_EXCEEDED', () => {
      const error = new BatchSizeExceededError();
      expect(error.errorCode).toBe('BATCH_SIZE_EXCEEDED');
    });

    it('nên có default message', () => {
      const error = new BatchSizeExceededError();
      expect(error.message).toBe('Batch size exceeds 1000 limit.');
    });

    it('nên cho phép custom message', () => {
      const error = new BatchSizeExceededError('Custom message');
      expect(error.message).toBe('Custom message');
    });

    it('nên là instance của Error', () => {
      const error = new BatchSizeExceededError();
      expect(error).toBeInstanceOf(Error);
    });

    it('nên là instance của ApplicationError', () => {
      const error = new BatchSizeExceededError();
      expect(error).toBeInstanceOf(ApplicationError);
    });
  });

  describe('FileTooLargeError', () => {
    it('nên có statusCode là 400', () => {
      const error = new FileTooLargeError();
      expect(error.statusCode).toBe(400);
    });

    it('nên có errorCode là FILE_TOO_LARGE', () => {
      const error = new FileTooLargeError();
      expect(error.errorCode).toBe('FILE_TOO_LARGE');
    });

    it('nên có default message', () => {
      const error = new FileTooLargeError();
      expect(error.message).toBe('File size exceeds 5MB limit.');
    });
  });

  describe('EmptyBatchError', () => {
    it('nên có statusCode 400 và errorCode EMPTY_BATCH', () => {
      const error = new EmptyBatchError();
      expect(error.statusCode).toBe(400);
      expect(error.errorCode).toBe('EMPTY_BATCH');
    });
  });

  describe('InvalidCsvError', () => {
    it('nên có statusCode là 400', () => {
      const error = new InvalidCsvError();
      expect(error.statusCode).toBe(400);
    });

    it('nên có errorCode là INVALID_CSV_FORMAT', () => {
      const error = new InvalidCsvError();
      expect(error.errorCode).toBe('INVALID_CSV_FORMAT');
    });

    it('nên có default message', () => {
      const error = new InvalidCsvError();
      expect(error.message).toBe('Invalid CSV format.');
    });
  });

  describe('PayloadMustBeArrayError', () => {
    it('nên có statusCode là 400', () => {
      const error = new PayloadMustBeArrayError();
      expect(error.statusCode).toBe(400);
    });

    it('nên có errorCode là PAYLOAD_MUST_BE_ARRAY', () => {
      const error = new PayloadMustBeArrayError();
      expect(error.errorCode).toBe('PAYLOAD_MUST_BE_ARRAY');
    });

    it('nên có default message', () => {
      const error = new PayloadMustBeArrayError();
      expect(error.message).toBe('Payload must be a JSON array.');
    });
  });

  describe('isFeedbackBatchError', () => {
    it('nên trả về true cho BatchSizeExceededError', () => {
      expect(isFeedbackBatchError(new BatchSizeExceededError())).toBe(true);
    });

    it('nên trả về true cho FileTooLargeError', () => {
      expect(isFeedbackBatchError(new FileTooLargeError())).toBe(true);
    });

    it('nên trả về true cho EmptyBatchError', () => {
      expect(isFeedbackBatchError(new EmptyBatchError())).toBe(true);
    });

    it('nên trả về true cho InvalidCsvError', () => {
      expect(isFeedbackBatchError(new InvalidCsvError())).toBe(true);
    });

    it('nên trả về true cho PayloadMustBeArrayError', () => {
      expect(isFeedbackBatchError(new PayloadMustBeArrayError())).toBe(true);
    });

    it('nên trả về false cho Error thường', () => {
      expect(isFeedbackBatchError(new Error('Some error'))).toBe(false);
    });

    it('nên trả về false cho null', () => {
      expect(isFeedbackBatchError(null)).toBe(false);
    });

    it('nên trả về false cho undefined', () => {
      expect(isFeedbackBatchError(undefined)).toBe(false);
    });

    it('nên trả về false cho string', () => {
      expect(isFeedbackBatchError('error string')).toBe(false);
    });
  });
});
