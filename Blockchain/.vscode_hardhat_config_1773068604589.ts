require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const amoyRpcUrl = process.env.AMOY_RPC_URL || '';
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY || '';

/**
 * Hàm trả về danh sách tài khoản deploy.
 * Mục đích: chỉ cấu hình account khi có private key hợp lệ trong môi trường.
 */
function getNetworkAccounts() {
  if (!deployerPrivateKey) {
    return [];
  }

  return [deployerPrivateKey];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.20',
  networks: {
    hardhat: {},
    amoy: {
      url: amoyRpcUrl,
      accounts: getNetworkAccounts()
    }
  }
};

