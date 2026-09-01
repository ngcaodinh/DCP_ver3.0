import type { Metadata } from 'next';
import DonationCertificateVerification from './DonationCertificateVerification';
import type { ReactElement } from 'react';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Tạo SEO metadata động cho trang xác minh chứng nhận tri ân quyên góp. */
export async function generateMetadata({ params }: { params: { certificateId: string } }): Promise<Metadata> {
  const certificateId = params.certificateId;
  return {
    title: `Xác minh Chứng nhận ${certificateId} | DCP`,
    description: `Tra cứu và xác thực tính toàn vẹn on-chain của chứng nhận quyên góp ${certificateId} trên nền tảng từ thiện phi tập trung DCP.`,
    openGraph: {
      title: `Xác minh Chứng nhận Tri ân ${certificateId} | DCP`,
      description: `Tra cứu và xác thực tính toàn vẹn on-chain của chứng nhận quyên góp ${certificateId} trên nền tảng từ thiện phi tập trung DCP.`,
    }
  };
}

/** Render trang verify không cache cho certificate được xác minh live. */
export default function DonationCertificateVerificationPage({ params }: { params: { certificateId: string } }): ReactElement {
  return <DonationCertificateVerification certificateId={params.certificateId} />;
}
