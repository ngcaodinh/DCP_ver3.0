import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ProjectSummary } from '@/app/components/organizations/types';

vi.mock('@/app/components/common/IpfsEvidencePreviewCard', () => ({
  default: () => null
}));

import { ProjectsSection } from '@/app/components/organizations/OrganizationsSections';

/** Tạo project tối thiểu để kiểm tra action geofence trên card dashboard. */
function buildProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: 'project/a',
    organizationId: 'organization-1',
    name: 'Dự án kiểm thử',
    description: 'Mô tả dự án kiểm thử',
    goalAmount: 1_000_000,
    deadline: '2027-01-01T00:00:00.000Z',
    status: 'ACTIVE',
    evidenceCids: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

/** Render ProjectsSection với callback tối thiểu không làm thay đổi state bên ngoài. */
function renderProjectsSection(createdProjects: ProjectSummary[]) {
  return render(
    <ProjectsSection
      createdProjects={createdProjects}
      onOpenCreateProjectModal={vi.fn()}
      onProjectSubmitted={vi.fn()}
      onProjectUpdated={vi.fn()}
    />
  );
}

describe('ProjectsSection — geofence entry point', () => {
  it('hiển thị link geofence với projectId đã được encode', () => {
    renderProjectsSection([buildProject()]);

    expect(screen.getByRole('link', { name: 'Thiết lập vùng địa lý' }))
      .toHaveAttribute('href', '/organization/projects/project%2Fa/geofence');
  });

  it('không hiển thị link geofence khi projectId rỗng', () => {
    renderProjectsSection([buildProject({ projectId: '' })]);

    expect(screen.queryByRole('link', { name: 'Thiết lập vùng địa lý' })).not.toBeInTheDocument();
  });
});
