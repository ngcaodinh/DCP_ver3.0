import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDonationCertificateConfig: vi.fn(),
  findCertificatesNeedingReconciliation: vi.fn(),
  findIssuedCertificatesForReverification: vi.fn(),
  findIssuedCertificatesPastReverificationWindow: vi.fn(),
  getDonationCertificateQueue: vi.fn(),
  closeDonationCertificateQueues: vi.fn(),
  enqueueDonationCertificateJob: vi.fn(),
  moveDonationCertificateJobToDlq: vi.fn(),
  processDonationCertificateFinalityCheck: vi.fn(),
  reverifyIssuedDonationCertificate: vi.fn(),
  completeDonationCertificateReverificationWindow: vi.fn(),
  getCurrentDonationCertificateBlockNumber: vi.fn(),
  process: vi.fn()
}));

vi.mock('../../config/donationCertificateConfig', () => ({
  getDonationCertificateConfig: mocks.getDonationCertificateConfig
}));

vi.mock('../../repositories/donationCertificateRepository', () => ({
  findCertificatesNeedingReconciliation: mocks.findCertificatesNeedingReconciliation,
  findIssuedCertificatesForReverification: mocks.findIssuedCertificatesForReverification,
  findIssuedCertificatesPastReverificationWindow: mocks.findIssuedCertificatesPastReverificationWindow
}));

vi.mock('../../queues/donationCertificateQueue', () => ({
  getDonationCertificateQueue: mocks.getDonationCertificateQueue,
  closeDonationCertificateQueues: mocks.closeDonationCertificateQueues,
  enqueueDonationCertificateJob: mocks.enqueueDonationCertificateJob,
  moveDonationCertificateJobToDlq: mocks.moveDonationCertificateJobToDlq
}));

vi.mock('../../services/donationCertificateIssuance.service', () => ({
  processDonationCertificateFinalityCheck: mocks.processDonationCertificateFinalityCheck,
  reverifyIssuedDonationCertificate: mocks.reverifyIssuedDonationCertificate,
  completeDonationCertificateReverificationWindow: mocks.completeDonationCertificateReverificationWindow
}));
vi.mock('../../services/donationCertificateFinality.service', () => ({
  getCurrentDonationCertificateBlockNumber: mocks.getCurrentDonationCertificateBlockNumber
}));

import { startDonationCertificateWorker, stopDonationCertificateWorker } from '../../workers/donationCertificateWorker';

describe('donationCertificateWorker startup gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDonationCertificateConfig.mockReturnValue({ enabled: true });
    mocks.getDonationCertificateQueue.mockReturnValue({ process: mocks.process });
    mocks.findCertificatesNeedingReconciliation.mockResolvedValue([]);
    mocks.findIssuedCertificatesForReverification.mockResolvedValue([]);
    mocks.findIssuedCertificatesPastReverificationWindow.mockResolvedValue([]);
    mocks.getCurrentDonationCertificateBlockNumber.mockResolvedValue(null);
    mocks.closeDonationCertificateQueues.mockResolvedValue(undefined);
    process.env.RUN_WORKERS = 'true';
  });

  afterEach(async () => {
    await stopDonationCertificateWorker();
    delete process.env.RUN_WORKERS;
  });

  it('khởi động khi RUN_WORKERS=true', () => {
    startDonationCertificateWorker({
      sendIssuedEmail: vi.fn(),
      sendRevokedEmail: vi.fn()
    });

    expect(mocks.process).toHaveBeenCalledTimes(1);
  });

  it('khởi động khi RUN_WORKERS không được khai báo, đồng bộ với server.ts', () => {
    delete process.env.RUN_WORKERS;

    startDonationCertificateWorker({
      sendIssuedEmail: vi.fn(),
      sendRevokedEmail: vi.fn()
    });

    expect(mocks.process).toHaveBeenCalledTimes(1);
  });

  it('không khởi động khi RUN_WORKERS=false hoặc feature bị tắt', () => {
    process.env.RUN_WORKERS = 'false';
    startDonationCertificateWorker({ sendIssuedEmail: vi.fn(), sendRevokedEmail: vi.fn() });
    expect(mocks.process).not.toHaveBeenCalled();

    process.env.RUN_WORKERS = 'true';
    mocks.getDonationCertificateConfig.mockReturnValue({ enabled: false });
    startDonationCertificateWorker({ sendIssuedEmail: vi.fn(), sendRevokedEmail: vi.fn() });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it('enqueue reverify trong cửa sổ reorg và chốt record đã quá cửa sổ', async () => {
    process.env.RUN_WORKERS = 'true';
    mocks.getCurrentDonationCertificateBlockNumber.mockResolvedValue(1_000);
    mocks.findIssuedCertificatesForReverification.mockResolvedValue([{ certificateId: 'DCP-2026-ACTIVE', finalityCheckCount: 3 }]);
    mocks.findIssuedCertificatesPastReverificationWindow.mockResolvedValue([{ certificateId: 'DCP-2026-EXPIRED', finalityCheckCount: 2 }]);
    mocks.enqueueDonationCertificateJob.mockResolvedValue({ enqueued: true });

    startDonationCertificateWorker({ sendIssuedEmail: vi.fn(), sendRevokedEmail: vi.fn() });
    await vi.waitFor(() => expect(mocks.enqueueDonationCertificateJob).toHaveBeenCalledWith({
      kind: 'REVERIFY_ISSUED',
      certificateId: 'DCP-2026-ACTIVE',
      checkSequence: 4
    }, 0));

    expect(mocks.completeDonationCertificateReverificationWindow).toHaveBeenCalledWith('DCP-2026-EXPIRED');
  });
});
