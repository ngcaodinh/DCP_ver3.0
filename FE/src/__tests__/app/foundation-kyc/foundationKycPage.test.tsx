import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockBuildApiUrl, mockFetchApi, mockConvertFileToBase64 } = vi.hoisted(() => ({
  mockBuildApiUrl: vi.fn((pathname: string) => `http://api.test${pathname}`),
  mockFetchApi: vi.fn(),
  mockConvertFileToBase64: vi.fn()
}));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: mockBuildApiUrl,
  fetchApi: mockFetchApi
}));

vi.mock('@/app/utils/fileToBase64', () => ({
  convertFileToBase64: mockConvertFileToBase64
}));

import FoundationKycForm from '@/app/components/foundationKyc/FoundationKycForm';

/** Điền các field bắt buộc để test chỉ tập trung vào flow xác nhận và submit. */
function fillValidForm(): void {
  fireEvent.change(screen.getByLabelText('Tên pháp nhân'), { target: { value: 'Quỹ An Tâm' } });
  fireEvent.change(screen.getByLabelText('Số đăng ký pháp nhân'), { target: { value: 'ABC-12345' } });
  fireEvent.change(screen.getByLabelText('Mã số thuế'), { target: { value: '0101234567' } });
  fireEvent.change(screen.getByLabelText('Mô tả pháp nhân'), { target: { value: 'Quỹ hỗ trợ cộng đồng trong các chương trình an sinh.' } });
  fireEvent.change(screen.getByLabelText('Tên ngân hàng'), { target: { value: 'MB' } });
  fireEvent.change(screen.getByLabelText('Số tài khoản'), { target: { value: '1234567890' } });
  fireEvent.change(screen.getByLabelText('Tên chủ tài khoản'), { target: { value: 'quỹ An Tâm đà nẵng' } });
  fireEvent.change(screen.getByLabelText('Chi nhánh (nếu có)'), { target: { value: 'Ha Noi' } });
  const legalDocument = new File(['%PDF-1.4'], 'license.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText(/Giấy tờ pháp lý/), { target: { files: [legalDocument] } });
}

describe('public foundation KYC form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConvertFileToBase64.mockResolvedValue('JVBERi0xLjQK');
    mockFetchApi.mockResolvedValue({
      data: { submissionId: 'foundation-001', version: 1, status: 'PENDING_REVIEW' }
    });
  });

  it('requires confirmation before sending and posts the exact public endpoint payload', async () => {
    render(<FoundationKycForm recaptchaSiteKey="" />);
    fillValidForm();

    fireEvent.submit(screen.getByRole('button', { name: 'Kiểm tra và tiếp tục' }).closest('form') as HTMLFormElement);
    expect(screen.getByText('Xác nhận thông tin trước khi gửi')).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận và gửi hồ sơ' }));

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledTimes(1));
    expect(mockBuildApiUrl).toHaveBeenCalledWith('/api/foundation-kyc/submit');
    const requestBody = JSON.parse(mockFetchApi.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      organizationName: 'Quỹ An Tâm',
      legalRegistrationNumber: 'ABC-12345',
      taxIdentificationNumber: '0101234567',
      bankName: 'MB',
      accountHolderName: 'QUY AN TAM DA NANG',
      recaptchaToken: 'development-bypass',
      legalDocument: {
        fileName: 'license.pdf',
        mimeType: 'application/pdf',
        base64Content: 'JVBERi0xLjQK'
      }
    });
    expect(screen.getByText('Đã tiếp nhận hồ sơ')).toBeInTheDocument();
  });

  it('maps a stable backend error code to a safe user-facing message', async () => {
    mockFetchApi.mockRejectedValue({ errorCode: 'DUPLICATE_SUBMISSION' });
    render(<FoundationKycForm recaptchaSiteKey="" />);
    fillValidForm();

    fireEvent.submit(screen.getByRole('button', { name: 'Kiểm tra và tiếp tục' }).closest('form') as HTMLFormElement);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận và gửi hồ sơ' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('đang chờ Cơ quan giám sát duyệt'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('DUPLICATE_SUBMISSION');
  });

  it('shows inline validation errors for incomplete form fields', () => {
    render(<FoundationKycForm recaptchaSiteKey="" />);

    fireEvent.submit(screen.getByRole('button', { name: 'Kiểm tra và tiếp tục' }).closest('form') as HTMLFormElement);

    expect(screen.getByText('Tên pháp nhân phải có ít nhất 3 ký tự.')).toBeInTheDocument();
    expect(screen.getByText('Số đăng ký pháp nhân không hợp lệ.')).toBeInTheDocument();
    expect(screen.getByText('Mã số thuế phải gồm 10 hoặc 13 chữ số.')).toBeInTheDocument();
    expect(screen.getByText('Vui lòng chọn một ngân hàng trong danh sách payOS hỗ trợ.')).toBeInTheDocument();
    expect(screen.getByText('Vui lòng chọn giấy tờ pháp lý.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Tên ngân hàng' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('limits bank options to the PayOS-linked business bank list', () => {
    render(<FoundationKycForm recaptchaSiteKey="" />);

    const bankSelect = screen.getByRole('combobox', { name: 'Tên ngân hàng' });
    expect(bankSelect.querySelectorAll('option')).toHaveLength(7);
    expect(screen.getByRole('option', { name: 'MB' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Vietcombank' })).not.toBeInTheDocument();
  });
});
