const { config } = require('dotenv');
const { ethers } = require('ethers');

config();

const charityTokenAbi = [
  'function minterRole() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantMinterRole(address account) external'
];

/**
 * Hàm lấy biến môi trường bắt buộc.
 * Mục đích: dừng script sớm khi thiếu cấu hình cần thiết.
 */
function getRequiredEnvironmentVariable(variableName) {
  const variableValue = String(process.env[variableName] || '').trim();
  if (!variableValue) {
    throw new Error(`Thiếu biến môi trường: ${variableName}`);
  }
  return variableValue;
}

/**
 * Hàm lấy giá trị từ tham số CLI theo tên.
 * Mục đích: cho phép override cấu hình môi trường khi cần.
 */
function getCliArgumentValue(argumentName) {
  const argumentPrefix = `--${argumentName}=`;
  const argumentItem = process.argv.find((item) => item.startsWith(argumentPrefix));
  if (!argumentItem) {
    return '';
  }
  return argumentItem.slice(argumentPrefix.length).trim();
}

/**
 * Hàm chuẩn hóa private key về định dạng 0x + 64 hex.
 * Mục đích: tránh lỗi invalid private key do thiếu tiền tố hoặc có khoảng trắng.
 */
function normalizePrivateKey(privateKeyValue) {
  const rawPrivateKey = privateKeyValue.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(rawPrivateKey)) {
    throw new Error('Private key không hợp lệ. Cần đúng 64 ký tự hex.');
  }
  return `0x${rawPrivateKey}`;
}

/**
 * Hàm cấp quyền MINTER_ROLE cho backend minter address.
 * Mục đích: đảm bảo backend có quyền gọi mintFromBackend trên contract token.
 */
async function grantMinterRole() {
  const rpcUrl = getRequiredEnvironmentVariable('BLOCKCHAIN_RPC_URL');
  const contractAddress = getRequiredEnvironmentVariable('CHARITY_TOKEN_CONTRACT_ADDRESS');

  const adminPrivateKey = normalizePrivateKey(
    getCliArgumentValue('adminPrivateKey')
    || process.env.BACKEND_ADMIN_PRIVATE_KEY
    || process.env.DEPLOYER_PRIVATE_KEY
    || getRequiredEnvironmentVariable('BACKEND_MINTER_PRIVATE_KEY')
  );

  const minterAddressInput = getCliArgumentValue('minterAddress')
    || process.env.BACKEND_MINTER_ADDRESS
    || new ethers.Wallet(normalizePrivateKey(getRequiredEnvironmentVariable('BACKEND_MINTER_PRIVATE_KEY'))).address;

  if (!ethers.isAddress(minterAddressInput)) {
    throw new Error('BACKEND_MINTER_ADDRESS không phải địa chỉ ví hợp lệ.');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const adminWallet = new ethers.Wallet(adminPrivateKey, provider);
  const tokenContract = new ethers.Contract(contractAddress, charityTokenAbi, adminWallet);

  const minterRole = await tokenContract.minterRole();
  const hadRoleBefore = await tokenContract.hasRole(minterRole, minterAddressInput);

  console.log('Admin wallet:', adminWallet.address);
  console.log('Minter address:', minterAddressInput);
  console.log('Has MINTER_ROLE before:', hadRoleBefore);

  if (!hadRoleBefore) {
    const grantTransaction = await tokenContract.grantMinterRole(minterAddressInput);
    console.log('Grant tx hash:', grantTransaction.hash);
    await grantTransaction.wait(1);
  }

  const hasRoleAfter = await tokenContract.hasRole(minterRole, minterAddressInput);
  console.log('Has MINTER_ROLE after:', hasRoleAfter);

  if (!hasRoleAfter) {
    throw new Error('Cấp quyền MINTER_ROLE thất bại.');
  }
}

grantMinterRole().catch((error) => {
  console.error('Grant minter role thất bại:', error.message);
  process.exit(1);
});

