import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const incomingRequestHeaders = vi.hoisted(() => ({ value: new Headers() }));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => incomingRequestHeaders.value)
}));

import FeedbackPage from '@/app/feedback/[projectId]/page';
import FeedbackForm from '@/app/components/feedback/FeedbackForm';
import { fetchFeedbackStats } from '@/app/feedback/[projectId]/feedbackStats';
import { CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS } from '@/app/feedback/[projectId]/feedbackClientIdentity';
import { __resetFeedbackClientIpHmacKeyCacheForTests } from '@/app/utils/feedbackClientIdentityConfig';

/** Tạo Response JSON tối giản cho các nhánh SSR của trang feedback. */
function createResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Tìm component form trong cây React SSR mà không thực thi async stats component của Server Component. */
function containsComponent(node: ReactNode, target: React.ElementType): boolean {
  if (!isValidElement(node)) return false;
  if (node.type === target) return true;
  const children = (node.props as { children?: ReactNode }).children;
  return Array.isArray(children)
    ? children.some(child => containsComponent(child, target))
    : containsComponent(children, target);
}

/** Mock hai endpoint context và stats theo đúng contract mà page gọi server-side. */
function mockFeedbackFetch(formBody: unknown, statsResponse: Response = createResponse({
  success: true,
  data: { avgRating: 4.6, totalCount: 87, distribution: {} }
})) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/form-context/')) return Promise.resolve(createResponse(formBody));
    return Promise.resolve(statsResponse);
  }));
}

describe('FeedbackPage', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://backend:4000');
    __resetFeedbackClientIpHmacKeyCacheForTests();
  });

  afterEach(() => {
    __resetFeedbackClientIpHmacKeyCacheForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    incomingRequestHeaders.value = new Headers();
  });

  it('passes the same FE-signed edge identity to both SSR fetches', async () => {
    const goldenVector = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../../test-fixtures/feedback-client-identity-golden.json'),
      'utf8'
    )) as { ip: string; key: string; timeBucket: number; signature: string };
    vi.useFakeTimers({ now: goldenVector.timeBucket * CLIENT_IP_SIGNATURE_BUCKET_MILLISECONDS + 1_000 });
    const edgeIp = goldenVector.ip;
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY', goldenVector.key);
    vi.stubEnv('FEEDBACK_CLIENT_IP_HMAC_KEY_FILE', '');
    incomingRequestHeaders.value = new Headers({ 'X-Feedback-Client-IP': edgeIp });
    const capturedRequests: Array<{ init?: RequestInit; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      capturedRequests.push({ init, url });
      if (url.includes('/form-context/')) {
        return Promise.resolve(createResponse({
          success: true,
          data: {
            projectId: 'project-001',
            projectName: 'Dự án hỗ trợ',
            isAcceptingFeedback: true,
            submissionTicket: 'ticket-001'
          }
        }));
      }
      return Promise.resolve(createResponse({
        success: true,
        data: { avgRating: 4.6, totalCount: 87 }
      }));
    }));

    await FeedbackPage({ params: { projectId: 'project-001' } });

    expect(capturedRequests).toHaveLength(2);
    for (const capturedRequest of capturedRequests) {
      expect(capturedRequest.url).toMatch(/^http:\/\/backend:4000\/api\/feedback\/(?:form-context|stats)\//u);
      const headers = new Headers(capturedRequest.init?.headers);
      expect(headers.get('X-Feedback-Client-IP')).toBe(edgeIp);
      expect(headers.get('X-Feedback-Client-IP-Signature')).toBe(goldenVector.signature);
    }
  });

  it('returns the form page without awaiting a stalled stats request', async () => {
    const statsRequest = new Promise<Response>(() => undefined);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/form-context/')) {
        return Promise.resolve(createResponse({
          success: true,
          data: {
            projectId: 'project-001',
            projectName: 'Dự án hỗ trợ',
            isAcceptingFeedback: true,
            submissionTicket: 'ticket-001'
          }
        }));
      }
      return statsRequest;
    }));

    const element = await FeedbackPage({ params: { projectId: 'project-001' } });
    expect(containsComponent(element, FeedbackForm)).toBe(true);
  });

  it('keeps the form when stats returns an invalid shape', async () => {
    mockFeedbackFetch({
      success: true,
      data: {
        projectId: 'project-001',
        projectName: 'Dự án hỗ trợ',
        isAcceptingFeedback: true,
        submissionTicket: 'ticket-001'
      }
    }, createResponse({ success: true, data: { avgRating: 'bad', totalCount: 'bad' } }));

    const element = await FeedbackPage({ params: { projectId: 'project-001' } });
    expect(containsComponent(element, FeedbackForm)).toBe(true);
  });

  it('ignores a rejected stats request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('stats unavailable')));

    await expect(fetchFeedbackStats('project-001')).resolves.toBeNull();
  });

  it('aborts a stats request after two seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));

    const statsPromise = fetchFeedbackStats('project-001');
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(statsPromise).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('does not render a mismatched project context', async () => {
    mockFeedbackFetch({
      success: true,
      data: {
        projectId: 'another-project',
        projectName: 'Dự án không khớp',
        isAcceptingFeedback: true,
        submissionTicket: 'ticket-001'
      }
    });

    const element = await FeedbackPage({ params: { projectId: 'project-001' } });
    render(element);

    expect(screen.getByRole('heading', { name: 'Không tải được dự án' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gửi phản hồi' })).not.toBeInTheDocument();
  });

  it('renders a read-only message when the project is not accepting feedback', async () => {
    mockFeedbackFetch({
      success: true,
      data: {
        projectId: 'project-001',
        projectName: 'Dự án nháp',
        isAcceptingFeedback: false
      }
    });

    const element = await FeedbackPage({ params: { projectId: 'project-001' } });
    render(element);

    expect(screen.getByText('Dự án chưa mở nhận phản hồi.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gửi phản hồi' })).not.toBeInTheDocument();
  });

  it('renders a whitelisted success status from searchParams', async () => {
    mockFeedbackFetch({
      success: true,
      data: {
        projectId: 'project-001',
        projectName: 'Dự án đã đóng',
        isAcceptingFeedback: false
      }
    });

    const element = await FeedbackPage({
      params: { projectId: 'project-001' },
      searchParams: { status: 'success' }
    });
    render(element);

    expect(screen.getByText(/Phản hồi đã được ghi nhận/)).toBeInTheDocument();
  });

  it('uses the route-local 404 for an unknown project', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/form-context/')) return Promise.resolve(createResponse({ success: false }, 404));
      return Promise.resolve(createResponse({ success: true, data: { avgRating: null, totalCount: 0 } }));
    }));

    await expect(FeedbackPage({ params: { projectId: 'missing-project' } })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
