'use client';

import Link from 'next/link';
import { useState, type FormEvent, type ReactElement } from 'react';
import { buildApiUrl, fetchApi, type ApiErrorResponse } from '@/app/utils/apiClient';
import {
  FOUNDATION_KYC_ALLOWED_MIME_TYPES,
  FOUNDATION_KYC_MAX_FILE_SIZE_BYTES,
  FOUNDATION_KYC_SUPPORTED_BANKS,
  getFoundationKycErrorMessage
} from '@/app/constants/foundationKycForm';
import { convertFileToBase64 } from '@/app/utils/fileToBase64';

type FoundationKycFormProps = {
  recaptchaSiteKey: string;
};

type FoundationKycSubmissionResult = {
  submissionId: string | null;
  version: number;
  status: 'PENDING_REVIEW';
};

type FoundationKycFormValues = {
  organizationName: string;
  legalRegistrationNumber: string;
  taxIdentificationNumber: string;
  officialWebsite: string;
  organizationDescription: string;
  bankName: string;
  bankAccountNumber: string;
  accountHolderName: string;
  branchName: string;
  additionalEmail: string;
};

type FoundationKycFieldName = Exclude<keyof FoundationKycFormValues, 'additionalEmail'> | 'legalDocument';
type FoundationKycFieldErrors = Partial<Record<FoundationKycFieldName, string>>;

const FOUNDATION_KYC_CONTROL_CLASS = 'w-full rounded-xl border bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-4';

const INITIAL_FORM_VALUES: FoundationKycFormValues = {
  organizationName: '',
  legalRegistrationNumber: '',
  taxIdentificationNumber: '',
  officialWebsite: '',
  organizationDescription: '',
  bankName: '',
  bankAccountNumber: '',
  accountHolderName: '',
  branchName: '',
  additionalEmail: ''
};

declare global {
  interface Window {
    grecaptcha?: {
      ready(callback: () => void): void;
      execute(siteKey: string, options: { action: string }): Promise<string>;
    };
  }
}

/** Định dạng dung lượng file để người dùng xác nhận trước khi gửi. */
function formatFileSize(fileSizeInBytes: number): string {
  if (fileSizeInBytes >= 1024 * 1024) return `${(fileSizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(fileSizeInBytes / 1024).toFixed(1)} KB`;
}

/** Chuẩn hóa tên chủ tài khoản theo quy ước ngân hàng: viết hoa và bỏ dấu tiếng Việt. */
function normalizeAccountHolderName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[Đđ]/g, 'D')
    .toUpperCase();
}

/** Trả class điều khiển form theo trạng thái lỗi để người dùng nhận biết ngay field cần sửa. */
function getFoundationKycControlClass(hasError: boolean): string {
  return `${FOUNDATION_KYC_CONTROL_CLASS} ${hasError
    ? 'border-red-300 focus:border-red-500 focus:ring-red-100'
    : 'border-slate-200 focus:border-emerald-500 focus:ring-emerald-100'}`;
}

/** Kiểm tra từng field để hiển thị lỗi ngay cạnh thông tin chưa hợp lệ. */
function validateFoundationKycForm(values: FoundationKycFormValues, selectedFile: File | null): FoundationKycFieldErrors {
  const fieldErrors: FoundationKycFieldErrors = {};
  if (values.organizationName.trim().length < 3) fieldErrors.organizationName = 'Tên pháp nhân phải có ít nhất 3 ký tự.';
  if (!/^[A-Za-z0-9.\-\s]{5,50}$/.test(values.legalRegistrationNumber.trim())) fieldErrors.legalRegistrationNumber = 'Số đăng ký pháp nhân không hợp lệ.';
  if (!/^\d{10}(?:-?\d{3})?$/.test(values.taxIdentificationNumber.trim())) fieldErrors.taxIdentificationNumber = 'Mã số thuế phải gồm 10 hoặc 13 chữ số.';
  if (values.officialWebsite.trim()) {
    try {
      new URL(values.officialWebsite.trim());
    } catch {
      fieldErrors.officialWebsite = 'Website chính thức không hợp lệ.';
    }
  }
  if (values.organizationDescription.trim().length < 20) fieldErrors.organizationDescription = 'Mô tả pháp nhân phải có ít nhất 20 ký tự.';
  if (!FOUNDATION_KYC_SUPPORTED_BANKS.some(bank => bank.value === values.bankName)) fieldErrors.bankName = 'Vui lòng chọn một ngân hàng trong danh sách payOS hỗ trợ.';
  if (!/^[0-9]{8,20}$/.test(values.bankAccountNumber.trim())) fieldErrors.bankAccountNumber = 'Số tài khoản phải gồm 8–20 chữ số.';
  if (values.accountHolderName.trim().length < 2) fieldErrors.accountHolderName = 'Tên chủ tài khoản là bắt buộc.';
  if (!selectedFile) fieldErrors.legalDocument = 'Vui lòng chọn giấy tờ pháp lý.';
  else if (!(FOUNDATION_KYC_ALLOWED_MIME_TYPES as readonly string[]).includes(selectedFile.type)) fieldErrors.legalDocument = 'File phải là PDF, PNG hoặc JPG/JPEG.';
  else if (selectedFile.size > FOUNDATION_KYC_MAX_FILE_SIZE_BYTES) fieldErrors.legalDocument = 'File vượt quá giới hạn 5MB.';
  return fieldErrors;
}

/** Lấy token reCAPTCHA ngay trước request, hoặc dùng token dev khi captcha chưa bật ngoài production. */
async function getFoundationKycRecaptchaToken(recaptchaSiteKey: string): Promise<string> {
  if (!recaptchaSiteKey) return 'development-bypass';
  if (!window.grecaptcha) throw new Error('reCAPTCHA chưa sẵn sàng. Vui lòng thử lại.');

  return new Promise<string>((resolve, reject) => {
    window.grecaptcha?.ready(() => {
      window.grecaptcha?.execute(recaptchaSiteKey, { action: 'foundation_kyc_submit' })
        .then(resolve)
        .catch(() => reject(new Error('Không thể lấy token reCAPTCHA.')));
    });
  });
}

/** Đọc errorCode từ object thrown của fetchApi mà không dùng type assertion rộng. */
function getApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const errorCode = (error as Partial<ApiErrorResponse>).errorCode;
  return typeof errorCode === 'string' ? errorCode : undefined;
}

/** Form một chiều cho pháp nhân đại diện, có bước xác nhận để giảm rủi ro khóa nhầm số đăng ký. */
export default function FoundationKycForm({ recaptchaSiteKey }: FoundationKycFormProps): ReactElement {
  const [formValues, setFormValues] = useState<FoundationKycFormValues>(INITIAL_FORM_VALUES);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FoundationKycFieldErrors>({});
  const [submissionResult, setSubmissionResult] = useState<FoundationKycSubmissionResult | null>(null);

  /** Cập nhật một field form theo tên field đã được type-safe. */
  function updateFormValue(field: keyof FoundationKycFormValues, value: string): void {
    setFormValues(previousValues => ({ ...previousValues, [field]: value }));
    setFieldErrors(previousErrors => {
      if (field === 'additionalEmail' || !previousErrors[field]) return previousErrors;
      const nextErrors = { ...previousErrors };
      delete nextErrors[field];
      return nextErrors;
    });
    setErrorMessage('');
  }

  /** Cập nhật field và chuẩn hóa riêng tên chủ tài khoản ngay trong lúc người dùng nhập. */
  function handleFormValueChange(field: keyof FoundationKycFormValues, value: string): void {
    updateFormValue(field, field === 'accountHolderName' ? normalizeAccountHolderName(value) : value);
  }

  /** Kiểm tra một field khi người dùng rời khỏi ô nhập để phản hồi lỗi đúng vị trí. */
  function handleFieldBlur(field: FoundationKycFieldName): void {
    const nextFieldError = validateFoundationKycForm(formValues, selectedFile)[field];
    setFieldErrors(previousErrors => ({
      ...previousErrors,
      ...(nextFieldError ? { [field]: nextFieldError } : {})
    }));
  }

  /** Nhận file duy nhất và chặn sớm loại/dung lượng không hợp lệ. */
  function handleFileChange(file: File | undefined): void {
    if (!file) {
      setFieldErrors(previousErrors => ({ ...previousErrors, legalDocument: 'Vui lòng chọn giấy tờ pháp lý.' }));
      return;
    }
    if (!(FOUNDATION_KYC_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      setSelectedFile(null);
      setFieldErrors(previousErrors => ({ ...previousErrors, legalDocument: 'File phải là PDF, PNG hoặc JPG/JPEG.' }));
      return;
    }
    if (file.size > FOUNDATION_KYC_MAX_FILE_SIZE_BYTES) {
      setSelectedFile(null);
      setFieldErrors(previousErrors => ({ ...previousErrors, legalDocument: 'File vượt quá giới hạn 5MB.' }));
      return;
    }
    setErrorMessage('');
    setFieldErrors(previousErrors => {
      const nextErrors = { ...previousErrors };
      delete nextErrors.legalDocument;
      return nextErrors;
    });
    setSelectedFile(file);
  }

  /** Chuyển form sang bước xác nhận sau khi client validation thành công. */
  function handlePrepareSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextFieldErrors = validateFoundationKycForm(formValues, selectedFile);
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) {
      setErrorMessage('Vui lòng kiểm tra các trường được đánh dấu trước khi tiếp tục.');
      return;
    }
    setErrorMessage('');
    setIsConfirming(true);
  }

  /** Gửi payload sau xác nhận, reset dữ liệu form ngay khi thành công. */
  async function handleConfirmedSubmit(): Promise<void> {
    if (!selectedFile || isSubmitting) return;
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const [base64Content, recaptchaToken] = await Promise.all([
        convertFileToBase64(selectedFile),
        getFoundationKycRecaptchaToken(recaptchaSiteKey)
      ]);
      const response = await fetchApi<FoundationKycSubmissionResult>(
        buildApiUrl('/api/foundation-kyc/submit'),
        {
          method: 'POST',
          body: JSON.stringify({
            ...formValues,
            officialWebsite: formValues.officialWebsite.trim(),
            branchName: formValues.branchName.trim(),
            legalDocument: {
              fileName: selectedFile.name,
              mimeType: selectedFile.type,
              base64Content
            },
            recaptchaToken
          })
        }
      );
      setSubmissionResult(response.data);
      setFormValues(INITIAL_FORM_VALUES);
      setSelectedFile(null);
      setFieldErrors({});
      setIsConfirming(false);
    } catch (error) {
      const errorCode = getApiErrorCode(error);
      setErrorMessage(getFoundationKycErrorMessage(errorCode));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (submissionResult) {
    return (
      <section className="mx-auto w-full max-w-6xl overflow-hidden rounded-[2rem] border border-emerald-100 bg-white shadow-[0_24px_80px_rgba(15,118,110,0.12)]" aria-live="polite">
        <div className="grid lg:grid-cols-[0.75fr_1.25fr]">
          <div className="relative overflow-hidden bg-[#0b6558] p-7 text-white sm:p-10 lg:p-12">
            <div className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-emerald-300/20" />
            <div className="absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-cyan-300/10" />
            <p className="relative text-xs font-bold uppercase tracking-[0.22em] text-emerald-100">DCP · Foundation KYC</p>
            <h1 className="relative mt-5 text-3xl font-bold leading-tight sm:text-4xl">Hồ sơ đã được tiếp nhận</h1>
            <p className="relative mt-4 text-sm leading-7 text-emerald-50">
              Cảm ơn Quỹ đã cung cấp thông tin. Hồ sơ sẽ được Cơ quan giám sát kiểm tra trước khi xác minh tài khoản nhận quyên góp.
            </p>
            <div className="relative mt-8 rounded-2xl border border-white/15 bg-white/10 p-4 text-sm text-emerald-50">
              <p className="font-semibold text-white">Lưu ý quan trọng</p>
              <p className="mt-2 leading-6">Đây là cổng nộp một lần. Nếu hồ sơ bị từ chối, Quỹ vui lòng liên hệ Cơ quan giám sát để được hỗ trợ.</p>
            </div>
          </div>

          <div className="p-7 sm:p-10 lg:p-12">
            <div aria-hidden="true">✓</div>
            <p className="mt-7 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Đã tiếp nhận hồ sơ</p>
            <h2 className="mt-2 text-2xl font-bold text-slate-950">Thông tin đã được ghi nhận an toàn</h2>
            <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600">
              Thông tin đã được tiếp nhận và sẽ được cập nhật sau khi Cơ quan giám sát hoàn tất kiểm tra hồ sơ.
            </p>

            <div className="mt-7 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mã hồ sơ</p>
              <p className="mt-2 break-all font-mono text-sm font-semibold text-slate-900">{submissionResult.submissionId || 'Đã ghi nhận'}</p>
            </div>

            <div className="mt-7 space-y-4">
              <div className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">1</span>
                <div><p className="text-sm font-semibold text-slate-900">Đã tiếp nhận</p><p className="text-xs leading-5 text-slate-500">Hồ sơ đã được lưu để kiểm tra.</p></div>
              </div>
              <div className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-700">2</span>
                <div><p className="text-sm font-semibold text-slate-900">Chờ Cơ quan giám sát duyệt</p><p className="text-xs leading-5 text-slate-500">Thời gian xử lý phụ thuộc vào việc kiểm tra hồ sơ.</p></div>
              </div>
            </div>

            <Link href="/transparency" className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-emerald-700 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200">
              Xem thông tin minh bạch công khai <span className="ml-2" aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-6xl overflow-hidden rounded-[2rem] border border-emerald-100 bg-white shadow-[0_24px_80px_rgba(15,118,110,0.12)]">
      <div className="grid lg:grid-cols-[0.82fr_1.18fr]">
        <aside className="relative overflow-hidden bg-[#0b6558] p-7 text-white sm:p-10 lg:p-12">
          <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-emerald-300/20" />
          <div className="absolute -bottom-24 -left-20 h-64 w-64 rounded-full bg-cyan-300/10" />
          <div className="relative flex h-full flex-col">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-emerald-100">DCP · Foundation KYC</p>
            <h1 className="mt-5 text-3xl font-bold leading-tight sm:text-4xl">Xác minh tài khoản nhận quyên góp</h1>
            <p className="mt-5 text-sm leading-7 text-emerald-50">
              Cổng công khai dành cho Quỹ từ thiện đăng ký xác minh tài khoản ngân hàng trung tâm nhận tiền quyên góp.
            </p>

            <div className="mt-7 space-y-3">
              {[
                'Hồ sơ được kiểm tra minh bạch',
                'Tài khoản nhận quyên góp trung tâm',
                'Theo dõi trạng thái sau khi gửi'
              ].map((item) => (
                <div key={item} className="flex items-center gap-3 text-sm text-emerald-50">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-xs text-emerald-100" aria-hidden="true">✓</span>
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <div className="mt-10 rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-100">Quy trình 3 bước</p>
              <div className="mt-5 space-y-4">
                {[
                  ['01', 'Cung cấp thông tin', 'Pháp nhân và tài khoản trung tâm'],
                  ['02', 'Kiểm tra hồ sơ', 'Xác nhận lại trước khi gửi'],
                  ['03', 'Cơ quan giám sát duyệt', 'Kết quả được cập nhật sau khi hồ sơ được duyệt']
                ].map(([stepNumber, title, description]) => (
                  <div key={stepNumber} className="flex gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/15 font-mono text-[11px] font-bold text-white">{stepNumber}</span>
                    <div><p className="text-sm font-semibold text-white">{title}</p><p className="mt-0.5 text-xs leading-5 text-emerald-100/75">{description}</p></div>
                  </div>
                ))}
              </div>
            </div>

            <Link href="/transparency" className="mt-auto pt-8 text-sm font-semibold text-white underline decoration-emerald-200/50 underline-offset-4 transition hover:text-emerald-100">
              Tìm hiểu về minh bạch công khai <span aria-hidden="true">→</span>
            </Link>
          </div>
        </aside>

        <div className="p-6 sm:p-10 lg:p-12">
          <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">{isConfirming ? 'Bước 2 / 2' : 'Bước 1 / 2'}</p>
              <h2 className="mt-2 text-2xl font-bold text-slate-950">{isConfirming ? 'Xác nhận thông tin trước khi gửi' : 'Thông tin đăng ký xác minh'}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">{isConfirming ? 'Vui lòng kiểm tra kỹ trước khi gửi hồ sơ một lần.' : 'Vui lòng điền thông tin theo giấy tờ pháp lý của Quỹ.'}</p>
            </div>
          </div>

          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-label={`Tiến độ ${isConfirming ? '100' : '50'} phần trăm`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={isConfirming ? 100 : 50}>
            <div className={`h-full rounded-full bg-emerald-600 transition-all duration-300 ${isConfirming ? 'w-full' : 'w-1/2'}`} />
          </div>

          {errorMessage ? <p role="alert" aria-live="assertive" className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{errorMessage}</p> : null}

          {isConfirming ? (
            <div className="mt-7 space-y-6">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                  {[
                    ['Tên pháp nhân', formValues.organizationName],
                    ['Số đăng ký pháp nhân', formValues.legalRegistrationNumber],
                    ['Mã số thuế', formValues.taxIdentificationNumber],
                    ['Ngân hàng', formValues.bankName],
                    ['Số tài khoản', formValues.bankAccountNumber],
                    ['Chủ tài khoản', formValues.accountHolderName],
                    ['Giấy tờ pháp lý', selectedFile ? `${selectedFile.name} · ${formatFileSize(selectedFile.size)}` : 'Chưa chọn']
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                      <p className="mt-1 break-words text-sm font-semibold text-slate-900">{value}</p>
                    </div>
                  ))}
                </div>
                {formValues.officialWebsite ? <p className="mt-5 border-t border-slate-200 pt-4 text-xs text-slate-500">Website: <span className="font-medium text-slate-700">{formValues.officialWebsite}</span></p> : null}
              </div>

              <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                <span className="mt-0.5 text-lg" aria-hidden="true">!</span>
                <p>Hãy kiểm tra kỹ số đăng ký pháp nhân và số tài khoản. Hồ sơ bị từ chối sẽ không thể nộp lại qua cổng công khai.</p>
              </div>

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setIsConfirming(false)} disabled={isSubmitting} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-60">Quay lại chỉnh sửa</button>
                <button type="button" onClick={() => void handleConfirmedSubmit()} disabled={isSubmitting} aria-busy={isSubmitting} className="rounded-xl bg-emerald-700 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-700/15 transition hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60">{isSubmitting ? 'Đang gửi hồ sơ…' : 'Xác nhận và gửi hồ sơ'}</button>
              </div>
            </div>
          ) : (
            <form className="mt-7 space-y-8" noValidate onSubmit={handlePrepareSubmit}>
              <fieldset className="space-y-5">
                <legend className="text-base font-bold text-slate-950">Thông tin pháp nhân</legend>
                <p className="text-sm leading-6 text-slate-500">Dùng thông tin đúng theo giấy tờ pháp lý của Quỹ.</p>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="organizationName" className="text-sm font-semibold text-slate-800">Tên pháp nhân</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                    <input id="organizationName" aria-label="Tên pháp nhân" aria-invalid={Boolean(fieldErrors.organizationName)} aria-describedby={fieldErrors.organizationName ? 'organizationName-error' : undefined} required autoComplete="organization" value={formValues.organizationName} onChange={event => handleFormValueChange('organizationName', event.target.value)} onBlur={() => handleFieldBlur('organizationName')} className={getFoundationKycControlClass(Boolean(fieldErrors.organizationName))} placeholder="Ví dụ: Quỹ Nhân Ái Việt Nam" />
                    {fieldErrors.organizationName ? <p id="organizationName-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.organizationName}</p> : null}
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="legalRegistrationNumber" className="text-sm font-semibold text-slate-800">Số đăng ký pháp nhân</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                    <input id="legalRegistrationNumber" aria-label="Số đăng ký pháp nhân" aria-invalid={Boolean(fieldErrors.legalRegistrationNumber)} aria-describedby={fieldErrors.legalRegistrationNumber ? 'legalRegistrationNumber-error' : undefined} required spellCheck={false} value={formValues.legalRegistrationNumber} onChange={event => handleFormValueChange('legalRegistrationNumber', event.target.value)} onBlur={() => handleFieldBlur('legalRegistrationNumber')} className={`${getFoundationKycControlClass(Boolean(fieldErrors.legalRegistrationNumber))} font-mono placeholder:font-sans`} placeholder="Ví dụ: 031.234-567" />
                    {fieldErrors.legalRegistrationNumber ? <p id="legalRegistrationNumber-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.legalRegistrationNumber}</p> : <p className="mt-2 text-xs text-slate-500">Có thể nhập dấu chấm hoặc dấu gạch ngang.</p>}
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="taxIdentificationNumber" className="text-sm font-semibold text-slate-800">Mã số thuế</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                    <input id="taxIdentificationNumber" aria-label="Mã số thuế" aria-invalid={Boolean(fieldErrors.taxIdentificationNumber)} aria-describedby={fieldErrors.taxIdentificationNumber ? 'taxIdentificationNumber-error' : undefined} required inputMode="numeric" spellCheck={false} value={formValues.taxIdentificationNumber} onChange={event => handleFormValueChange('taxIdentificationNumber', event.target.value)} onBlur={() => handleFieldBlur('taxIdentificationNumber')} className={`${getFoundationKycControlClass(Boolean(fieldErrors.taxIdentificationNumber))} font-mono placeholder:font-sans`} placeholder="Ví dụ: 0101234567" />
                    {fieldErrors.taxIdentificationNumber ? <p id="taxIdentificationNumber-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.taxIdentificationNumber}</p> : <p className="mt-2 text-xs text-slate-500">Nhập 10 hoặc 13 chữ số theo giấy đăng ký thuế.</p>}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between"><label htmlFor="officialWebsite" className="text-sm font-semibold text-slate-800">Website chính thức</label><span className="text-[11px] text-slate-400">Không bắt buộc</span></div>
                  <input id="officialWebsite" aria-label="Website chính thức" aria-invalid={Boolean(fieldErrors.officialWebsite)} aria-describedby={fieldErrors.officialWebsite ? 'officialWebsite-error' : undefined} type="url" autoComplete="url" value={formValues.officialWebsite} onChange={event => handleFormValueChange('officialWebsite', event.target.value)} onBlur={() => handleFieldBlur('officialWebsite')} className={getFoundationKycControlClass(Boolean(fieldErrors.officialWebsite))} placeholder="https://ten-quy.org.vn" />
                  {fieldErrors.officialWebsite ? <p id="officialWebsite-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.officialWebsite}</p> : null}
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between"><label htmlFor="organizationDescription" className="text-sm font-semibold text-slate-800">Mô tả pháp nhân</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                  <textarea id="organizationDescription" aria-label="Mô tả pháp nhân" aria-invalid={Boolean(fieldErrors.organizationDescription)} aria-describedby={fieldErrors.organizationDescription ? 'organizationDescription-error' : undefined} required rows={4} maxLength={2000} value={formValues.organizationDescription} onChange={event => handleFormValueChange('organizationDescription', event.target.value)} onBlur={() => handleFieldBlur('organizationDescription')} className={`${getFoundationKycControlClass(Boolean(fieldErrors.organizationDescription))} resize-y leading-6`} placeholder="Mô tả ngắn về sứ mệnh, hoạt động và mục đích tiếp nhận quyên góp của Quỹ." />
                  {fieldErrors.organizationDescription ? <p id="organizationDescription-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.organizationDescription}</p> : null}
                  <p className="mt-2 text-right text-xs text-slate-400" aria-live="polite">{formValues.organizationDescription.length}/2000 ký tự</p>
                </div>
              </fieldset>

              <fieldset className="space-y-5 border-t border-slate-100 pt-7">
                <legend className="text-base font-bold text-slate-950">Tài khoản ngân hàng trung tâm</legend>
                <p className="text-sm leading-6 text-slate-500">Đây là tài khoản được công khai trong quy trình tiếp nhận quyên góp sau khi được xác minh.</p>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="bankName" className="text-sm font-semibold text-slate-800">Tên ngân hàng</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                    <select id="bankName" aria-label="Tên ngân hàng" aria-invalid={Boolean(fieldErrors.bankName)} aria-describedby={fieldErrors.bankName ? 'bankName-error' : undefined} required value={formValues.bankName} onChange={event => handleFormValueChange('bankName', event.target.value)} onBlur={() => handleFieldBlur('bankName')} className={`${getFoundationKycControlClass(Boolean(fieldErrors.bankName))} cursor-pointer`}>
                      <option value="">Chọn ngân hàng liên kết PayOS</option>
                      {FOUNDATION_KYC_SUPPORTED_BANKS.map(bank => <option key={bank.value} value={bank.value}>{bank.label}</option>)}
                    </select>
                    {fieldErrors.bankName ? <p id="bankName-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.bankName}</p> : <p className="mt-2 text-xs leading-5 text-slate-500">Chỉ hiển thị ngân hàng doanh nghiệp được PayOS hỗ trợ. BIDV, OCB, Shinhan Bank và ACB có thể cần thủ tục tài khoản định danh (VA).</p>}
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="bankAccountNumber" className="text-sm font-semibold text-slate-800">Số tài khoản</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                    <input id="bankAccountNumber" aria-label="Số tài khoản" aria-invalid={Boolean(fieldErrors.bankAccountNumber)} aria-describedby={fieldErrors.bankAccountNumber ? 'bankAccountNumber-error' : undefined} required inputMode="numeric" spellCheck={false} value={formValues.bankAccountNumber} onChange={event => handleFormValueChange('bankAccountNumber', event.target.value)} onBlur={() => handleFieldBlur('bankAccountNumber')} className={`${getFoundationKycControlClass(Boolean(fieldErrors.bankAccountNumber))} font-mono placeholder:font-sans`} placeholder="8–20 chữ số" />
                    {fieldErrors.bankAccountNumber ? <p id="bankAccountNumber-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.bankAccountNumber}</p> : null}
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="accountHolderName" className="text-sm font-semibold text-slate-800">Tên chủ tài khoản</label><span className="text-[11px] font-semibold text-emerald-700">Bắt buộc</span></div>
                    <input id="accountHolderName" aria-label="Tên chủ tài khoản" aria-invalid={Boolean(fieldErrors.accountHolderName)} aria-describedby={fieldErrors.accountHolderName ? 'accountHolderName-error' : undefined} required autoComplete="name" value={formValues.accountHolderName} onChange={event => handleFormValueChange('accountHolderName', event.target.value)} onBlur={() => handleFieldBlur('accountHolderName')} className={`${getFoundationKycControlClass(Boolean(fieldErrors.accountHolderName))} uppercase placeholder:normal-case`} placeholder="Ví dụ: QUY NHAN AI" />
                    {fieldErrors.accountHolderName ? <p id="accountHolderName-error" role="alert" className="mt-2 text-xs leading-5 text-red-600">{fieldErrors.accountHolderName}</p> : <p className="mt-2 text-xs text-slate-500">Tự động viết hoa và bỏ dấu tiếng Việt.</p>}
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between"><label htmlFor="branchName" className="text-sm font-semibold text-slate-800">Chi nhánh</label><span className="text-[11px] text-slate-400">Không bắt buộc</span></div>
                    <input id="branchName" aria-label="Chi nhánh (nếu có)" value={formValues.branchName} onChange={event => handleFormValueChange('branchName', event.target.value)} onBlur={() => handleFieldBlur('branchName')} className={getFoundationKycControlClass(false)} placeholder="Ví dụ: Chi nhánh Hà Nội" />
                  </div>
                </div>
              </fieldset>

              <fieldset className="space-y-5 border-t border-slate-100 pt-7">
                <legend className="text-base font-bold text-slate-950">Giấy tờ pháp lý</legend>
                <p className="text-sm leading-6 text-slate-500">Tải lên giấy tờ để Cơ quan giám sát đối chiếu thông tin pháp nhân.</p>
                <label htmlFor="legalDocument" className={`block cursor-pointer rounded-2xl border-2 border-dashed p-5 transition ${fieldErrors.legalDocument ? 'border-red-300 bg-red-50/50' : selectedFile ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-slate-50 hover:border-emerald-300 hover:bg-emerald-50/40'}`}>
                  <div className="flex items-start gap-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-xl text-emerald-700 shadow-sm" aria-hidden="true">↑</span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900">Giấy tờ pháp lý</p>
                      {selectedFile ? <p className="mt-1 break-all text-sm font-semibold text-emerald-700">{selectedFile.name} · {formatFileSize(selectedFile.size)}</p> : <p className="mt-1 text-sm text-slate-500">Chọn một file PDF, PNG hoặc JPG/JPEG</p>}
                      <p className="mt-2 text-xs text-slate-400">Dung lượng tối đa 5MB · Chỉ tải lên 1 file</p>
                    </div>
                  </div>
                  <input id="legalDocument" aria-label="Giấy tờ pháp lý" aria-invalid={Boolean(fieldErrors.legalDocument)} aria-describedby={fieldErrors.legalDocument ? 'legalDocument-error' : undefined} required={!selectedFile} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={event => handleFileChange(event.target.files?.[0])} className="sr-only" />
                </label>
                {fieldErrors.legalDocument ? <p id="legalDocument-error" role="alert" className="text-xs leading-5 text-red-600">{fieldErrors.legalDocument}</p> : null}
              </fieldset>

              <div className="flex gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-6 text-slate-600">
                <span className="mt-0.5 text-base text-emerald-700" aria-hidden="true">◈</span>
                <p>Hồ sơ được dùng cho mục đích xác minh và review. Thông tin ngân hàng, file và CID không xuất hiện trên trang minh bạch công khai.</p>
              </div>

              <input tabIndex={-1} autoComplete="off" aria-hidden="true" name="additionalEmail" value={formValues.additionalEmail} onChange={event => updateFormValue('additionalEmail', event.target.value)} className="hidden" />
              <button type="submit" className="w-full rounded-xl bg-emerald-700 px-5 py-3.5 text-sm font-bold text-white shadow-lg shadow-emerald-700/15 transition hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200">Kiểm tra và tiếp tục <span className="ml-1" aria-hidden="true">→</span></button>
              <p className="text-center text-xs leading-5 text-slate-400">Bước tiếp theo cho phép bạn kiểm tra lại toàn bộ thông tin trước khi gửi.</p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
