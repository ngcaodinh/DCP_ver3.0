import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/utils/ipfs', () => ({
  buildIpfsGatewayUrl: (cid: string) => `https://gateway.example/ipfs/${cid}`,
  buildIpfsGatewayUrlList: (cid: string) => [`https://gateway.example/ipfs/${cid}`]
}));

import { ChallengeEvidenceGallery, type EvidencePhoto } from '@/app/components/governance/ChallengeEvidenceGallery';

const photo: EvidencePhoto = {
  cid: 'QmfPNrdXA8swDzZdRNJ9U9YXQUZzaN9ULURowmwi7E2X8y',
  capturedAt: '2026-08-26T14:57:21.000Z',
  gps: { latitude: 10.0182, longitude: 105.758 },
  accuracyMeters: 88,
  isLowAccuracyOverride: false,
  lowAccuracyReason: null
};

describe('ChallengeEvidenceGallery', () => {
  it('labels the IPFS identifier as a CID', () => {
    render(<ChallengeEvidenceGallery photos={[photo]} />);

    expect(screen.getByRole('link')).toHaveTextContent('Mã CID: QmfPNrdXA8...7E2X8y');
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://gateway.example/ipfs/QmfPNrdXA8swDzZdRNJ9U9YXQUZzaN9ULURowmwi7E2X8y');
  });
});
