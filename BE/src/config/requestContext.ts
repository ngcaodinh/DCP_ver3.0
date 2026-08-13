import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Context gắn với một HTTP request hoặc một background worker run.
 * Mục đích: truyền correlation ID và user ID qua các tầng async mà không đổi signature logger.
 */
export interface RequestContext {
  /** Correlation ID HTTP; không phải disbursement request ID nghiệp vụ. */
  requestId: string;
  /** User ID sau khi xác thực; null trước hoặc ngoài request scope. */
  userId: string | null;
  /** Tên worker khi context được tạo cho background execution. */
  workerName?: string;
  /** Correlation ID ổn định cho một worker run. */
  workerRunId?: string;
  /** ID job nếu execution được kích hoạt từ queue. */
  jobId?: string | number;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Chạy callback trong một request context mới.
 * Mục đích: giữ context xuyên suốt chuỗi promise/timer thuộc request hiện tại.
 */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(context, callback);
}

/**
 * Chạy một background execution trong correlation context riêng.
 * @param workerName Tên worker để phân biệt các nhóm log.
 * @param callback Hàm thực thi worker, có thể trả Promise.
 * @param jobId ID job của queue nếu có.
 * @returns Kết quả của hàm thực thi.
 */
export function runWithWorkerContext<T>(
  workerName: string,
  callback: () => T,
  jobId?: string | number
): T {
  const workerRunId = `${workerName}:${randomUUID()}`;
  const context: RequestContext = {
    requestId: workerRunId,
    userId: null,
    workerName,
    workerRunId
  };
  if (jobId !== undefined) context.jobId = jobId;

  return requestContextStorage.run(context, callback);
}

/**
 * Lấy context hiện tại nếu đang ở trong request scope.
 * Mục đích: cho logger và các integration observability đọc metadata hiện hành.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Lấy correlation ID hiện tại.
 * Mục đích: trả null ngoài request scope thay vì ném lỗi cho worker/bootstrap.
 */
export function getRequestId(): string | null {
  return requestContextStorage.getStore()?.requestId ?? null;
}

/**
 * Gắn user ID vào context hiện tại sau khi auth middleware xác thực thành công.
 * Mục đích: các log sau auth có thể truy vấn userId mà không truyền thủ công.
 */
export function setRequestUser(userId: string): void {
  const store = requestContextStorage.getStore();
  if (store) {
    store.userId = userId;
  }
}
