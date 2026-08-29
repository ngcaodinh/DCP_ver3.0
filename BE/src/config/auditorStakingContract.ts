import { ethers } from 'ethers';
import { getLogger } from './logger';
import { getBlockchainRpcUrl } from './blockchainRpc';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

const logger = getLogger();

const auditorStakingEthersAbi = [
  'function stakedBalance(address staker) external view returns (uint256)',
  'function minimumStakeThreshold() external view returns (uint256)',
  'function pendingWithdrawAmount(address staker) external view returns (uint256)',
  'function unbondingReleaseAt(address staker) external view returns (uint256)',
  'function unbondingPeriodSeconds() external view returns (uint256)',
  'function rewardPool() external view returns (uint256)',
  'function stake(uint256 amount) external',
  'function requestUnstake(uint256 amount) external',
  'function withdraw() external',
  'function slash(address staker, uint256 amount, string reasonCode) external',
  'function payReward(address recipient, uint256 amount, string reasonCode) external',
  'function fundRewardPool(uint256 amount) external',
  'error InsufficientRewardPool()',
  'error AlreadyProcessedReasonCode()',
  'error EmptyReasonCode()',
  'error InvalidAmount()',
  'error InvalidAddress()',
  'event Staked(address indexed staker, uint256 amount, uint256 newBalance)',
  'event UnstakeRequested(address indexed staker, uint256 amount)',
  'event Withdrawn(address indexed staker, uint256 amount)',
  'event Slashed(address indexed staker, uint256 amount, string reasonCode)'
  , 'event Rewarded(address indexed recipient, uint256 amount, string reasonCode)'
  , 'event RewardPoolFunded(address indexed funder, uint256 amount)'
] as const;

const AUDITOR_STAKING_RPC_BATCH_MAX_COUNT = 3;
let readOnlyProvider: ethers.JsonRpcProvider | null = null;
let readOnlyContract: ethers.Contract | null = null;
let writableContract: ethers.Contract | null = null;
let oracleSigner: ethers.Wallet | null = null;
let treasurySigner: ethers.Wallet | null = null;

/** Đọc và chuẩn hóa địa chỉ AuditorStaking để mọi caller dùng cùng một contract. */
function getAuditorStakingContractAddress(): string {
  const configuredAddress = process.env.AUDITOR_STAKING_ADDRESS?.trim() ?? '';
  if (!configuredAddress) throw new Error('Thiếu cấu hình AUDITOR_STAKING_ADDRESS cho AuditorStaking contract.');
  if (!ethers.isAddress(configuredAddress)) throw new Error('AUDITOR_STAKING_ADDRESS không phải địa chỉ EVM hợp lệ.');
  return ethers.getAddress(configuredAddress);
}

/** Lấy provider readonly được cache cho các truy vấn cọc và worker event. */
export function getReadOnlyAuditorStakingProvider(): ethers.JsonRpcProvider {
  if (!readOnlyProvider) {
    const rpcUrl = getBlockchainRpcUrl();
    if (!rpcUrl) throw new Error('Thiếu BLOCKCHAIN_RPC_URL khi khởi tạo AuditorStaking provider.');
    // RPC hiện tại từ chối batch lớn hơn 3 request; ethers mặc định có thể gom tới 100 request trong cùng event loop.
    readOnlyProvider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      batchMaxCount: AUDITOR_STAKING_RPC_BATCH_MAX_COUNT
    });
  }
  return readOnlyProvider;
}

/** Lấy signer oracle từ cấu hình backend và kiểm tra định dạng private key. */
function getAuditorStakingOracleSigner(): ethers.Wallet {
  if (oracleSigner) return oracleSigner;
  const privateKey = process.env.AUDITOR_STAKING_ORACLE_PRIVATE_KEY?.trim() ?? '';
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('AUDITOR_STAKING_ORACLE_PRIVATE_KEY không đúng format (0x + 64 ký tự hex).');
  }

  oracleSigner = new ethers.Wallet(privateKey);
  return oracleSigner;
}

/** Lấy signer treasury riêng cho fundRewardPool và buộc địa chỉ/key khớp để không dùng nhầm ví deploy hoặc oracle. */
export function getAuditorStakingTreasurySigner(): ethers.Wallet {
  if (treasurySigner) return treasurySigner;
  const privateKey = process.env.AUDITOR_STAKING_TREASURY_PRIVATE_KEY?.trim() ?? '';
  const configuredAddress = process.env.AUDITOR_STAKING_TREASURY_ADDRESS?.trim() ?? '';
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('AUDITOR_STAKING_TREASURY_PRIVATE_KEY không đúng format (0x + 64 ký tự hex).');
  }
  if (!ethers.isAddress(configuredAddress)) {
    throw new Error('AUDITOR_STAKING_TREASURY_ADDRESS không phải địa chỉ EVM hợp lệ.');
  }
  const candidate = new ethers.Wallet(privateKey, getReadOnlyAuditorStakingProvider());
  if (candidate.address !== ethers.getAddress(configuredAddress)) {
    throw new Error('AUDITOR_STAKING_TREASURY_ADDRESS không khớp với private key treasury.');
  }
  if (candidate.address === getAuditorStakingOracleSigner().address) {
    throw new Error('Ví treasury phải tách biệt với AUDITOR_STAKING_ORACLE_PRIVATE_KEY.');
  }
  const minterPrivateKey = process.env.BACKEND_MINTER_PRIVATE_KEY?.trim() ?? '';
  if (/^0x[a-fA-F0-9]{64}$/.test(minterPrivateKey) && candidate.address === new ethers.Wallet(minterPrivateKey).address) {
    throw new Error('Ví treasury phải tách biệt với BACKEND_MINTER_PRIVATE_KEY.');
  }
  treasurySigner = candidate;
  return treasurySigner;
}

/** Lấy contract readonly dùng cho trạng thái cọc và event projection. */
export function getReadOnlyAuditorStakingContract(): ethers.Contract {
  if (!readOnlyContract) {
    readOnlyContract = new ethers.Contract(
      getAuditorStakingContractAddress(),
      auditorStakingEthersAbi,
      getReadOnlyAuditorStakingProvider()
    );
  }
  return readOnlyContract;
}

/** Lấy contract writable chỉ cho worker phạt cọc và thưởng sau khi phán quyết đã chốt. */
export function getWritableAuditorStakingContract(): ethers.Contract {
  if (!writableContract) {
    writableContract = new ethers.Contract(
      getAuditorStakingContractAddress(),
      auditorStakingEthersAbi,
      getAuditorStakingOracleSigner().connect(getReadOnlyAuditorStakingProvider())
    );
  }
  return writableContract;
}

/** Trả địa chỉ lowercase để so sánh scope checkpoint ổn định giữa các lần chạy. */
export function getAuditorStakingContractAddressLowercase(): string {
  return getAuditorStakingContractAddress().toLowerCase();
}

/** Kiểm tra bytecode contract trước khi worker bắt đầu quét event trên một cấu hình mới. */
export async function verifyAuditorStakingContractDeployed(address: string): Promise<boolean> {
  return (await getReadOnlyAuditorStakingProvider().getCode(address)) !== '0x';
}

/** Log signer address duy nhất để vận hành xác nhận SLASHER_ROLE mà không lộ private key. */
export async function logAuditorStakingSignerAddressOnce(): Promise<void> {
  try {
    const signer = getAuditorStakingOracleSigner();
    const contractAddress = getAuditorStakingContractAddressLowercase();
    logger.info('AuditorStaking oracle signer initialized.', {
      signerAddress: signer.address,
      contractDeployed: await verifyAuditorStakingContractDeployed(contractAddress)
    });
  } catch (error) {
    logger.warn('AuditorStaking oracle signer chưa sẵn sàng.', {
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  }
}
