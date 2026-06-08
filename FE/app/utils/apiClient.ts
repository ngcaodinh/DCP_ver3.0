export type ApiErrorDetail = {
  field: string;
  message: string;
};

export type ApiErrorResponse = {
  success: false;
  message: string;
  errorCode: string;
  details?: ApiErrorDetail[];
  correlationId?: string | null;
  statusCode?: number;
};

export type ApiSuccessResponse<T> = {
  success: true;
  message: string;
  data: T;
  correlationId?: string | null;
};

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

/** Hàm xây dựng URL API đầy đủ. Mục đích: đồng bộ base URL cho toàn bộ request từ frontend. */
export function buildApiUrl(pathname: string): string {
  if (!apiBaseUrl) {
    // #region agent debug log
    fetch('http://127.0.0.1:7710/ingest/fa15d132-717d-4b5a-8ef1-2fdf5f966e4c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'870f73'},body:JSON.stringify({sessionId:'870f73',location:'apiClient.ts:buildApiUrl',message:'H4: NEXT_PUBLIC_API_BASE_URL missing',data:{apiBaseUrl},timestamp:Date.now(),runId:'debug-run',hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    throw new Error('Thiếu cấu hình NEXT_PUBLIC_API_BASE_URL trong môi trường.');
  }

  const normalizedBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBaseUrl}${normalizedPathname}`;
}

/** Hàm parse response JSON an toàn. Mục đích: tránh lỗi runtime khi API trả body rỗng hoặc sai định dạng. */
export async function parseJsonSafely(response: Response): Promise<unknown> {
  const responseText = await response.text();
  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch (_error) {
    return null;
  }
}

/**
 * Hàm fetch API chuẩn hóa. Mục đích: trả về dữ liệu thành công hoặc throw payload lỗi chuẩn để UI xử lý.
 *
 * @param T - generic type cho data payload khi thành công
 * @param options.skipBodyValidation - nếu true, bỏ qua kiểm tra response body
 *                                    (dùng cho các endpoint trả 204 No Content không có body)
 */
export async function fetchApi<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: { skipBodyValidation?: boolean }
): Promise<ApiSuccessResponse<T>> {
  const response = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });

  const responseBody = await parseJsonSafely(response);

  if (!response.ok) {
    const defaultErrorResponse: ApiErrorResponse = {
      success: false,
      message: 'Không thể xử lý yêu cầu. Vui lòng thử lại.',
      errorCode: 'UNKNOWN_ERROR',
      details: []
    };

    if (responseBody && typeof responseBody === 'object') {
      throw {
        ...(responseBody as ApiErrorResponse),
        statusCode: response.status
      } as ApiErrorResponse;
    }

    throw {
      ...defaultErrorResponse,
      statusCode: response.status
    } as ApiErrorResponse;
  }

  // Endpoint trả 204 No Content không có body — trả về shape rỗng thay vì throw
  if (options?.skipBodyValidation) {
    return {
      success: true,
      message: '',
      data: {} as T,
      correlationId: null
    };
  }

  if (!responseBody || typeof responseBody !== 'object') {
    throw {
      success: false,
      message: 'Phản hồi từ server không hợp lệ.',
      errorCode: 'INVALID_RESPONSE',
      details: []
    } as ApiErrorResponse;
  }

  return responseBody as ApiSuccessResponse<T>;
}

