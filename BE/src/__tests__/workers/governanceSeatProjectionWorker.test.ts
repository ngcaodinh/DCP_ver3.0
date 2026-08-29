import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  contractConstructor: vi.fn(),
  findCheckpoint: vi.fn(),
  getBlock: vi.fn(),
  getBlockNumber: vi.fn(),
  getNetwork: vi.fn(),
  isAddress: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  providerConstructor: vi.fn(),
  queryFilter: vi.fn(),
  reconcileRoster: vi.fn(),
  saveCheckpoint: vi.fn(),
  upsertEvent: vi.fn()
}));

vi.mock('../../config/logger', () => ({
  getLogger: () => ({ info: mocks.loggerInfo, warn: mocks.loggerWarn })
}));
vi.mock('../../config/requestContext', () => ({
  runWithWorkerContext: async (_name: string, work: () => Promise<void>) => work()
}));
vi.mock('../../models/governanceSeatProjectionCheckpointModel', () => ({
  findGovernanceSeatProjectionCheckpoint: mocks.findCheckpoint,
  saveGovernanceSeatProjectionCheckpoint: mocks.saveCheckpoint
}));
vi.mock('../../models/publicCommitteeGovernanceEventModel', () => ({
  upsertPublicCommitteeGovernanceEvent: mocks.upsertEvent
}));
vi.mock('../../services/governanceSeatService', () => ({ reconcileGovernanceRosterFromChain: mocks.reconcileRoster }));
vi.mock('ethers', () => ({
  ethers: {
    Contract: mocks.contractConstructor,
    JsonRpcProvider: mocks.providerConstructor,
    isAddress: mocks.isAddress
  }
}));

import { runGovernanceSeatProjectionCycle } from '../../workers/governanceSeatProjectionWorker';

const originalEnvironment = {
  rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
  contractAddress: process.env.COMMITTEE_GOVERNANCE_ADDRESS,
  deploymentBlock: process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK
};

describe('governance seat projection worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BLOCKCHAIN_RPC_URL = 'https://rpc.example.test';
    process.env.COMMITTEE_GOVERNANCE_ADDRESS = '0x1111111111111111111111111111111111111111';
    process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK = '10';
    mocks.isAddress.mockReturnValue(true);
    mocks.getNetwork.mockResolvedValue({ chainId: 80002n });
    mocks.getBlockNumber.mockResolvedValue(15);
    mocks.getBlock.mockResolvedValue({ timestamp: 1_756_425_600 });
    mocks.findCheckpoint.mockResolvedValue(null);
    mocks.queryFilter.mockResolvedValue([]);
    mocks.upsertEvent.mockResolvedValue(undefined);
    mocks.saveCheckpoint.mockResolvedValue(undefined);
    mocks.reconcileRoster.mockResolvedValue(undefined);
    mocks.providerConstructor.mockImplementation(() => ({
      getNetwork: mocks.getNetwork,
      getBlockNumber: mocks.getBlockNumber,
      getBlock: mocks.getBlock
    }));
    mocks.contractConstructor.mockImplementation(() => ({
      filters: {
        SeatsBootstrapped: () => 'SeatsBootstrapped',
        DecisionRecorded: () => 'DecisionRecorded',
        SeatChangeProposed: () => 'SeatChangeProposed',
        SeatChangeExecuted: () => 'SeatChangeExecuted'
      },
      queryFilter: mocks.queryFilter
    }));
  });

  afterEach(() => {
    if (originalEnvironment.rpcUrl === undefined) delete process.env.BLOCKCHAIN_RPC_URL;
    else process.env.BLOCKCHAIN_RPC_URL = originalEnvironment.rpcUrl;
    if (originalEnvironment.contractAddress === undefined) delete process.env.COMMITTEE_GOVERNANCE_ADDRESS;
    else process.env.COMMITTEE_GOVERNANCE_ADDRESS = originalEnvironment.contractAddress;
    if (originalEnvironment.deploymentBlock === undefined) delete process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK;
    else process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK = originalEnvironment.deploymentBlock;
  });

  it('không gọi RPC khi cấu hình projector không hợp lệ', async () => {
    mocks.isAddress.mockReturnValue(false);

    await runGovernanceSeatProjectionCycle();

    expect(mocks.providerConstructor).not.toHaveBeenCalled();
    expect(mocks.findCheckpoint).not.toHaveBeenCalled();
  });

  it('project event SeatChangeExecuted, đối soát roster và checkpoint theo block/log', async () => {
    mocks.queryFilter
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        blockNumber: 12, index: 4, transactionHash: '0xevent',
        args: [9n, '0xold', '0xnew'], fragment: { name: 'SeatChangeExecuted' }
      }]);

    await runGovernanceSeatProjectionCycle();

    expect(mocks.upsertEvent).toHaveBeenCalledWith(expect.objectContaining({
      chainId: '80002', contractAddress: process.env.COMMITTEE_GOVERNANCE_ADDRESS?.toLowerCase(),
      transactionHash: '0xevent', blockNumber: 12, logIndex: 4, eventType: 'SEAT_CHANGE_EXECUTED',
      eventData: { proposalId: '9', oldSeat: '0xold', newSeat: '0xnew' }
    }));
    expect(mocks.reconcileRoster).toHaveBeenCalledOnce();
    expect(mocks.saveCheckpoint).toHaveBeenNthCalledWith(
      1,
      { chainId: '80002', contractAddress: process.env.COMMITTEE_GOVERNANCE_ADDRESS?.toLowerCase() },
      12,
      4
    );
    expect(mocks.saveCheckpoint).toHaveBeenLastCalledWith(expect.anything(), 13, Number.MAX_SAFE_INTEGER);
  });

  it('bỏ qua event đã nằm trong checkpoint để projector replay không có side effect trùng', async () => {
    mocks.findCheckpoint.mockResolvedValue({ lastProcessedBlock: 12, lastProcessedLogIndex: 4 });
    mocks.queryFilter
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        blockNumber: 12, index: 4, transactionHash: '0xduplicated',
        args: [9n, '0xold', '0xnew'], fragment: { name: 'SeatChangeExecuted' }
      }]);

    await runGovernanceSeatProjectionCycle();

    expect(mocks.upsertEvent).not.toHaveBeenCalled();
    expect(mocks.reconcileRoster).not.toHaveBeenCalled();
    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(expect.anything(), 13, Number.MAX_SAFE_INTEGER);
  });

  it('giữ checkpoint cũ khi một event không thể project để chu kỳ sau retry an toàn', async () => {
    mocks.queryFilter
      .mockResolvedValueOnce([{
        blockNumber: 10, index: 1, transactionHash: '0xfailure',
        args: [[], []], fragment: { name: 'SeatsBootstrapped' }
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.upsertEvent.mockRejectedValue(new Error('database unavailable'));

    await runGovernanceSeatProjectionCycle();

    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('Projector ghế ủy ban thất bại'), expect.anything());
  });
});
