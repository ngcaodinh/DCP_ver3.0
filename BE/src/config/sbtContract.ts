import { ethers } from 'ethers';
import { getLogger } from './logger';

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
  'event SBTMinted(address indexed to, uint256 indexed tokenId, string tokenURI_)'
] as const;

/**
 * Lấy readonly provider (JsonRpcProvider) cho ImpactSBT contract.
 * Mục đích: dùng cho các thao tác đọc / chờ receipt.
 */
function getReadOnlyProvider(): ethers.JsonRpcProvider {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL?.trim() ?? '';
  if (!rpcUrl) {
    throw new Error('Thiếu BLOCKCHAIN_RPC_URL khi khởi tạo ImpactSBT provider.');
  }
  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Lấy signer EOA (ví backend) cho ImpactSBT contract.
 * Mục đích: dùng cho hàm mint(). Yêu cầu địa chỉ ví này được cấp ORACLE_ROLE trên contract
 * (do owner grant qua transferOracleRole hoặc cấu hình ban đầu trong constructor).
 *
 * Lưu ý: Hiện tại task C2 dùng lại BACKEND_MINTER_PRIVATE_KEY (đã có sẵn trong env và
 * đang được dùng cho CharityToken). Nếu sau này tách Oracle signer riêng, chỉ cần
 * đổi biến môi trường ở đây, các service/worker vẫn giữ nguyên pattern.
 */
function getOracleSigner(): ethers.Wallet {
  const privateKey = process.env.BACKEND_MINTER_PRIVATE_KEY?.trim() ?? '';
  if (!privateKey) {
    throw new Error('Thiếu BACKEND_MINTER_PRIVATE_KEY khi khởi tạo ImpactSBT Oracle signer.');
  }
  return new ethers.Wallet(privateKey);
}

/**
 * Lấy writable contract (gắn với signer) — dùng để gọi mint() on-chain.
 * Mục đích: tạo instance ethers.Contract có thể gửi transaction từ Oracle EOA.
 */
export function getWritableImpactSbtContract(): ethers.Contract {
  const provider = getReadOnlyProvider();
  const signer = getOracleSigner().connect(provider);
  return new ethers.Contract(getImpactSbtContractAddress(), impactSbtEthersAbi, signer);
}

/**
 * Lấy readonly contract — dùng cho view calls như ownerOf / tokenURI.
 * Mục đích: tránh gắn signer khi không cần thiết.
 */
export function getReadOnlyImpactSbtContract(): ethers.Contract {
  return new ethers.Contract(getImpactSbtContractAddress(), impactSbtEthersAbi, getReadOnlyProvider());
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
export function logOracleSignerAddressOnce(): void {
  try {
    const signer = getOracleSigner();
    logger.info('ImpactSBT Oracle signer initialized.', { toAddress: signer.address });
  } catch (error) {
    logger.warn('ImpactSBT Oracle signer chưa sẵn sàng.', { errorMessage: (error as Error).message });
  }
}
