import type { ReactElement } from 'react';
import AuditorOnboardingClient from '@/app/components/auditor/AuditorOnboardingClient';

/** Cung cấp route công khai cho luồng self-onboarding Auditor. */
export default function AuditorOnboardingPage(): ReactElement {
  return <AuditorOnboardingClient />;
}
