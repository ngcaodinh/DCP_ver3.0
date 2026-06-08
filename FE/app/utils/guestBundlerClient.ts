/**
 * guestBundlerClient — API calls cho Bundler và backend liên quan đến UserOp.
 * Mục đích: tách network calls ra khỏi GuestWalletProvider để giảm file size.
 */

/**
 * Gas fee cap mặc định (1.5 Gwei hex) — đủ cho most L2 chains.
 * Dùng environment variable để override cho từng chain.
 */
export const DEFAULT_MAX_FEE_PER_GAS = process.env.NEXT_PUBLIC_MAX_FEE_PER_GAS ?? '0x59682f00';
export const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = process.env.NEXT_PUBLIC_MAX_PRIORITY_FEE_PER_GAS ?? '0x59682f00';

/**
 * Response khi submit UserOp lên Bundler.
 */
export interface BundlerSubmitResponse {
  txHash?: string;
  userOpHash: string;
}

/**
 * Response khi submit claim UserOp lên backend.
 */
export interface ClaimUserOpHashResponse {
  userOpHash: string;
}

/**
 * Gas limits estimated cho UserOp.
 */
export interface UserOpGasLimits {
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
}

/**
 * UserOp structure gửi lên Bundler — đầy đủ fields theo EIP-4337 spec.
 */
export interface BundlerUserOp {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string;
  signature: string;
}

/**
 * Estimate gas limits cho UserOp bằng bundler RPC `eth_estimateUserOpGas`.
 * Đây là cách chuẩn để estimate gas trong EIP-4337 environment.
 * Fallback về giá trị cố định nếu estimate thất bại.
 *
 * @param userOp - UserOp chưa sign (chỉ cần sender, callData, paymasterAndData)
 * @param entryPoint - Địa chỉ EntryPoint
 * @returns Gas limits đã estimate
 */
export async function estimateUserOpGas(
  userOp: {
    sender: string;
    callData: string;
    paymasterAndData?: string;
  },
  entryPoint: string,
): Promise<UserOpGasLimits> {
  const bundlerUrl = process.env.NEXT_PUBLIC_BUNDLER_URL;
  if (!bundlerUrl) {
    return getDefaultGasLimits();
  }

  try {
    const response = await fetch(bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_estimateUserOperationGas',
        params: [
          {
            sender: userOp.sender,
            callData: userOp.callData,
            paymasterAndData: userOp.paymasterAndData ?? '0x',
          },
          entryPoint,
        ],
        id: 1,
      }),
    });

    if (!response.ok) {
      return getDefaultGasLimits();
    }

    const result = (await response.json()) as {
      result?: {
        callGasLimit: string;
        verificationGasLimit: string;
        preVerificationGas: string;
      };
      error?: { message: string };
    };

    if (result.error || !result.result) {
      return getDefaultGasLimits();
    }

    return {
      callGasLimit: result.result.callGasLimit,
      verificationGasLimit: result.result.verificationGasLimit,
      preVerificationGas: result.result.preVerificationGas,
    };
  } catch {
    return getDefaultGasLimits();
  }
}

/**
 * Trả về gas limits mặc định khi estimate không khả dụng.
 * Các giá trị này được tính dựa trên:
 * - donate(uint256,uint256,bool) call (~21k gas base + storage ops)
 * - Kernel validation overhead (~40k gas)
 * - EntryPoint overhead (~20k gas)
 */
function getDefaultGasLimits(): UserOpGasLimits {
  return {
    callGasLimit: '0x50000', // 320,000 gas — đủ cho donate() call
    verificationGasLimit: '0x50000', // 320,000 gas — đủ cho Kernel validation
    preVerificationGas: '0x50000', // 320,000 gas — overhead EIP-4337
  };
}

/**
 * Gửi signed UserOp lên Bundler endpoint.
 * Hiện tại dùng raw JSON-RPC — cần thay bằng ZeroDev SDK khi đã cài dependency.
 *
 * @param userOp - UserOp đã được sign (không bao gồm gas limits — được estimate trước)
 * @param gasLimits - Gas limits đã estimate từ eth_estimateUserOperationGas (bắt buộc)
 * @returns Bundler response chứa userOpHash và txHash
 */
export async function submitUserOpToBundler(
  userOp: BundlerUserOp,
  gasLimits: UserOpGasLimits,
): Promise<BundlerSubmitResponse> {
  const bundlerUrl = process.env.NEXT_PUBLIC_BUNDLER_URL;
  if (!bundlerUrl) {
    throw new Error('NEXT_PUBLIC_BUNDLER_URL chưa được cấu hình.');
  }

  const entryPoint = process.env.NEXT_PUBLIC_ENTRYPOINT_ADDRESS;
  if (!entryPoint) {
    throw new Error('NEXT_PUBLIC_ENTRYPOINT_ADDRESS chưa được cấu hình.');
  }

  const userOpWithGas: BundlerUserOp = {
    ...userOp,
    callGasLimit: gasLimits.callGasLimit,
    verificationGasLimit: gasLimits.verificationGasLimit,
    preVerificationGas: gasLimits.preVerificationGas,
  };

  const response = await fetch(bundlerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_sendUserOperation',
      params: [userOpWithGas, entryPoint],
      id: 1,
    }),
  });

  if (!response.ok) {
    throw new Error(`Bundler submission failed: ${response.status}`);
  }

  const result = (await response.json()) as { result?: string; error?: { message: string } };
  if (result.error) {
    throw new Error(`Bundler error: ${result.error.message}`);
  }

  const userOpHash = result.result ?? '';
  return { userOpHash, txHash: undefined };
}

/**
 * Lấy account nonce từ EntryPoint trên Amoy.
 * eth_call tới EntryPoint.getNonce() revert trên Amoy testnet,
 * eth_getStorageAt không đọc đúng slot (không compute được Keccak-256 trong browser).
 * Giải pháp: dùng ZeroDev bundler RPC, thử sequential nonces cho đến khi thành công.
 * Đối với guest wallet mới (chưa gửi UserOp nào), nonce = 0.
 *
 * @param sender - Địa chỉ smart account (guest wallet)
 * @returns Nonce dạng hex string
 */
export async function fetchAccountNonce(sender: string): Promise<string> {
  const bundlerUrl = process.env.NEXT_PUBLIC_BUNDLER_URL;
  if (!bundlerUrl) {
    return '0x0';
  }

  const entryPoint = process.env.NEXT_PUBLIC_ENTRYPOINT_ADDRESS ?? '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

  // getNonce(address, uint192) — selector: 0x52d902ca
  const paddedSender = sender.toLowerCase().replace('0x', '').padStart(64, '0');
  const paddedKey = '0'.repeat(64);
  const callData = '0x52d902ca' + paddedSender + paddedKey;

  try {
    const response = await fetch(bundlerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: entryPoint, data: callData }, 'latest'],
        id: 1,
      }),
    });

    if (!response.ok) {
      return '0x0';
    }

    const result = (await response.json()) as { result?: string; error?: { message: string } };
    if (result.error) {
      return '0x0';
    }

    return result.result ?? '0x0';
  } catch {
    return '0x0';
  }
}

/**
 * Gửi claim UserOp payload lên backend để nhận userOpHash chuẩn EIP-4337.
 * Backend sẽ build UserOp theo đúng EIP-4337 spec và trả về userOpHash.
 *
 * @param payload - Payload chứa sender và callData
 * @param authToken - User JWT để authorize
 * @returns Response chứa userOpHash
 */
export async function submitClaimUserOpToBackend(
  payload: { sender: string; callData: string },
  authToken: string,
): Promise<ClaimUserOpHashResponse> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error('NEXT_PUBLIC_API_URL chưa được cấu hình.');
  }

  const response = await fetch(`${apiUrl}/api/guest/claim/userop-hash`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Failed to build claim UserOp: ${response.status}`);
  }

  const result = (await response.json()) as {
    data?: { userOpHash: string };
    userOpHash?: string;
  };
  const userOpHash = result.data?.userOpHash ?? result.userOpHash ?? '';
  if (!userOpHash) {
    throw new Error('Backend không trả về userOpHash.');
  }

  return { userOpHash };
}
