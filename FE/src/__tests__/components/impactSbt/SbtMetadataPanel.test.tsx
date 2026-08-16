import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SbtMetadataPanel from '@/app/components/impactSbt/SbtMetadataPanel';
import type { SbtTokenOnChainDetail, SbtTokenOffChainDetail } from '@/app/types/impactSbt';

const onChain: SbtTokenOnChainDetail = {
  projectId: 5,
  milestone: 2,
  beneficiaryCount: 150,
  gpsCoordinates: '10.8,106.6',
  imageCID: 'QmImage',
  mintedAt: '2026-08-01T10:00:00.000Z',
  tokenStatus: 'ACTIVE'
};

const offChain: SbtTokenOffChainDetail = {
  projectId: 'project-1',
  milestone: 2,
  beneficiaryCount: 150,
  imageCid: 'QmImage',
  tokenUri: 'ipfs://QmMetadata',
  confirmedAt: '2026-08-01T10:00:00.000Z',
  transactionHash: '0xtx',
  tokenStatusReason: null
};

describe('SbtMetadataPanel', () => {
  it('render các field public và JSON metadata thu gọn', () => {
    render(
      <SbtMetadataPanel
        onChainTokenId={1}
        onChain={onChain}
        offChain={offChain}
        imageGatewayUrl="https://ipfs.io/ipfs/QmImage"
        ipfsMetadata={{ name: 'Impact SBT' }}
        ipfsError={null}
      />
    );

    expect(screen.getByTestId('sbt-metadata-panel')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('project-1')).toBeInTheDocument();
    expect(screen.getByText('Mở ảnh qua IPFS gateway')).toHaveAttribute('href', 'https://ipfs.io/ipfs/QmImage');
    expect(screen.getByText(/"name": "Impact SBT"/)).toBeInTheDocument();
  });

  it('hiển thị cảnh báo khi metadata IPFS lỗi và vẫn giữ phần còn lại', () => {
    render(
      <SbtMetadataPanel
        onChainTokenId={1}
        onChain={onChain}
        offChain={null}
        imageGatewayUrl={null}
        ipfsMetadata={null}
        ipfsError="IPFS_TIMEOUT"
      />
    );

    expect(screen.getByTestId('sbt-ipfs-error')).toHaveTextContent('IPFS_TIMEOUT');
    expect(screen.getByText('Chưa có metadata off-chain.')).toBeInTheDocument();
  });

  it('không render link tới gateway ngoài allowlist', () => {
    render(
      <SbtMetadataPanel
        onChainTokenId={1}
        onChain={onChain}
        offChain={null}
        imageGatewayUrl="https://attacker.example/ipfs/QmImage"
        ipfsMetadata={null}
        ipfsError={null}
      />
    );

    expect(screen.queryByRole('link', { name: 'Mở ảnh qua IPFS gateway' })).not.toBeInTheDocument();
    expect(screen.getByText('Không có URL gateway ảnh.')).toBeInTheDocument();
  });
});
