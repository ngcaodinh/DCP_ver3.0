import { BrowserProvider, Contract, Eip1193Provider, Interface } from 'ethers';

export type DonationClientErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'USER_REJECTED'
  | 'CHAIN_MISMATCH'
  | 'RPC_TIMEOUT'
  | 'TRANSACTION_FAILED'
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_ERROR';

export class DonationClientError extends Error {
  public readonly errorCode: DonationClientErrorCode;

  /** Hàm khởi tạo lỗi client donation. Mục đích: chuẩn hóa mã lỗi để UI map thông điệp rõ ràng theo từng tình huống Web3. */
  constructor(errorCode: DonationClientErrorCode, message: string) {
    super(message);
    this.name = 'DonationClientError';
    this.errorCode = errorCode;
  }
}

const donationContractAbi = [
  'function donate(uint256 projectId, uint256 amount, bool isAnonymous) external returns (bool)',
  'function charityToken() external view returns (address)'
];

const charityTokenContractAbi = [
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)'
];

type EthereumBrowserWindow = Window & {
  ethereum?: Eip1193Provider;
};

/** Hàm lấy provider ví trình duyệt. Mục đích: đảm bảo frontend có thể kết nối MetaMask theo chuẩn EIP-1193. */
function getEthereumProvider(): Eip1193Provider {
  const browserWindow = window as EthereumBrowserWindow;
  if (!browserWindow.ethereum) {
    throw new DonationClientError('WALLET_NOT_FOUND', 'Không tìm thấy ví Web3. Vui lòng cài MetaMask hoặc ví tương thích EVM.');
  }

  return browserWindow.ethereum;
}

/** Hàm đọc cấu hình donation contract từ môi trường. Mục đích: đồng bộ chain và địa chỉ contract giữa FE và BE. */
function readDonationContractConfig(): { donationContractAddress: string; expectedChainId: number } {
  // Ghi chú logic phức tạp: ưu tiên biến chuẩn mới, nhưng vẫn fallback biến cũ để không làm vỡ môi trường local hiện có.
  const donationContractAddress = String(
    process.env.NEXT_PUBLIC_DONATION_RANKING_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_DONATION_RANKING_ADDRESS || ''
  ).trim();
  const expectedChainId = Number(process.env.NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID || process.env.NEXT_PUBLIC_AMOY_CHAIN_ID || 0);

  if (!donationContractAddress) {
    throw new Error(
      'Thiếu cấu hình địa chỉ contract donation. Vui lòng khai báo NEXT_PUBLIC_DONATION_RANKING_CONTRACT_ADDRESS (hoặc NEXT_PUBLIC_DONATION_RANKING_ADDRESS).'
    );
  }
  if (!Number.isInteger(expectedChainId) || expectedChainId <= 0) {
    throw new Error(
      'Thiếu hoặc sai cấu hình chainId. Vui lòng khai báo NEXT_PUBLIC_BLOCKCHAIN_CHAIN_ID (hoặc NEXT_PUBLIC_AMOY_CHAIN_ID).'
    );
  }

  return { donationContractAddress, expectedChainId };
}

/** Hàm yêu cầu ví chuyển đúng chain. Mục đích: tránh gửi giao dịch vào sai mạng blockchain. */
async function ensureExpectedChain(provider: BrowserProvider, expectedChainId: number): Promise<void> {
  const currentNetwork = await provider.getNetwork();
  if (Number(currentNetwork.chainId) === expectedChainId) {
    return;
  }

  const chainHexValue = `0x${expectedChainId.toString(16)}`;

  // Ghi chú logic phức tạp: thử switch chain trước, nếu ví không hỗ trợ chain thì throw lỗi rõ ràng để người dùng tự thêm mạng.
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: chainHexValue }]);
  } catch (_error) {
    throw new DonationClientError('CHAIN_MISMATCH', `Ví đang ở sai mạng. Vui lòng chuyển sang chainId ${expectedChainId}.`);
  }
}

/** Hàm chuẩn hóa projectId sang dạng số cho smart contract. Mục đích: hỗ trợ cả mã thuần số và mã có chứa số như PRJ-1001. */
function resolveContractProjectId(projectId: string): string {
  const normalizedProjectId = projectId.trim();
  if (/^[0-9]+$/.test(normalizedProjectId)) {
    return normalizedProjectId;
  }

  const numericPartMatch = normalizedProjectId.match(/([0-9]+)/);
  if (numericPartMatch?.[1]) {
    return numericPartMatch[1];
  }

  throw new DonationClientError('VALIDATION_ERROR', 'Mã dự án chưa có định danh on-chain hợp lệ để gửi giao dịch.');
}

type BatchCall = {
  to: string;
  data: string;
  value?: string;
};

/** Hàm lấy txHash từ kết quả wallet_getCallsStatus. Mục đích: tương thích nhiều cấu trúc response của từng ví hỗ trợ batch call. */
function extractTransactionHashFromBatchStatus(batchStatusResult: unknown): string {
  const normalizedResult = batchStatusResult as {
    receipts?: Array<{ transactionHash?: string }>;
    calls?: Array<{ transactionHash?: string }>;
    transactions?: Array<{ hash?: string }>;
  };

  return String(
    normalizedResult?.receipts?.[0]?.transactionHash ||
    normalizedResult?.calls?.[0]?.transactionHash ||
    normalizedResult?.transactions?.[0]?.hash ||
    ''
  );
}

/** Hàm tạo danh sách call batch approve + donate. Mục đích: gộp 2 bước nghiệp vụ vào 1 lần xác nhận ví theo chuẩn wallet_sendCalls. */
async function buildDonationBatchCalls(
  signerAddress: string,
  donationContractAddress: string,
  donationContract: Contract,
  donationAmountAsBigInt: bigint,
  contractProjectIdAsBigInt: bigint,
  isAnonymous: boolean
): Promise<BatchCall[]> {
  const charityTokenAddress: string = await donationContract.charityToken();
  const charityTokenContract = new Contract(charityTokenAddress, charityTokenContractAbi, donationContract.runner);

  const currentBalance: bigint = await charityTokenContract.balanceOf(signerAddress);
  if (currentBalance < donationAmountAsBigInt) {
    throw new DonationClientError('TRANSACTION_FAILED', 'Số dư token trong ví không đủ để quyên góp.');
  }

  const currentAllowance: bigint = await charityTokenContract.allowance(signerAddress, donationContractAddress);
  const tokenInterface = new Interface(charityTokenContractAbi);
  const donationInterface = new Interface(donationContractAbi);
  const batchCalls: BatchCall[] = [];

  if (currentAllowance < donationAmountAsBigInt) {
    // Ghi chú logic phức tạp: đặt approve trước donate ngay trong cùng một batch để người dùng chỉ cần xác nhận một lần.
    batchCalls.push({
      to: charityTokenAddress,
      data: tokenInterface.encodeFunctionData('approve', [donationContractAddress, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')]),
      value: '0x0'
    });
  }

  batchCalls.push({
    to: donationContractAddress,
    data: donationInterface.encodeFunctionData('donate', [contractProjectIdAsBigInt, donationAmountAsBigInt, isAnonymous]),
    value: '0x0'
  });

  return batchCalls;
}

/** Hàm gửi giao dịch donate bằng ví người dùng. Mục đích: ưu tiên batch approve + donate để người dùng chỉ cần xác nhận một lần. */
export async function donateByWallet(projectId: string, amount: number, isAnonymous: boolean): Promise<string> {
  const normalizedContractProjectId = resolveContractProjectId(projectId);
  const normalizedAmount = Math.floor(Number(amount));

  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new DonationClientError('VALIDATION_ERROR', 'Số token quyên góp phải lớn hơn 0.');
  }

  try {
    const { donationContractAddress, expectedChainId } = readDonationContractConfig();
    const ethereumProvider = getEthereumProvider();
    const browserProvider = new BrowserProvider(ethereumProvider);

    await browserProvider.send('eth_requestAccounts', []);
    await ensureExpectedChain(browserProvider, expectedChainId);

    const signer = await browserProvider.getSigner();
    const signerAddress = (await signer.getAddress()).toLowerCase();
    const donationContract = new Contract(donationContractAddress, donationContractAbi, signer);
    const donationAmountAsBigInt = BigInt(normalizedAmount);
    const projectIdAsBigInt = BigInt(normalizedContractProjectId);

    const batchCalls = await buildDonationBatchCalls(
      signerAddress,
      donationContractAddress,
      donationContract,
      donationAmountAsBigInt,
      projectIdAsBigInt,
      isAnonymous
    );

    // Ghi chú logic phức tạp: wallet_sendCalls thực hiện batch trong một luồng xác nhận duy nhất, sau đó poll wallet_getCallsStatus để lấy txHash.
    const batchIdentifier = await browserProvider.send('wallet_sendCalls', [
      {
        from: signerAddress,
        chainId: `0x${expectedChainId.toString(16)}`,
        version: '1.0',
        calls: batchCalls
      }
    ]);

    for (let pollAttemptIndex = 0; pollAttemptIndex < 20; pollAttemptIndex += 1) {
      const batchStatusResult = await browserProvider.send('wallet_getCallsStatus', [batchIdentifier]);
      const transactionHash = extractTransactionHashFromBatchStatus(batchStatusResult);
      if (transactionHash) {
        return transactionHash;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    throw new DonationClientError('TRANSACTION_FAILED', 'Không thể lấy transaction hash từ batch giao dịch. Vui lòng kiểm tra lịch sử ví.');
  } catch (error) {
    if (error instanceof DonationClientError) {
      throw error;
    }

    const typedError = error as { code?: number | string; message?: string };
    if (typedError?.code === 4001 || typedError?.code === 'ACTION_REJECTED') {
      throw new DonationClientError('USER_REJECTED', 'Bạn đã từ chối ký giao dịch.');
    }

    const normalizedErrorMessage = String(typedError?.message || '').toLowerCase();
    if (normalizedErrorMessage.includes('wallet_sendcalls') || normalizedErrorMessage.includes('method not found')) {
      throw new DonationClientError(
        'TRANSACTION_FAILED',
        'Ví hiện tại chưa hỗ trợ ký batch 1 lần xác nhận. Vui lòng dùng smart wallet ERC-4337 tương thích hoặc nâng cấp ví.'
      );
    }
    if (normalizedErrorMessage.includes('timeout')) {
      throw new DonationClientError('RPC_TIMEOUT', 'Kết nối blockchain bị timeout. Vui lòng thử lại.');
    }

    throw new DonationClientError('UNKNOWN_ERROR', typedError?.message || 'Không thể gửi giao dịch quyên góp.');
  }
}
