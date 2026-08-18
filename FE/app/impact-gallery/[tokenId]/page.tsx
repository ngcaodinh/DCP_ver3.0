import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import SbtImage from '@/app/components/impactSbt/SbtImage';
import SbtLocationMap from '@/app/components/impactSbt/SbtLocationMap';
import SbtMetadataPanel from '@/app/components/impactSbt/SbtMetadataPanel';
import SbtMilestoneTimeline from '@/app/components/impactSbt/SbtMilestoneTimeline';
import SbtPolygonScanLink from '@/app/components/impactSbt/SbtPolygonScanLink';
import SbtStatusBanner from '@/app/components/impactSbt/SbtStatusBanner';
import type {
  ImpactSbtGalleryEntry,
  ImpactSbtGalleryResponse,
  ImpactSbtTokenStatus,
  SbtTokenDetailResponse,
  SbtTokenOffChainDetail,
  SbtTokenOnChainDetail
} from '@/app/types/impactSbt';
import { buildServerApiUrl } from '@/app/utils/serverApiClient';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chi tiết Impact SBT',
  robots: { index: false, follow: false }
};

const TOKEN_STATUSES: readonly ImpactSbtTokenStatus[] = ['ACTIVE', 'FROZEN', 'REVOKED', 'BURNED'];
const MAX_MILESTONE_PAGES = 5;
const MILESTONE_PAGE_SIZE = 20;
const SERVER_API_REQUEST_TIMEOUT_MS = 10_000;
const MILESTONE_API_REQUEST_TIMEOUT_MS = 4_000;
const INTERNAL_SSR_REQUEST_HEADER = 'X-DCP-SSR-Request';
const INTERNAL_SSR_REQUEST_HEADER_VALUE = '1';

interface SbtTokenPageParams {
  tokenId: string;
}

interface SbtTokenPageProps {
  params: SbtTokenPageParams;
}

type TokenDetailFetchResult =
  | { kind: 'ok'; detail: SbtTokenDetailResponse }
  | { kind: 'not-found' }
  | { kind: 'error' };

interface ServerApiResponse {
  status: number;
  body: unknown | null;
}

/** Kiểm tra object động trước khi đọc response API mà không dùng any. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Kiểm tra số nguyên không âm trong giới hạn an toàn của JavaScript. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Kiểm tra timestamp string hợp lệ để tránh render dữ liệu thời gian bất thường. */
function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

/** Kiểm tra status token theo allowlist contract public. */
function isTokenStatus(value: unknown): value is ImpactSbtTokenStatus {
  return typeof value === 'string' && TOKEN_STATUSES.includes(value as ImpactSbtTokenStatus);
}

/** Kiểm tra giá trị string nullable từ JSON response. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Gọi API nội bộ với timeout bao phủ cả lúc nhận header và đọc JSON body. */
async function fetchServerApiResponse(
  pathname: string,
  timeoutMs = SERVER_API_REQUEST_TIMEOUT_MS
): Promise<ServerApiResponse | null> {
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetch(buildServerApiUrl(pathname), {
      cache: 'no-store',
      headers: { [INTERNAL_SSR_REQUEST_HEADER]: INTERNAL_SSR_REQUEST_HEADER_VALUE },
      signal: abortController.signal
    });
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: await response.json() as unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/** Parse phần on-chain detail từ response untrusted trước khi truyền vào component. */
function parseOnChainDetail(value: unknown): SbtTokenOnChainDetail | null {
  if (!isRecord(value)) return null;
  if (
    !isNonNegativeSafeInteger(value.projectId)
    || !isNonNegativeSafeInteger(value.milestone)
    || !isNonNegativeSafeInteger(value.beneficiaryCount)
    || typeof value.gpsCoordinates !== 'string'
    || typeof value.imageCID !== 'string'
    || !isValidDateString(value.mintedAt)
    || (value.tokenStatus !== null && !isTokenStatus(value.tokenStatus))
  ) {
    return null;
  }

  return {
    projectId: value.projectId,
    milestone: value.milestone,
    beneficiaryCount: value.beneficiaryCount,
    gpsCoordinates: value.gpsCoordinates,
    imageCID: value.imageCID,
    mintedAt: value.mintedAt,
    tokenStatus: value.tokenStatus
  };
}

/** Parse phần off-chain detail, bao gồm field lifecycle đã được BE allowlist public. */
function parseOffChainDetail(value: unknown): SbtTokenOffChainDetail | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (
    typeof value.projectId !== 'string'
    || !isNonNegativeSafeInteger(value.milestone)
    || !isNonNegativeSafeInteger(value.beneficiaryCount)
    || typeof value.imageCid !== 'string'
    || typeof value.tokenUri !== 'string'
    || (value.confirmedAt !== null && !isValidDateString(value.confirmedAt))
    || !isNullableString(value.transactionHash)
    || !isNullableString(value.tokenStatusReason)
  ) {
    return null;
  }

  return {
    projectId: value.projectId,
    milestone: value.milestone,
    beneficiaryCount: value.beneficiaryCount,
    imageCid: value.imageCid,
    tokenUri: value.tokenUri,
    confirmedAt: value.confirmedAt,
    transactionHash: value.transactionHash,
    tokenStatusReason: value.tokenStatusReason
  };
}

/** Parse detail response envelope và reject shape sai thay vì để page crash ở runtime. */
function parseTokenDetailResponse(value: unknown): SbtTokenDetailResponse | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const data = value.data;
  const onChain = parseOnChainDetail(data.onChain);
  const offChain = parseOffChainDetail(data.offChain);
  if (
    !isNonNegativeSafeInteger(data.onChainTokenId)
    || !onChain
    || data.offChain !== null && !offChain
    || !isNullableString(data.imageGatewayUrl)
    || !Object.prototype.hasOwnProperty.call(data, 'ipfsMetadata')
    || !isNullableString(data.ipfsError)
    || typeof data.cached !== 'boolean'
  ) {
    return null;
  }

  return {
    onChainTokenId: data.onChainTokenId,
    onChain,
    offChain,
    imageGatewayUrl: data.imageGatewayUrl,
    ipfsMetadata: data.ipfsMetadata,
    ipfsError: data.ipfsError,
    cached: data.cached
  };
}

/** Tải detail token và phân biệt 404/400 với lỗi hạ tầng để giữ UX đúng theo plan. */
async function fetchTokenDetail(tokenId: string): Promise<TokenDetailFetchResult> {
  const response = await fetchServerApiResponse(`/api/sbt/token/${encodeURIComponent(tokenId)}`);
  if (!response) return { kind: 'error' };
  if (response.status === 400 || response.status === 404) return { kind: 'not-found' };
  if (response.status < 200 || response.status >= 300) return { kind: 'error' };

  const detail = parseTokenDetailResponse(response.body);
  return detail ? { kind: 'ok', detail } : { kind: 'error' };
}

/** Parse một entry milestone public từ API project trước khi đưa vào timeline. */
function parseGalleryEntry(value: unknown): ImpactSbtGalleryEntry | null {
  if (!isRecord(value)) return null;
  if (
    (value.onChainTokenId !== null && !isNonNegativeSafeInteger(value.onChainTokenId))
    || typeof value.projectId !== 'string'
    || (value.projectName !== null && typeof value.projectName !== 'string')
    || !isNonNegativeSafeInteger(value.milestone)
    || !isNonNegativeSafeInteger(value.beneficiaryCount)
    || typeof value.imageCid !== 'string'
    || !isNullableString(value.imageGatewayUrl)
    || (value.onChainTokenStatus !== null && !isTokenStatus(value.onChainTokenStatus))
    || (value.confirmedAt !== null && !isValidDateString(value.confirmedAt))
  ) {
    return null;
  }

  return {
    onChainTokenId: value.onChainTokenId,
    projectId: value.projectId,
    projectName: value.projectName,
    milestone: value.milestone,
    beneficiaryCount: value.beneficiaryCount,
    imageCid: value.imageCid,
    imageGatewayUrl: value.imageGatewayUrl,
    onChainTokenStatus: value.onChainTokenStatus,
    confirmedAt: value.confirmedAt
  };
}

/** Parse pagination và entries của API project với các invariant số nguyên public. */
function parseGalleryResponse(value: unknown): ImpactSbtGalleryResponse | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const data = value.data;
  if (!Array.isArray(data.entries) || !isRecord(data.pagination)) return null;

  const entries = data.entries.map(parseGalleryEntry);
  const pagination = data.pagination;
  if (
    entries.some((entry): entry is null => entry === null)
    || !isNonNegativeSafeInteger(pagination.page)
    || pagination.page < 1
    || !isNonNegativeSafeInteger(pagination.limit)
    || !isNonNegativeSafeInteger(pagination.total)
    || !isNonNegativeSafeInteger(pagination.totalPages)
  ) {
    return null;
  }

  return {
    entries: entries as ImpactSbtGalleryEntry[],
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: pagination.total,
      totalPages: pagination.totalPages
    }
  };
}

/** Tải một trang milestone public; lỗi phụ chỉ làm ẩn timeline chứ không fail detail page. */
async function fetchMilestonePage(projectId: string, page: number): Promise<ImpactSbtGalleryResponse | null> {
  const query = `?limit=${MILESTONE_PAGE_SIZE}&page=${page}`;
  const response = await fetchServerApiResponse(
    `/api/sbt/project/${encodeURIComponent(projectId)}${query}`,
    MILESTONE_API_REQUEST_TIMEOUT_MS
  );
  if (!response || response.status < 200 || response.status >= 300) return null;
  return parseGalleryResponse(response.body);
}

/** Ghép tối đa 5 trang milestone song song và sort tăng dần theo số milestone. */
async function fetchMilestoneEntries(projectId: string): Promise<ImpactSbtGalleryEntry[] | null> {
  // Cần đọc trang đầu để biết totalPages; chỉ các trang còn lại mới độc lập và chạy song song.
  const firstPage = await fetchMilestonePage(projectId, 1);
  if (!firstPage) return null;

  const totalPages = Math.min(firstPage.pagination.totalPages, MAX_MILESTONE_PAGES);
  const additionalPages = Array.from(
    { length: Math.max(totalPages - 1, 0) },
    (_, index) => index + 2
  );
  const pages = await Promise.all(additionalPages.map(page => fetchMilestonePage(projectId, page)));
  if (pages.some(page => page === null)) return null;

  return [firstPage, ...pages].flatMap(page => page?.entries ?? []).sort(
    (left, right) => left.milestone - right.milestone
  );
}

/** Render timeline từ dữ liệu đã resolve ở server để không trả Promise vào React client renderer. */
function SbtMilestoneSection({
  detail,
  milestoneEntries
}: {
  detail: SbtTokenDetailResponse;
  milestoneEntries: ImpactSbtGalleryEntry[] | null;
}): ReactElement {
  if (detail.offChain === null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Milestone</h2>
        <p className="mt-3 text-sm text-slate-600">
          Milestone: {detail.onChain.milestone} (không có dữ liệu timeline chi tiết)
        </p>
      </div>
    );
  }

  if (milestoneEntries === null) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        Không tải được danh sách milestone.
      </div>
    );
  }

  return <SbtMilestoneTimeline entries={milestoneEntries} currentTokenId={detail.onChainTokenId} />;
}

/** Render trang detail SBT public với các trạng thái 404, lỗi hạ tầng và timeline degrade độc lập. */
export default async function SbtTokenPage({ params }: SbtTokenPageProps): Promise<ReactElement> {
  const tokenDetailResult = await fetchTokenDetail(params.tokenId);
  if (tokenDetailResult.kind === 'not-found') notFound();
  if (tokenDetailResult.kind === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
        <section className="w-full max-w-lg rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-bold text-slate-900">Không tải được SBT</h1>
          <p className="mt-3 text-sm text-slate-600">Vui lòng thử lại sau.</p>
          <Link
            href={`/impact-gallery/${encodeURIComponent(params.tokenId)}`}
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-emerald-600 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            Thử lại
          </Link>
        </section>
      </main>
    );
  }

  const { detail } = tokenDetailResult;
  const milestoneEntries = detail.offChain
    ? await fetchMilestoneEntries(detail.offChain.projectId)
    : null;
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-6xl">
        <header className="mb-8 space-y-3">
          <Link href="/impact-gallery" className="text-sm font-semibold text-cyan-700 hover:text-cyan-900">
            ← Về Impact NFT Gallery
          </Link>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-700">On-chain impact</p>
          <h1 className="text-3xl font-bold text-slate-900">SBT #{detail.onChainTokenId}</h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-600">Chi tiết minh chứng tác động được ghi nhận trên blockchain.</p>
        </header>

        <SbtStatusBanner
          tokenStatus={detail.onChain.tokenStatus}
          reason={detail.offChain?.tokenStatusReason ?? null}
        />

        <section className="grid gap-6 md:grid-cols-2">
          <div>
            <SbtImage
              imageCid={detail.onChain.imageCID}
              imageGatewayUrl={detail.imageGatewayUrl}
              alt={`Impact SBT #${detail.onChainTokenId}`}
            />
            <SbtMetadataPanel
              onChainTokenId={detail.onChainTokenId}
              onChain={detail.onChain}
              offChain={detail.offChain}
              imageGatewayUrl={detail.imageGatewayUrl}
              ipfsMetadata={detail.ipfsMetadata}
              ipfsError={detail.ipfsError}
            />
            <SbtPolygonScanLink transactionHash={detail.offChain?.transactionHash ?? null} />
          </div>

          <SbtLocationMap
            gpsCoordinates={detail.onChain.gpsCoordinates}
            fallbackProjectId={String(detail.onChain.projectId)}
            tokenId={detail.onChainTokenId}
          />
        </section>

        <section className="mt-6">
          <SbtMilestoneSection detail={detail} milestoneEntries={milestoneEntries} />
        </section>
      </div>
    </main>
  );
}
