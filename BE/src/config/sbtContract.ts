import { ethers } from 'ethers';
import { getLogger } from './logger';
import { getBlockchainRpcUrl } from './blockchainRpc';
import { sanitizeProviderError } from '../utils/sanitizeProviderError';

const logger = getLogger();

/**
 * Trích địa chỉ ImpactSBT contract từ biến môi trường.
 * Mục đích: cung cấp địa chỉ contract on-chain duy nhất cho toàn bộ luồng mint.
 * Throw rõ ràng nếu thiếu cấu hình để tránh gọi sai contract trong production.
 */
function getImpactSbtContractAddress(): string {
  const addressFromEnv = process.env.IMPACT_SBT_ADDRESS?.trim() ?? '';
  if (!addressFromEnv) {
    throw new Error('Thiếu cấu hình IMPACT_SBT_ADDRESS cho ImpactSBT contract.');
  }
  if (!ethers.isAddress(addressFromEnv)) {
    throw new Error(`IMPACT_SBT_ADDRESS không phải địa chỉ EVM hợp lệ: ${addressFromEnv}`);
  }
  return ethers.getAddress(addressFromEnv);
}

/**
 * ABI tối thiểu của ImpactSBT dùng cho backend worker.
 * Chỉ giữ các hàm worker cần (mint) và event SBTMinted để parse tokenId từ receipt.
 * Định nghĩa bằng ethers human-readable ABI để tránh sai sót khi encode/decode.
 */
const impactSbtEthersAbi = [
  'function mint(address to, uint256 projectId, uint256 milestone, uint256 beneficiaryCount, string gpsCoordinates, string imageCID, string tokenURI_) external returns (uint256 tokenId)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function getTokenMetadata(uint256 tokenId) external view returns (uint256 projectId, uint256 milestone, uint256 beneficiaryCount, string gpsCoordinates, string imageCID, uint256 mintedAt)',
  'function getTokenStatus(uint256 tokenId) external view returns (uint8)',
  'function updateTokenStatus(uint256 tokenId, uint8 newStatus, string reason) external',
  'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)',
  'event TokenStatusUpdated(uint256 indexed tokenId, uint8 newStatus, string reason)',
  'error TokenNotExists()',
  'error InvalidStatus()',
  'error InvalidTransition()'
] as const;

/**
 * Lấy readonly provider (JsonRpcProvider) cho ImpactSBT contract.
 * Mục đích: dùng cho các thao tác đọc / chờ receipt.
 *
 * [B-B1] Cache provider ở module level — tránh tạo JsonRpcProvider mới mỗi lần gọi.
 * JsonRpcProvider không hold persistent connection, chỉ hold URL + fetch config.
 * Việc cache giảm GC pressure và đảm bảo connection pooling được reuse.
 */
let _readOnlyProvider: ethers.JsonRpcProvider | null = null;

// Cache ethers.Contract instances để tránh tạo mới mỗi lần (BLOCKER #8)
// ethers.Contract với provider không hold persistent connection, chỉ hold reference.
// Việc cache giảm overhead và đảm bảo singleton cho toàn bộ ứng dụng.
let _readOnlyContract: ethers.Contract | null = null;
let _writableContract: ethers.Contract | null = null;
let _oracleSigner: ethers.Wallet | null = null;

export function getReadOnlyImpactSbtProvider(): ethers.JsonRpcProvider {
  if (!_readOnlyProvider) {
    const rpcUrl = getBlockchainRpcUrl();
    if (!rpcUrl) {
      throw new Error('Thiếu BLOCKCHAIN_RPC_URL khi khởi tạo ImpactSBT provider.');
    }
    _readOnlyProvider = new ethers.JsonRpcProvider(rpcUrl);
  }
  return _readOnlyProvider;
}

/**
 * Lấy signer EOA (ví backend) cho ImpactSBT contract.
 * Mục đích: dùng cho hàm mint(). Yêu cầu địa chỉ ví này được cấp ORACLE_ROLE trên contract
 * (do owner grant qua transferOracleRole hoặc cấu hình ban đầu trong constructor).
 *
 * SBT signer phải là EOA riêng, chỉ được cấp ORACLE_ROLE trên ImpactSBT.
 * Không dùng chung với BACKEND_MINTER_PRIVATE_KEY của CharityToken để tránh
 * collision nonce giữa hai contract và giới hạn blast radius của khóa.
 *
 * [B-B2] Cache signer để tránh tạo mới mỗi lần. ethers.Wallet nhẹ, nhưng cache giúp
 * đảm bảo singleton và giảm GC overhead trong hot path mint.
 */
function getOracleSigner(): ethers.Wallet {
  if (_oracleSigner) {
    return _oracleSigner;
  }
  const privateKey = process.env.IMPACT_SBT_MINTER_PRIVATE_KEY?.trim() ?? '';
  if (!privateKey) {
    throw new Error('Thiếu IMPACT_SBT_MINTER_PRIVATE_KEY khi khởi tạo ImpactSBT Oracle signer.');
  }
  // Validate format: phải là 0x + 64 ký tự hex (256-bit key) — BLOCKER #1 fix
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('IMPACT_SBT_MINTER_PRIVATE_KEY không đúng format (0x + 64 ký tự hex).');
  }
  const charityPrivateKey = process.env.BACKEND_MINTER_PRIVATE_KEY?.trim() ?? '';
  const normalizedCharityKey = charityPrivateKey.replace(/^0x/i, '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalizedCharityKey) && normalizedCharityKey === privateKey.slice(2).toLowerCase()) {
    throw new Error('IMPACT_SBT_MINTER_PRIVATE_KEY phải khác BACKEND_MINTER_PRIVATE_KEY.');
  }
  _oracleSigner = new ethers.Wallet(privateKey);
  return _oracleSigner;
}

/** Trả về public address của EOA mint để allocator nonce không bao giờ log hoặc đọc private key. */
export function getImpactSbtMintSignerAddress(): string {
  return getOracleSigner().address;
}

/**
 * Lấy writable contract (gắn với signer) — dùng để gọi mint() on-chain.
 * Mục đích: tạo instance ethers.Contract có thể gửi transaction từ Oracle EOA.
 *
 * [B-B3] Cache contract instance — tránh tạo mới mỗi lần gọi mint().
 * ethers.Contract với signer không hold persistent connection, chỉ hold provider reference.
 * Việc cache đảm bảo singleton và giảm GC overhead trong hot path.
 */
export function getWritableImpactSbtContract(): ethers.Contract {
  if (_writableContract) {
    return _writableContract;
  }
  const provider = getReadOnlyImpactSbtProvider();
  const signer = getOracleSigner().connect(provider);
  _writableContract = new ethers.Contract(getImpactSbtContractAddress(), impactSbtEthersAbi, signer);
  return _writableContract;
}

/**
 * Lấy readonly contract — dùng cho view calls như ownerOf / tokenURI.
 * Mục đích: tránh gắn signer khi không cần thiết.
 *
 * [B-B3] Cache readonly contract instance để tránh tạo mới mỗi lần gọi.
 */
export function getReadOnlyImpactSbtContract(): ethers.Contract {
  if (_readOnlyContract) {
    return _readOnlyContract;
  }
  _readOnlyContract = new ethers.Contract(getImpactSbtContractAddress(), impactSbtEthersAbi, getReadOnlyImpactSbtProvider());
  return _readOnlyContract;
}

/**
 * Kiểm tra contract có deployed tại địa chỉ hay không.
 * Dùng cho health check / startup validation.
 * KHÔNG gọi trong hot path (mỗi mint) vì thêm 1 RPC call.
 */
export async function verifyContractDeployed(address: string): Promise<boolean> {
  const provider = getReadOnlyImpactSbtProvider();
  const code = await provider.getCode(address);
  return code !== '0x';
}

/**
 * Lấy địa chỉ contract (lowercase) — dùng để log/validate không lộ checksum.
 * Mục đích: chuẩn hóa địa chỉ trước khi so sánh hoặc hiển thị.
 */
export function getImpactSbtContractAddressLowercase(): string {
  return getImpactSbtContractAddress().toLowerCase();
}

/**
 * Hàm log an toàn khi khởi tạo module — không in private key, chỉ in địa chỉ ví Oracle.
 * Mục đích: giúp debug signer mismatch (địa chỉ ví khác ORACLE_ROLE) mà không lộ secret.
 */
export async function logOracleSignerAddressOnce(): Promise<void> {
  try {
    const signer = getOracleSigner();
    const contractAddress = getImpactSbtContractAddressLowercase();
    const isDeployed = await verifyContractDeployed(contractAddress);

    logger.info('ImpactSBT Oracle signer initialized.', {
      toAddress: signer.address,
      contractDeployed: isDeployed
    } as Record<string, unknown>);

    if (!isDeployed) {
      logger.warn('ImpactSBT contract chưa deployed tại địa chỉ này. Kiểm tra IMPACT_SBT_ADDRESS.', {
        contractAddress
      } as Record<string, unknown>);
    }
  } catch (error) {
    logger.warn('ImpactSBT Oracle signer chưa sẵn sàng.', {
      errorMessage: sanitizeProviderError(error) ?? 'UNKNOWN_ERROR'
    });
  }
}
