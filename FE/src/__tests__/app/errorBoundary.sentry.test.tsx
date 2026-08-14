import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/nextjs', () => ({
  captureException: captureExceptionMock
}));

vi.mock('next/link', () => ({
  default: (props: { href?: string; children?: ReactNode }) => (
    <a href={props.href}>{props.children}</a>
  )
}));

vi.mock('@/app/components/common/CyberErrorScreen', () => ({
  default: (props: { primaryActionNode?: ReactNode }) => (
    <div>{props.primaryActionNode}</div>
  )
}));

import RouteErrorPage from '@/app/error';
import GlobalErrorPage from '@/app/global-error';

describe('Sentry error boundaries', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear();
  });

  it('route boundary capture dung error object', async () => {
    const error = new Error('route failure');

    render(<RouteErrorPage error={error} reset={vi.fn()} />);

    await waitFor(() => {
      expect(captureExceptionMock).toHaveBeenCalledWith(error);
    });
  });

  it('global boundary capture dung error object', async () => {
    const error = new Error('global failure');

    render(<GlobalErrorPage error={error} reset={vi.fn()} />);

    await waitFor(() => {
      expect(captureExceptionMock).toHaveBeenCalledWith(error);
    });
  });
});
