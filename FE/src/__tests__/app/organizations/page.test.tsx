import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/components/organizations/OrganizationsPageView', () => ({
  default: ({ initialPage }: { initialPage: string }) => (
    <div data-testid="organizations-page-view" data-initial-page={initialPage} />
  )
}));

import OrganizationsPage from '@/app/organizations/page';

describe('OrganizationsPage', () => {
  it('opens My Projects when the projects tab is requested in the URL', async () => {
    render(await OrganizationsPage({ searchParams: Promise.resolve({ tab: 'projects' }) }));

    expect(screen.getByTestId('organizations-page-view')).toHaveAttribute('data-initial-page', 'projects');
  });

  it('falls back to the dashboard for an unsupported tab', async () => {
    render(await OrganizationsPage({ searchParams: Promise.resolve({ tab: 'unknown' }) }));

    expect(screen.getByTestId('organizations-page-view')).toHaveAttribute('data-initial-page', 'dashboard');
  });
});
