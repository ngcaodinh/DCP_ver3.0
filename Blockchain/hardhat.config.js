import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers';
import dotenv from 'dotenv';

dotenv.config();

const amoyRpcUrl = process.env.AMOY_RPC_URL || '';
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY || '';
const polygonscanApiKey = process.env.POLYGONSCAN_API_KEY || '';
const amoyExplorerApiKey = process.env.AMOY_EXPLORER_API_KEY || polygonscanApiKey;

function getNetworkAccounts() {
  if (!deployerPrivateKey) {
    return [];
  }
  return [deployerPrivateKey];
}

function createNetworksConfig() {
  const networks = {};

  if (amoyRpcUrl) {
    networks.amoy = {
      type: 'http',
      url: amoyRpcUrl,
      accounts: getNetworkAccounts()
    };
  }

  return networks;
}

const config = {
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    compilers: [
      {
        version: '0.8.28',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          },
          viaIR: true
        }
      }
    ]
  },
  networks: createNetworksConfig(),
  etherscan: {
    apiKey: {
      polygonAmoy: amoyExplorerApiKey || polygonscanApiKey,
      polygon: polygonscanApiKey
    }
  },
  paths: {
    tests: './test'
  },
  test: {
    mocha: {
      timeout: 30000
    }
  }
};

export default config;
