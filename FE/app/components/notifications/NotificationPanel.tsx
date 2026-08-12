'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNotificationPreferences, useUpdateNotificationPreferences } from '@/app/hooks/useNotificationPreferences';
import ToastStack, { type ToastItem as NotificationToastItem } from '@/app/components/common/ToastStack';
import { EMAIL_PREFERENCE_NOTIFICATION_TYPES, getEmailPreferenceValues, type EmailPreferenceValues } from './types';
import { getEmailPreferencePresentation } from './notificationPresentation';

const EMPTY_EMAIL_PREFERENCE_VALUES: EmailPreferenceValues = {
  LARGE_DONATION: false,
  DISBURSEMENT_COMPLETED: false,
  MANUAL_REVIEW_ESCALATION: false,
  OVERRIDE_APPROVED: false,
  SBT_MINT_FAILED: false
};

/** So sánh năm toggle với canonical record hiện tại để biết nút lưu có thực sự cần bật hay không. */
function areEmailPreferencesEqual(left: EmailPreferenceValues, right: EmailPreferenceValues): boolean {
  return EMAIL_PREFERENCE_NOTIFICATION_TYPES.every((notificationType) => left[notificationType] === right[notificationType]);
}

/** Chuyển trạng thái lỗi API thành nội dung an toàn, không đưa error body thô lên giao diện. */
function getPreferenceErrorText(statusCode: number | undefined): string {
  if (statusCode === 401) {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }
  if (statusCode === 403) {
    return 'Bạn không có quyền thay đổi cài đặt thông báo.';
  }
  if (statusCode === 409) {
    return 'Cài đặt đã thay đổi ở nơi khác. Vui lòng tải lại trước khi lưu lại.';
  }
  return 'Không thể tải cài đặt thông báo. Vui lòng thử lại.';
}

/** Chuẩn hóa thông báo lỗi khi PUT thất bại để phân biệt conflict với lỗi mạng thông thường. */
function getPreferenceMutationErrorText(statusCode: number | undefined): string {
  if (statusCode === 409) {
    return 'Cài đặt đã thay đổi ở nơi khác. Hãy tải lại dữ liệu trước khi thử lại.';
  }
  if (statusCode === 401 || statusCode === 403) {
    return getPreferenceErrorText(statusCode);
  }
  return 'Vui lòng kiểm tra kết nối và thử lại.';
}

/** Panel settings cho năm email type đã chốt, luôn dùng full preference map từ hook khi submit. */
export default function NotificationPanel(): React.ReactElement {
  const preferencesQuery = useNotificationPreferences();
  const updatePreferencesMutation = useUpdateNotificationPreferences();
  const [emailValues, setEmailValues] = useState<EmailPreferenceValues>(() => ({ ...EMPTY_EMAIL_PREFERENCE_VALUES }));
  const [toastItemList, setToastItemList] = useState<NotificationToastItem[]>([]);
  const toastSequenceRef = useRef(0);
  const toastTimeoutSetRef = useRef<Set<number>>(new Set());
  const hasHydratedEmailValuesRef = useRef(false);
  const hydratedSessionKeyRef = useRef<string | undefined>(undefined);
  const currentSessionKeyRef = useRef<string | undefined>(preferencesQuery.sessionKey);
  currentSessionKeyRef.current = preferencesQuery.sessionKey;
  const serverEmailValues = useMemo(
    () => (preferencesQuery.data ? getEmailPreferenceValues(preferencesQuery.data.preferences) : null),
    [preferencesQuery.data]
  );
  const isDirty = serverEmailValues ? !areEmailPreferencesEqual(emailValues, serverEmailValues) : false;

  useEffect(() => {
    if (hydratedSessionKeyRef.current !== preferencesQuery.sessionKey) {
      hydratedSessionKeyRef.current = preferencesQuery.sessionKey;
      hasHydratedEmailValuesRef.current = false;
      setEmailValues({ ...EMPTY_EMAIL_PREFERENCE_VALUES });
    }
  }, [preferencesQuery.sessionKey]);

  useEffect(() => {
    if (serverEmailValues && !hasHydratedEmailValuesRef.current) {
      setEmailValues(serverEmailValues);
      hasHydratedEmailValuesRef.current = true;
    }
  }, [serverEmailValues]);

  useEffect(() => () => {
    toastTimeoutSetRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    toastTimeoutSetRef.current.clear();
  }, []);

  /** Thêm toast cục bộ và tự dọn sau bốn giây, không cần provider hoặc dependency mới. */
  const pushToast = (titleText: string, bodyText: string, tone: NotificationToastItem['tone']): void => {
    toastSequenceRef.current += 1;
    const toastItem: NotificationToastItem = {
      id: `notification-preference-${toastSequenceRef.current}`,
      titleText,
      bodyText,
      tone
    };
    setToastItemList((currentToasts) => [...currentToasts, toastItem]);
    const timeoutId = window.setTimeout(() => {
      toastTimeoutSetRef.current.delete(timeoutId);
      setToastItemList((currentToasts) => currentToasts.filter((item) => item.id !== toastItem.id));
    }, 4_000);
    toastTimeoutSetRef.current.add(timeoutId);
  };

  /** Cập nhật duy nhất checkbox được thao tác, các type và channel khác vẫn giữ trong canonical map. */
  const handleEmailValueChange = (notificationType: keyof EmailPreferenceValues, isEnabled: boolean): void => {
    setEmailValues((currentValues) => ({ ...currentValues, [notificationType]: isEnabled }));
  };

  /** Submit full cloned map; khi lỗi giữ nguyên local checkbox để người dùng có thể retry. */
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!preferencesQuery.data || !isDirty || preferencesQuery.isFetching || updatePreferencesMutation.isPending) {
      return;
    }

    const submittedSessionKey = currentSessionKeyRef.current;
    try {
      const updatedPreferences = await updatePreferencesMutation.mutateAsync({
        currentPreferences: preferencesQuery.data,
        emailValues
      });
      // Bỏ qua response của session cũ nếu người dùng đã đổi tài khoản trong lúc PUT đang chờ.
      if (submittedSessionKey !== currentSessionKeyRef.current) {
        return;
      }
      setEmailValues(getEmailPreferenceValues(updatedPreferences.preferences));
      pushToast('Đã lưu cài đặt', 'Tùy chọn email của bạn đã được cập nhật.', 'success');
    } catch (error: unknown) {
      if (submittedSessionKey !== currentSessionKeyRef.current) {
        return;
      }
      const statusCode = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
      if (statusCode === 409) {
        // Tải lại version/map từ server sau conflict nhưng giữ toggle local để thử lại.
        void preferencesQuery.refetch();
      }
      pushToast('Không thể lưu cài đặt', getPreferenceMutationErrorText(statusCode), 'error');
    }
  };

  if (!preferencesQuery.isEnabled) {
    return <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Bạn cần đăng nhập để xem cài đặt thông báo.</p>;
  }

  if (preferencesQuery.isPending) {
    return <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500" role="status">Đang tải cài đặt thông báo...</p>;
  }

  if (preferencesQuery.isError || !preferencesQuery.data) {
    return (
      <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4" role="alert">
        <p className="text-sm text-red-700">{getPreferenceErrorText(preferencesQuery.error?.statusCode)}</p>
        <button
          type="button"
          onClick={() => void preferencesQuery.refetch()}
          className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500"
        >
          Thử lại
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="notification-email-settings-title">
      <ToastStack
        toastItemList={toastItemList}
        onCloseToast={(toastId) => setToastItemList((currentToasts) => currentToasts.filter((item) => item.id !== toastId))}
      />
      <div className="border-b border-slate-100 pb-4">
        <h2 id="notification-email-settings-title" className="text-lg font-semibold text-slate-900">Thông báo qua email</h2>
        <p className="mt-1 text-sm text-slate-600">Chọn những sự kiện bạn muốn nhận qua email.</p>
      </div>

      <form className="mt-2" onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className="divide-y divide-slate-100">
          <legend className="sr-only">Các loại thông báo qua email</legend>
          {EMAIL_PREFERENCE_NOTIFICATION_TYPES.map((notificationType) => {
            const presentation = getEmailPreferencePresentation(notificationType);
            const inputId = `notification-email-${notificationType.toLowerCase()}`;
            const descriptionId = `${inputId}-description`;
            return (
              <div key={notificationType} className="flex items-start justify-between gap-4 py-4">
                <div className="min-w-0">
                  <label htmlFor={inputId} className="cursor-pointer text-sm font-medium text-slate-900">{presentation.label}</label>
                  <p id={descriptionId} className="mt-1 text-sm text-slate-600">{presentation.description}</p>
                </div>
                <input
                  id={inputId}
                  type="checkbox"
                  checked={emailValues[notificationType]}
                  onChange={(event) => handleEmailValueChange(notificationType, event.target.checked)}
                  aria-describedby={descriptionId}
                  disabled={updatePreferencesMutation.isPending}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-[#0E7C6B] focus:ring-[#0E7C6B]"
                />
              </div>
            );
          })}
        </fieldset>

        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            disabled={!isDirty || updatePreferencesMutation.isPending || preferencesQuery.isFetching}
            className="inline-flex min-h-10 items-center justify-center rounded-lg bg-[#0E7C6B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#096556] focus:outline-none focus:ring-2 focus:ring-[#0E7C6B] focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {updatePreferencesMutation.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
        </div>
      </form>
    </section>
  );
}
