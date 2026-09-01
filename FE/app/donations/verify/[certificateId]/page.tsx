import DonationCertificateVerification from './DonationCertificateVerification';
import type { ReactElement } from 'react';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Render trang verify không cache cho certificate được xác minh live. */
export default function DonationCertificateVerificationPage({ params }: { params: { certificateId: string } }): ReactElement { return <DonationCertificateVerification certificateId={params.certificateId} />; }
