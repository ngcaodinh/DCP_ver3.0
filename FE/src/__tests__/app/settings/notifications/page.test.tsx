import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/app/components/notifications/NotificationPanel', () => ({
  default: () => <div>Notification panel</div>
}));

import NotificationSettingsPage from '@/app/settings/notifications/page';

it('render route settings với heading và NotificationPanel', () => {
  render(<NotificationSettingsPage />);

  expect(screen.getByRole('heading', { name: 'Cài đặt thông báo' })).toBeInTheDocument();
  expect(screen.getByText('Notification panel')).toBeInTheDocument();
});
