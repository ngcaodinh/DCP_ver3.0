import { ethers } from 'ethers';
import { recordBlockchainTransaction } from '../utils/blockchainMetrics';

const mintAbi = [
  'function mintFromBackend(address receiver, uint256 amount, string orderCode) external returns (bool)'
];

type MintResult = {
  transactionHash: string;
};

/**
 * Hàm mint token on-chain cho giao dịch nạp tiền.
 * Mục đích: gọi smart contract sau khi webhook thanh toán đã được xác thực hợp lệ.
 */
export async function mintTokenForDeposit(walletAddress: string, amountToken: number, orderCode: string): Promise<MintResult> {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const privateKey = process.env.BACKEND_MINTER_PRIVATE_KEY;
  const tokenContractAddress = process.env.CHARITY_TOKEN_CONTRACT_ADDRESS;

  if (!rpcUrl || !privateKey || !tokenContractAddress) {
    throw new Error('Thiếu cấu hình mint on-chain. Kiểm tra BLOCKCHAIN_RPC_URL, BACKEND_MINTER_PRIVATE_KEY, CHARITY_TOKEN_CONTRACT_ADDRESS.');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const tokenContract = new ethers.Contract(tokenContractAddress, mintAbi, signer);

  const submittedAtMs = Date.now();
  const mintTransaction = await tokenContract.mintFromBackend(walletAddress, amountToken, orderCode);
  const transactionReceipt = await mintTransaction.wait(2);

  if (!transactionReceipt?.hash) {
    throw new Error('Không lấy được transaction hash sau khi mint token.');
  }

  recordBlockchainTransaction({
    operation: 'mint_deposit',
    receipt: transactionReceipt,
    startedAtMs: submittedAtMs
  });

  if (transactionReceipt.status !== 1) {
    throw new Error(`Mint token nạp tiền bị revert on-chain (hash=${transactionReceipt.hash}, status=${transactionReceipt.status}).`);
  }

  return {
    transactionHash: transactionReceipt.hash
  };
}
