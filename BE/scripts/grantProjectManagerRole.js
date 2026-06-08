const { config } = require('dotenv');
const { ethers } = require('ethers');

config();

const donationRankingContractAbi = [
  'function projectManagerRole() external view returns (bytes32)',
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function grantProjectManagerRole(address account) external'
];

/** Hàm lấy biến môi trường bắt buộc. Mục đích: dừng script sớm khi thiếu cấu hình quan trọng. */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/** Hàm lấy giá trị tham số CLI theo tên. Mục đích: hỗ trợ override cấu hình khi vận hành thủ công. */
function getCliArgumentValue(argumentName) {
  const argumentPrefix = `--${argumentName}=`;
  const argumentItem = process.argv.find((item) => item.startsWith(argumentPrefix));
  return argumentItem ? argumentItem.slice(argumentPrefix.length).trim() : '';
}

/** Hàm chuẩn hóa private key. Mục đích: đảm bảo private key đúng định dạng 0x + 64 ký tự hex. */
function normalizePrivateKey(privateKeyValue) {
  const rawPrivateKey = privateKeyValue.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(rawPrivateKey)) {
    throw new Error('Private key không hợp lệ. Cần đúng 64 ký tự hex.');
  }
  return `0x${rawPrivateKey}`;
}

/** Hàm lấy địa chỉ ví cần cấp PROJECT_MANAGER_ROLE. Mục đích: ưu tiên CLI, sau đó dùng địa chỉ từ relayer private key. */
function resolveTargetWalletAddress() {
  const cliWalletAddress = getCliArgumentValue('targetWalletAddress');
  if (cliWalletAddress) {
    if (!ethers.isAddress(cliWalletAddress)) {
      throw new Error('targetWalletAddress không phải địa chỉ ví hợp lệ.');
    }
    return cliWalletAddress;
  }

  const relayerPrivateKey = process.env.PROJECT_MANAGER_PRIVATE_KEY || process.env.DONATION_RELAYER_PRIVATE_KEY || '';
  const normalizedRelayerPrivateKey = normalizePrivateKey(relayerPrivateKey || getRequiredEnvironmentVariable('PROJECT_MANAGER_PRIVATE_KEY'));
  return new ethers.Wallet(normalizedRelayerPrivateKey).address;
}

/** Hàm cấp PROJECT_MANAGER_ROLE cho ví vận hành. Mục đích: đảm bảo relayer có quyền tạo/activate project on-chain. */
async function grantProjectManagerRole() {
  const blockchainRpcUrl = getRequiredEnvironmentVariable('BLOCKCHAIN_RPC_URL');
  const donationRankingContractAddress =
    process.env.DONATION_RANKING_CONTRACT_ADDRESS?.trim()
    || process.env.DONATION_RANKING_ADDRESS?.trim()
    || getRequiredEnvironmentVariable('DONATION_RANKING_CONTRACT_ADDRESS');

  const adminPrivateKey = normalizePrivateKey(
    getCliArgumentValue('adminPrivateKey')
    || process.env.DONATION_ADMIN_PRIVATE_KEY
    || process.env.DEPLOYER_PRIVATE_KEY
    || ''
  );

  const targetWalletAddress = resolveTargetWalletAddress();
  const provider = new ethers.JsonRpcProvider(blockchainRpcUrl);
  const adminWallet = new ethers.Wallet(adminPrivateKey, provider);
  const donationRankingContract = new ethers.Contract(donationRankingContractAddress, donationRankingContractAbi, adminWallet);

  const projectManagerRoleHash = await donationRankingContract.projectManagerRole();
  const hasRoleBefore = await donationRankingContract.hasRole(projectManagerRoleHash, targetWalletAddress);

  console.log('Admin wallet:', adminWallet.address);
  console.log('Target wallet:', targetWalletAddress);
  console.log('Has PROJECT_MANAGER_ROLE before:', hasRoleBefore);

  if (!hasRoleBefore) {
    const grantRoleTransaction = await donationRankingContract.grantProjectManagerRole(targetWalletAddress);
    console.log('Grant tx hash:', grantRoleTransaction.hash);
    await grantRoleTransaction.wait(1);
  }

  const hasRoleAfter = await donationRankingContract.hasRole(projectManagerRoleHash, targetWalletAddress);
  console.log('Has PROJECT_MANAGER_ROLE after:', hasRoleAfter);

  if (!hasRoleAfter) {
    throw new Error('Cấp PROJECT_MANAGER_ROLE thất bại.');
  }
}

grantProjectManagerRole().catch((error) => {
  console.error('Grant PROJECT_MANAGER_ROLE thất bại:', error.message);
  process.exit(1);
});
