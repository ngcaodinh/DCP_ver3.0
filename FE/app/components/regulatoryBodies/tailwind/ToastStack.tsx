import type { ToastItem } from './types';
import SharedToastStack from '@/app/components/common/ToastStack';

type ToastStackProps = {
  toastItemList: ToastItem[];
  onCloseToast: (toastId: string) => void;
};

/** Giữ API ToastStack của Regulatory trong khi dùng implementation chung. */
export default function ToastStack({ toastItemList, onCloseToast }: ToastStackProps): React.ReactElement {
  return <SharedToastStack toastItemList={toastItemList} onCloseToast={onCloseToast} />;
}
