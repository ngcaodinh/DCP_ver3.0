'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactElement, type RefObject } from 'react';
import { buildApiUrl, type ApiErrorResponse } from '@/app/utils/apiClient';
import { downloadFeedbackCsvTemplate } from './csvTemplate';
import { CsvPreviewTable } from './CsvPreviewTable';
import { hasCsvPreviewErrors, parseCsvPreview } from './parseCsvPreview';
import {
  MAX_BATCH_ROWS,
  MAX_UPLOAD_SIZE_BYTES,
  UPLOAD_RATE_PER_MINUTE,
  type BatchUploadResult,
  type CsvPreviewResult
} from './types';

interface BatchUploadModalProps {
  isOpen: boolean;
  accessToken: string;
  onClose: () => void;
  onUploaded: (result: BatchUploadResult) => void;
  onUnauthorized: () => void;
  onForbidden: () => void;
  onNotice: (message: string, tone: 'success' | 'warning' | 'error' | 'info') => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

interface UploadProgressEvent extends Event {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

const UPLOAD_TIMEOUT_MS = 120_000;
const ALLOWED_CSV_MIME_TYPES = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/octet-stream'
] as const;

/** Kiểm tra object runtime trước khi dùng payload kết quả upload từ API. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Kiểm tra đủ shape kết quả batch để modal không crash khi server trả payload sai contract. */
function isBatchUploadResult(value: unknown): value is BatchUploadResult {
  if (!isRecord(value)) return false;
  if (typeof value.success !== 'number' || !Number.isInteger(value.success) || value.success < 0) return false;
  if (typeof value.failed !== 'number' || !Number.isInteger(value.failed) || value.failed < 0) return false;
  if (!Array.isArray(value.errors)) return false;
  if (!value.errors.every(error => (
    isRecord(error)
    && typeof error.rowNumber === 'number'
    && Number.isInteger(error.rowNumber)
    && error.rowNumber >= 1
    && typeof error.reason === 'string'
  ))) return false;
  if (value.flaggedCount !== undefined && (
    typeof value.flaggedCount !== 'number'
    || !Number.isInteger(value.flaggedCount)
    || value.flaggedCount < 0
  )) return false;
  if (value.inputType !== undefined && value.inputType !== 'csv' && value.inputType !== 'json') return false;
  return value.isDuplicate === undefined || typeof value.isDuplicate === 'boolean';
}

/** Lấy data envelope và từ chối response upload không đúng schema thay vì để UI lỗi runtime. */
function parseBatchUploadResult(responseBody: unknown): BatchUploadResult {
  const candidate = isRecord(responseBody) && 'data' in responseBody
    ? responseBody.data
    : responseBody;
  if (isBatchUploadResult(candidate)) return candidate;

  throw {
    success: false,
    message: 'Phản hồi từ server không hợp lệ.',
    errorCode: 'INVALID_RESPONSE',
    statusCode: 200
  } satisfies ApiErrorResponse;
}

/** Gửi multipart CSV bằng XHR để có tiến trình upload và không tự đặt Content-Type multipart. */
function uploadCsvFile(
  file: File,
  accessToken: string,
  onProgress: (percentage: number) => void
): Promise<BatchUploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', buildApiUrl('/api/feedback/batch'));
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    request.upload.addEventListener('progress', (event: Event) => {
      const progressEvent = event as UploadProgressEvent;
      if (progressEvent.lengthComputable && progressEvent.total > 0) {
        onProgress(Math.round((progressEvent.loaded / progressEvent.total) * 100));
      }
    });
    request.onerror = () => reject(new Error('Không thể kết nối tới máy chủ.'));
    request.onload = () => {
      let responseBody: unknown = null;
      try {
        responseBody = request.responseText ? JSON.parse(request.responseText) as unknown : null;
      } catch {
        responseBody = null;
      }

      if (request.status < 200 || request.status >= 300) {
        const errorPayload: ApiErrorResponse = responseBody && typeof responseBody === 'object'
          ? { ...(responseBody as ApiErrorResponse), statusCode: request.status }
          : {
              success: false,
              message: 'Không thể xử lý yêu cầu.',
              errorCode: 'UNKNOWN_ERROR',
              statusCode: request.status
            };
        reject(errorPayload);
        return;
      }

      if (!responseBody || typeof responseBody !== 'object') {
        reject({
          success: false,
          message: 'Phản hồi từ server không hợp lệ.',
          errorCode: 'INVALID_RESPONSE',
          statusCode: request.status
        } satisfies ApiErrorResponse);
        return;
      }

      resolve(parseBatchUploadResult(responseBody));
    };
    request.ontimeout = () => reject({
      success: false,
      message: 'Upload quá thời gian chờ. Vui lòng thử lại.',
      errorCode: 'UPLOAD_TIMEOUT',
      statusCode: 408
    } satisfies ApiErrorResponse);

    const formData = new FormData();
    formData.append('file', file);
    request.send(formData);
  });
}

/** Ánh xạ errorCode backend thành thông báo tiếng Việt có thể hành động ngay trong modal. */
function getUploadErrorMessage(error: unknown): string {
  const apiError = error as Partial<ApiErrorResponse>;
  if (apiError.statusCode === 400 && apiError.errorCode === 'MISSING_FILE') return 'Chưa chọn file.';
  if (apiError.statusCode === 400 && apiError.errorCode === 'INVALID_FILE_TYPE') return 'File phải có định dạng CSV.';
  if (apiError.statusCode === 400 && apiError.errorCode === 'INVALID_BODY_FORMAT') return 'Yêu cầu tải lên không đúng định dạng. Vui lòng thử lại.';
  if (apiError.statusCode === 400 && apiError.errorCode === 'FILE_TOO_LARGE') return 'File vượt quá 5MB.';
  if (apiError.statusCode === 400 && apiError.errorCode === 'BATCH_SIZE_EXCEEDED') return 'Tối đa 1000 dòng mỗi lần tải lên.';
  if (apiError.statusCode === 400 && apiError.errorCode === 'EMPTY_BATCH') return 'File không có dòng dữ liệu nào.';
  if (apiError.statusCode === 429) return `Đã vượt ${UPLOAD_RATE_PER_MINUTE} lượt tải lên mỗi phút. Thử lại sau ít phút.`;
  if (typeof apiError.statusCode === 'number' && apiError.statusCode >= 500) return 'Hệ thống đang bận. Vui lòng thử lại.';
  return typeof apiError.message === 'string' ? apiError.message : 'Không thể tải file. Vui lòng thử lại.';
}

/** Modal chọn file, preview, upload có tiến trình và hiển thị đầy đủ kết quả từng dòng. */
export function BatchUploadModal({
  isOpen,
  accessToken,
  onClose,
  onUploaded,
  onUnauthorized,
  onForbidden,
  onNotice,
  returnFocusRef
}: BatchUploadModalProps): ReactElement | null {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const [validationMessage, setValidationMessage] = useState('');
  const [uploadResult, setUploadResult] = useState<BatchUploadResult | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) return;
    setSelectedFile(null);
    setPreview(null);
    setValidationMessage('');
    setUploadResult(null);
    setUploadError('');
    setUploadProgress(0);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const focusReturnTarget = returnFocusRef?.current;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isUploading) {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      focusReturnTarget?.focus();
    };
  }, [isOpen, isUploading, onClose, returnFocusRef]);

  /** Đọc file local và tạo preview trước khi cho phép request upload. */
  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setUploadResult(null);
    setUploadError('');
    setValidationMessage('');
    setPreview(null);
    if (!file) return;

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      setValidationMessage('File vượt quá 5MB.');
      setSelectedFile(null);
      return;
    }
    const hasCsvExtension = file.name.toLowerCase().endsWith('.csv');
    if ((file.type && !(ALLOWED_CSV_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())) || !hasCsvExtension) {
      setValidationMessage('File phải có định dạng CSV.');
      setSelectedFile(null);
      return;
    }

    try {
      const parsedPreview = parseCsvPreview(await file.text());
      setSelectedFile(file);
      setPreview(parsedPreview);
      if (parsedPreview.totalRows > MAX_BATCH_ROWS) {
        setValidationMessage('Tối đa 1000 dòng mỗi lần tải lên.');
      } else if (hasCsvPreviewErrors(parsedPreview)) {
        setValidationMessage('Vui lòng sửa các ô đang báo lỗi trước khi tải lên.');
      }
    } catch {
      setSelectedFile(null);
      setValidationMessage('Không thể đọc file CSV.');
    }
  }, []);

  /** Gửi file đã preview, map lỗi auth và giữ modal mở cho lỗi có thể sửa/thử lại. */
  const handleUpload = useCallback(async (): Promise<void> => {
    if (!selectedFile || !preview || preview.totalRows > MAX_BATCH_ROWS || hasCsvPreviewErrors(preview)) return;
    setIsUploading(true);
    setUploadError('');
    setUploadProgress(0);
    try {
      const result = await uploadCsvFile(selectedFile, accessToken, setUploadProgress);
      setUploadProgress(100);
      setUploadResult(result);
      onUploaded(result);
      if (result.isDuplicate) {
        onNotice('File này đã được tải lên trước đó. Không có dòng nào bị ghi trùng.', 'warning');
      }
    } catch (error) {
      const apiError = error as Partial<ApiErrorResponse>;
      if (apiError.statusCode === 401) {
        onUnauthorized();
        return;
      }
      if (apiError.statusCode === 403) {
        onForbidden();
        return;
      }
      setUploadError(getUploadErrorMessage(error));
    } finally {
      setIsUploading(false);
    }
  }, [accessToken, onForbidden, onNotice, onUnauthorized, onUploaded, preview, selectedFile]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4 py-6" role="dialog" aria-modal="true" aria-labelledby="batch-upload-title">
      <div ref={dialogRef} className="flex max-h-[calc(100vh-3rem)] w-full max-w-6xl flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div>
            <h2 id="batch-upload-title" className="text-lg font-bold text-slate-900">Tải feedback theo lô</h2>
            <p className="mt-1 text-xs text-slate-500">Dùng submittedAt dạng ISO đầy đủ, ví dụ 2026-08-01T00:00:00Z.</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} disabled={isUploading} aria-label="Đóng cửa sổ tải feedback" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-50">
            <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <div className="flex flex-wrap items-center gap-2">
            <input type="file" accept=".csv,text/csv,application/csv,application/vnd.ms-excel,application/octet-stream" onChange={(event) => void handleFileChange(event)} aria-label="Chọn file CSV feedback" disabled={isUploading} />
            <button type="button" onClick={() => downloadFeedbackCsvTemplate()} disabled={isUploading} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Tải file CSV mẫu
            </button>
          </div>

          {validationMessage && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{validationMessage}</p>}
          {uploadError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{uploadError}</p>}
          {preview && <CsvPreviewTable preview={preview} />}

          {isUploading && (
            <div aria-label={`Tiến trình tải file ${uploadProgress}%`} className="space-y-1">
              <div className="h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-emerald-600 transition-all" style={{ width: `${uploadProgress}%` }} /></div>
              <p className="text-xs text-slate-500">Đang tải lên {uploadProgress}%</p>
            </div>
          )}

          {uploadResult && <UploadResultPanel result={uploadResult} />}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 p-5">
          <button type="button" onClick={onClose} disabled={isUploading} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">Đóng</button>
          <button type="button" onClick={() => void handleUpload()} disabled={isUploading || !selectedFile || !preview || Boolean(validationMessage) || hasCsvPreviewErrors(preview ?? { headers: [], rows: [], totalRows: 0, fileErrors: [], rowWarnings: [] })} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
            {isUploading ? 'Đang tải lên...' : 'Tải lên'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Hiển thị bốn trạng thái kết quả upload mà không coi duplicate là lỗi. */
function UploadResultPanel({ result }: { result: BatchUploadResult }): ReactElement {
  if (result.isDuplicate) {
    return <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">File này đã được tải lên trước đó. Không có dòng nào bị ghi trùng.</div>;
  }

  const isPartial = result.success > 0 && result.failed > 0;
  const isSuccess = result.success > 0 && result.failed === 0;
  return (
    <div className={`space-y-3 rounded-md border p-3 ${isSuccess ? 'border-emerald-200 bg-emerald-50' : isPartial ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
      <p className="text-sm font-semibold">{isSuccess ? `Đã tiếp nhận ${result.success} phản hồi.` : isPartial ? 'Đã tiếp nhận một phần feedback.' : 'Không có phản hồi nào được tiếp nhận.'}</p>
      <p className="text-xs">Thành công: <strong>{result.success}</strong> · Thất bại: <strong>{result.failed}</strong></p>
      {result.errors.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded border border-red-200 bg-white p-2 text-xs text-red-700">
          {result.errors.map(error => <p key={`${error.rowNumber}-${error.reason}`}>Dòng {error.rowNumber}: {error.reason}</p>)}
        </div>
      )}
    </div>
  );
}
