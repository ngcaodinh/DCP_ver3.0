/**
 * WalletAlertIcon — Icon thông báo cho banner nhắc nhở lưu ví guest.
 * Mục đích: tách SVG ra khỏi GuestWalletBanner để tăng tính readable và reuse.
 */
export function WalletAlertIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253q.25-.121.465-.265a3.75 3.75 0 01-.465.265H9a.75.75 0 000 1.5h.253a2.25 2.25 0 011.069.504 3.75 3.75 0 01-.069.747V14a.75.75 0 001.5 0v-.753a2.25 2.25 0 00-.069-.747 3.75 3.75 0 01.069-.747 2.25 2.25 0 01-1.069-.504H9z"
        clipRule="evenodd"
      />
    </svg>
  );
}
