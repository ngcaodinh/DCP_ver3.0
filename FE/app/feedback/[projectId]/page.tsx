import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { buildServerApiUrl } from '../../utils/serverApiClient';
import FeedbackForm from '../../components/feedback/FeedbackForm';
import FeedbackStatsSummary, { type FeedbackStatsSummaryData } from '../../components/feedback/FeedbackStatsSummary';
import FeedbackStatusBanner from '../../components/feedback/FeedbackStatusBanner';
import { fetchFeedbackStats } from './feedbackStats';
import {
  createFeedbackClientIdentityHeaders,
  getTrustedFeedbackClientIp
} from './feedbackClientIdentity';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Gửi phản hồi',
  robots: { index: false, follow: false }
};

interface FeedbackPageParams {
  projectId: string;
}

interface FeedbackPageProps {
  params: FeedbackPageParams;
  searchParams?: Record<string, string | string[] | undefined>;
}

interface FeedbackFormContext {
  projectId: string;
  projectName: string;
  isAcceptingFeedback: boolean;
  submissionTicket?: string;
}

type FetchFormContextResult =
  | { kind: 'ok'; data: FeedbackFormContext }
  | { kind: 'not-found' }
  | { kind: 'error' };

/** Kiểm tra object động có phải record để đọc response API mà không dùng any. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Đọc context form và buộc projectId trong response khớp URL trước khi hiển thị form. */
function parseFeedbackFormContext(value: unknown, expectedProjectId: string): FeedbackFormContext | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (
    typeof data.projectId !== 'string' ||
    data.projectId !== expectedProjectId ||
    typeof data.projectName !== 'string' ||
    !data.projectName.trim() ||
    typeof data.isAcceptingFeedback !== 'boolean'
  ) {
    return null;
  }
  if (data.isAcceptingFeedback && typeof data.submissionTicket !== 'string') return null;
  return {
    projectId: data.projectId,
    projectName: data.projectName,
    isAcceptingFeedback: data.isAcceptingFeedback,
    ...(typeof data.submissionTicket === 'string' ? { submissionTicket: data.submissionTicket } : {})
  };
}

/** Lấy context phía server, phân biệt 404 thật với lỗi backend để trang không làm hỏng toàn route. */
async function fetchFeedbackFormContext(
  projectId: string,
  clientIdentityHeaders: Record<string, string>
): Promise<FetchFormContextResult> {
  try {
    const response = await fetch(buildServerApiUrl(`/api/feedback/form-context/${encodeURIComponent(projectId)}`), {
      cache: 'no-store',
      headers: clientIdentityHeaders
    });
    if (response.status === 404) return { kind: 'not-found' };
    if (!response.ok) return { kind: 'error' };
    const body = await response.json() as unknown;
    const data = parseFeedbackFormContext(body, projectId);
    return data ? { kind: 'ok', data } : { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

/** Hiển thị thống kê trong vùng chờ riêng để request chậm không giữ TTFB của form. */
async function FeedbackStatsSection({ statsPromise }: { statsPromise: Promise<FeedbackStatsSummaryData | null> }): Promise<React.ReactElement> {
  const stats = await statsPromise;
  return <FeedbackStatsSummary stats={stats} />;
}

/** Hiển thị trang feedback SSR thuần, không có client state và không phụ thuộc JavaScript trình duyệt. */
export default async function FeedbackPage({ params, searchParams }: FeedbackPageProps): Promise<React.ReactElement> {
  const statusValue = searchParams?.status;
  const status = Array.isArray(statusValue) ? statusValue[0] : statusValue;
  const clientIdentityHeaders = createFeedbackClientIdentityHeaders(getTrustedFeedbackClientIp());
  const formContextResult = await fetchFeedbackFormContext(params.projectId, clientIdentityHeaders);

  if (formContextResult.kind === 'not-found') notFound();
  if (formContextResult.kind === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
        <section className="w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold text-slate-900">Không tải được dự án</h1>
          <p className="mt-3 text-sm text-slate-600">Vui lòng thử lại sau.</p>
          <Link
            href={`/feedback/${encodeURIComponent(params.projectId)}`}
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            Thử lại
          </Link>
        </section>
      </main>
    );
  }

  const context = formContextResult.data;
  const statsPromise = context.isAcceptingFeedback
    ? fetchFeedbackStats(params.projectId, clientIdentityHeaders)
    : null;
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <FeedbackStatusBanner projectId={context.projectId} status={status} />
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          <p className="text-sm font-semibold text-emerald-700">DCP · Phản hồi cộng đồng</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">{context.projectName}</h1>
          {context.isAcceptingFeedback && context.submissionTicket ? (
            <>
              <p className="mt-3 text-sm leading-6 text-slate-600">Chia sẻ trải nghiệm của bạn để dự án tiếp tục minh bạch và cải thiện.</p>
              <div className="mt-6">
                {statsPromise ? (
                  <Suspense fallback={null}>
                    <FeedbackStatsSection statsPromise={statsPromise} />
                  </Suspense>
                ) : null}
                <FeedbackForm projectId={context.projectId} submissionTicket={context.submissionTicket} />
              </div>
            </>
          ) : (
            <p className="mt-5 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-700">Dự án chưa mở nhận phản hồi.</p>
          )}
        </section>
      </div>
    </main>
  );
}
