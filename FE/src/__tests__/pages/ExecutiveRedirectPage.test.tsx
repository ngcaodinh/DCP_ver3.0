import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readAuthSession: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/app/utils/authSession', () => ({ readAuthSession: mocks.readAuthSession }));

import ExecutivePage from '@/app/executive/page';

describe('legacy executive redirect page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['executive_chair', '/executive/chair'],
    ['executive_member', '/executive/member'],
    ['donor', '/unauthorized']
  ])('điều hướng role %s tới route riêng tương ứng', async (userRole, destination) => {
    mocks.readAuthSession.mockReturnValue({ userRole });

    render(<ExecutivePage />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(destination));
  });
});
