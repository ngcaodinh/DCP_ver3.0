import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BatchUploadModal } from '@/app/components/organizationFeedback/BatchUploadModal';
import { MAX_BATCH_ROWS, MAX_UPLOAD_SIZE_BYTES } from '@/app/components/organizationFeedback/types';

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path
}));

let responseBody: unknown;
let responseStatus = 200;
let lastRequest: FakeXMLHttpRequest | null = null;

class FakeXMLHttpRequest {
  public readonly upload = { addEventListener: vi.fn() };
  public readonly headers: Record<string, string> = {};
  public status = responseStatus;
  public responseText = '';
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  public open = vi.fn();

  public setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  public send = vi.fn(() => {
    this.status = responseStatus;
    this.responseText = JSON.stringify(responseBody);
    this.onload?.();
  });
}

function validFile(): File {
  return new File([
    'projectId,beneficiaryName,rating,comment,submittedAt\n',
    'DA-1,Nguyen A,5,Good,2026-08-01T00:00:00Z'
  ], 'feedback.csv', { type: 'text/csv' });
}

function renderModal(onNotice = vi.fn()) {
  return render(
    <BatchUploadModal
      isOpen
      accessToken="token-1"
      onClose={vi.fn()}
      onUploaded={vi.fn()}
      onUnauthorized={vi.fn()}
      onForbidden={vi.fn()}
      onNotice={onNotice}
    />
  );
}

describe('BatchUploadModal', () => {
  beforeEach(() => {
    responseStatus = 200;
    responseBody = {
      success: true,
      data: { success: 1, failed: 0, errors: [], inputType: 'csv' }
    };
    lastRequest = null;
    vi.stubGlobal('XMLHttpRequest', class extends FakeXMLHttpRequest {
      public constructor() {
        super();
        lastRequest = this;
      }
    });
  });

  it('preview file trước upload và không đặt Content-Type multipart thủ công', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [validFile()] } });

    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));
    await waitFor(() => expect(screen.getByText('Đã tiếp nhận 1 phản hồi.')).toBeInTheDocument());

    expect(lastRequest?.headers.Authorization).toBe('Bearer token-1');
    expect(lastRequest?.headers['Content-Type']).toBeUndefined();
  });

  it('xử lý duplicate bằng cảnh báo thay vì bảng lỗi', async () => {
    const onNotice = vi.fn();
    responseBody = { success: true, data: { success: 0, failed: 0, errors: [], isDuplicate: true, inputType: 'csv' } };
    renderModal(onNotice);
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [validFile()] } });
    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('đã được tải lên trước đó'), 'warning'));
    expect(screen.queryByText(/Dòng \d+:/)).not.toBeInTheDocument();
  });

  it('chặn file vượt 5MB ngay tại client', async () => {
    renderModal();
    const largeFile = new File([new Uint8Array(MAX_UPLOAD_SIZE_BYTES + 1)], 'large.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [largeFile] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('5MB');
    expect(lastRequest).toBeNull();
  });

  it('chặn extension không phải CSV ngay tại client', async () => {
    renderModal();
    const invalidFile = new File(['not csv'], 'feedback.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [invalidFile] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('File phải có định dạng CSV');
    expect(lastRequest).toBeNull();
  });

  it.each(['application/vnd.ms-excel', 'application/octet-stream'])('chấp nhận MIME CSV do Excel/browser trả về: %s', async (mimeType) => {
    renderModal();
    const excelCsvFile = new File([
      'projectId,beneficiaryName,rating,comment,submittedAt\n',
      'DA-1,Nguyen A,5,Good,2026-08-01T00:00:00Z'
    ], 'feedback.csv', { type: mimeType });
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [excelCsvFile] } });

    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    expect(screen.queryByText('File phải có định dạng CSV.')).not.toBeInTheDocument();
  });

  it('chặn batch vượt 1000 dòng trước khi tạo request', async () => {
    renderModal();
    const rows = Array.from(
      { length: MAX_BATCH_ROWS + 1 },
      (_, index) => `DA-${index},Name,5,Good,2026-08-01T00:00:00Z`
    );
    const oversizedBatch = new File([
      'projectId,beneficiaryName,rating,comment,submittedAt\n',
      rows.join('\n')
    ], 'feedback.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [oversizedBatch] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('Tối đa 1000 dòng');
    expect(lastRequest).toBeNull();
  });

  it('map lỗi HTTP 429 theo rate limit và giữ modal mở', async () => {
    responseStatus = 429;
    responseBody = { success: false, message: 'Too many requests', errorCode: 'RATE_LIMITED' };
    renderModal();
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [validFile()] } });
    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Đã vượt 10 lượt tải lên mỗi phút');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each([
    [401, 'onUnauthorized'],
    [403, 'onForbidden']
  ] as const)('điều hướng đúng khi API upload trả %s', async (statusCode, callbackName) => {
    responseStatus = statusCode;
    responseBody = { success: false, message: 'auth error', errorCode: statusCode === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN' };
    const callback = vi.fn();
    render(
      <BatchUploadModal
        isOpen
        accessToken="token-1"
        onClose={vi.fn()}
        onUploaded={vi.fn()}
        onUnauthorized={callbackName === 'onUnauthorized' ? callback : vi.fn()}
        onForbidden={callbackName === 'onForbidden' ? callback : vi.fn()}
        onNotice={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [validFile()] } });
    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));

    await waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('auth error')).not.toBeInTheDocument();
  });

  it('hiển thị thành công một phần và danh sách lỗi từng dòng', async () => {
    responseBody = {
      success: true,
      data: {
        success: 1,
        failed: 1,
        errors: [{ rowNumber: 2, reason: 'Rating must be 1-5' }],
        inputType: 'csv'
      }
    };
    renderModal();
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [validFile()] } });
    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));

    expect(await screen.findByText('Đã tiếp nhận một phần feedback.')).toBeInTheDocument();
    expect(screen.getByText('Dòng 2: Rating must be 1-5')).toBeInTheDocument();
  });

  it('từ chối response 200 sai contract bằng lỗi thân thiện', async () => {
    responseBody = { success: true, data: { success: 1 } };
    renderModal();
    fireEvent.change(screen.getByLabelText('Chọn file CSV feedback'), { target: { files: [validFile()] } });
    await waitFor(() => expect(screen.getByText('DA-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Tải lên' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Phản hồi từ server không hợp lệ.');
  });
});
