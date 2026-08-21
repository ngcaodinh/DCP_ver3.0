import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/components/oracle/GeofenceEditorMapLazy', () => ({
  GeofenceEditorLazy: ({ projectId }: { projectId: string }) => (
    <div data-testid="geofence-editor" data-project-id={projectId} />
  )
}));

import GeofencePage from '@/app/organization/projects/[id]/geofence/page';

describe('GeofencePage', () => {
  it('cung cấp liên kết quay lại danh sách dự án của tổ chức', async () => {
    render(await GeofencePage({ params: Promise.resolve({ id: 'project-abc' }) }));

    expect(screen.getByTestId('back-to-my-projects'))
      .toHaveAttribute('href', '/organizations?tab=projects');
    expect(screen.getByRole('link', { name: 'Tổ chức' }))
      .toHaveAttribute('href', '/organizations?tab=projects');
    expect(screen.getByTestId('geofence-editor'))
      .toHaveAttribute('data-project-id', 'project-abc');
  });
});
