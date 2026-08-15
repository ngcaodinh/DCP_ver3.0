import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueSubmissionTicket,
  verifySubmissionTicket
} from '../../utils/feedbackSubmissionTicket';

describe('feedbackSubmissionTicket', () => {
  beforeEach(() => {
    vi.useRealTimers();
    delete process.env.FEEDBACK_TICKET_HMAC_KEY;
    process.env.NODE_ENV = 'test';
  });

  it('issues and verifies a ticket for the same project', () => {
    const ticket = issueSubmissionTicket('project-001');

    expect(verifySubmissionTicket(ticket, 'project-001').projectId).toBe('project-001');
  });

  it('rejects tampered signature and cross-project replay', () => {
    const ticket = issueSubmissionTicket('project-001');
    const tamperedTicket = `${ticket.slice(0, -1)}${ticket.endsWith('0') ? '1' : '0'}`;

    expect(() => verifySubmissionTicket(tamperedTicket, 'project-001')).toThrowError('Ticket không hợp lệ.');
    expect(() => verifySubmissionTicket(ticket, 'project-002')).toThrowError('Ticket không thuộc project này.');
  });

  it('rejects a ticket after 30 minutes', () => {
    vi.useFakeTimers();
    const issuedAt = new Date('2026-08-14T00:00:00.000Z');
    vi.setSystemTime(issuedAt);
    const ticket = issueSubmissionTicket('project-001');
    vi.advanceTimersByTime(30 * 60 * 1000);

    expect(() => verifySubmissionTicket(ticket, 'project-001')).toThrowError('Phiên gửi feedback đã hết hạn.');
  });

  it('fails fast for a missing production key', () => {
    process.env.NODE_ENV = 'production';

    expect(() => issueSubmissionTicket('project-001')).toThrowError('FEEDBACK_TICKET_HMAC_KEY is not configured in production.');
  });

  it('rejects the production template sentinel instead of accepting it as a real key', () => {
    process.env.NODE_ENV = 'production';
    process.env.FEEDBACK_TICKET_HMAC_KEY = 'CHANGE_ME_FEEDBACK_TICKET_HMAC_KEY_MIN_32_CHARS';

    expect(() => issueSubmissionTicket('project-001')).toThrowError('production placeholder');
  });
});
