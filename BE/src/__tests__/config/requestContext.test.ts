import { describe, expect, it } from 'vitest';
import {
  getRequestContext,
  getRequestId,
  runWithRequestContext,
  setRequestUser
} from '../../config/requestContext';

describe('requestContext', () => {
  it('trả null/undefined ngoài request scope', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getRequestId()).toBeNull();
  });

  it('cho phép auth middleware gắn user ID vào context hiện tại', () => {
    runWithRequestContext({ requestId: 'request-1', userId: null }, () => {
      setRequestUser('user-1');

      expect(getRequestContext()).toEqual({ requestId: 'request-1', userId: 'user-1' });
      expect(getRequestId()).toBe('request-1');
    });
  });

  it('không throw khi set user ngoài request scope', () => {
    expect(() => setRequestUser('user-outside-scope')).not.toThrow();
    expect(getRequestContext()).toBeUndefined();
  });
});
