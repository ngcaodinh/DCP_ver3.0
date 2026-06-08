const ipfsGatewayBaseUrl = 'https://gateway.pinata.cloud/ipfs';

type ResolveIpfsPreviewKindInput = {
  mimeType?: string | null;
  fileName?: string | null;
  contentType?: string | null;
};

type IpfsPreviewKind = 'image' | 'pdf' | 'unknown';

const contentTypeCacheByCid = new Map<string, string | null>();
const pendingContentTypeRequestByCid = new Map<string, Promise<string | null>>();

/** Hàm kiểm tra CID IPFS có đúng định dạng hỗ trợ hay không. Mục đích: chặn render link rác và giảm rủi ro open redirect. */
export function isValidIpfsCid(cidValue: string): boolean {
  const normalizedCidValue = cidValue.trim();
  const cidVersionZeroRegex = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
  const cidVersionOneRegex = /^b[a-z2-7]{20,}$/;
  return cidVersionZeroRegex.test(normalizedCidValue) || cidVersionOneRegex.test(normalizedCidValue);
}

/** Hàm tạo URL gateway IPFS từ CID hợp lệ. Mục đích: chuẩn hóa duy nhất một nơi build link IPFS cho toàn bộ FE. */
export function buildIpfsGatewayUrl(cidValue: string): string {
  const normalizedCidValue = cidValue.trim();

  if (!isValidIpfsCid(normalizedCidValue)) {
    return '';
  }

  return `${ipfsGatewayBaseUrl}/${encodeURIComponent(normalizedCidValue)}`;
}

/** Hàm suy luận loại preview từ mime, tên file hoặc content-type. Mục đích: ưu tiên dữ liệu backend trước, rồi mới fallback qua thông tin khác. */
export function resolveIpfsPreviewKind({ mimeType, fileName, contentType }: ResolveIpfsPreviewKindInput): IpfsPreviewKind {
  const normalizedMimeType = (mimeType ?? '').trim().toLowerCase();
  const normalizedFileName = (fileName ?? '').trim().toLowerCase();
  const normalizedContentType = (contentType ?? '').trim().toLowerCase();

  // Ghi chú logic phức tạp: thứ tự ưu tiên bám sát yêu cầu nghiệp vụ để tránh HEAD request không cần thiết khi backend đã cung cấp mimeType đáng tin cậy.
  if (normalizedMimeType.startsWith('image/') || normalizedContentType.startsWith('image/')) {
    return 'image';
  }

  if (normalizedMimeType === 'application/pdf' || normalizedContentType === 'application/pdf') {
    return 'pdf';
  }

  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(normalizedFileName)) {
    return 'image';
  }

  if (/\.pdf$/i.test(normalizedFileName)) {
    return 'pdf';
  }

  return 'unknown';
}

/** Hàm đọc Content-Type từ gateway theo kiểu best effort. Mục đích: hỗ trợ fallback preview khi backend không trả mimeType hoặc tên file. */
export async function getIpfsContentType(cidValue: string): Promise<string | null> {
  const normalizedCidValue = cidValue.trim();

  if (!isValidIpfsCid(normalizedCidValue)) {
    return null;
  }

  if (contentTypeCacheByCid.has(normalizedCidValue)) {
    return contentTypeCacheByCid.get(normalizedCidValue) ?? null;
  }

  const pendingRequest = pendingContentTypeRequestByCid.get(normalizedCidValue);
  if (pendingRequest) {
    return pendingRequest;
  }

  const gatewayUrl = buildIpfsGatewayUrl(normalizedCidValue);
  const requestPromise = fetch(gatewayUrl, {
    method: 'HEAD',
    cache: 'force-cache'
  })
    .then(response => {
      if (!response.ok) {
        return null;
      }

      return response.headers.get('content-type');
    })
    .catch(() => null)
    .finally(() => {
      pendingContentTypeRequestByCid.delete(normalizedCidValue);
    });

  pendingContentTypeRequestByCid.set(normalizedCidValue, requestPromise);

  const contentTypeValue = await requestPromise;
  contentTypeCacheByCid.set(normalizedCidValue, contentTypeValue);
  return contentTypeValue;
}
