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
    hasGeofence: true,
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

  it('khóa gửi yêu cầu duyệt đến khi geofence được lưu', () => {
    renderProjectsSection([buildProject({ status: 'DRAFT', hasGeofence: false })]);

    expect(screen.getByRole('button', { name: 'Gửi yêu cầu duyệt' })).toBeDisabled();
    expect(screen.getByText('Thiết lập vùng địa lý để mở gửi duyệt.')).toBeInTheDocument();
  });

  it('mở gửi yêu cầu duyệt sau khi geofence được lưu', () => {
    renderProjectsSection([buildProject({ status: 'DRAFT', hasGeofence: true })]);

    expect(screen.getByRole('button', { name: 'Gửi yêu cầu duyệt' })).toBeEnabled();
  });

  it('hiển thị countdown niêm yết thay vì coi dự án là bị từ chối', () => {
    renderProjectsSection([buildProject({
      status: 'PENDING_ACTIVATION',
      activationEligibleAt: new Date(Date.now() + 31 * 60 * 60 * 1000).toISOString()
    })]);

    expect(screen.getByText(/ĐANG NIÊM YẾT/i)).toBeInTheDocument();
    expect(screen.getByText(/Niêm yết: còn 31 giờ/i)).toBeInTheDocument();
  });
});
