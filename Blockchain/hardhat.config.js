import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-mocha';
import '@nomicfoundation/hardhat-toolbox-mocha-ethers';
import dotenv from 'dotenv';

dotenv.config();

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

/**
 * Hàm tạo cấu hình network một cách an toàn.
 * Mục đích: chỉ thêm mạng amoy khi có RPC URL hợp lệ để tránh lỗi validate config ở local.
 */
function createNetworksConfig() {
  if (!amoyRpcUrl) {
    return {};
  }

  return {
    amoy: {
      type: 'http',
      url: amoyRpcUrl,
      accounts: getNetworkAccounts()
    }
  };
}

const hardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  networks: createNetworksConfig()
};

export default hardhatUserConfig;

