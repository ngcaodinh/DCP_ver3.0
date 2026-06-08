/**
 * guestUserOpBuilder — Helper functions để build UserOp calldata cho guest wallet.
 * Mục đích: tách logic ABI encoding ra khỏi GuestWalletProvider để giảm file size.
 * Tất cả functions đều dùng dynamic import để giảm initial bundle size.
 */

/**
 * Build callData cho hàm donate(uint256,uint256,bool) trên smart contract.
 * Dùng AbiCoder của ethers v6 để encode chuẩn Solidity ABI.
 * Dynamic import để giảm initial bundle size.
 *
 * @param projectId - ID của dự án cần quyên góp (numeric string)
 * @param amount - Số token quyên góp (không có decimal)
 * @param isAnonymous - Luôn true cho guest donation
 * @returns Function callData encoded theo Solidity ABI
 * @throws Error nếu projectId không phải numeric string
 */
export async function buildDonateCallData(
  projectId: string,
  amount: number,
  isAnonymous: boolean,
): Promise<string> {
  // donate(uint256,uint256,bool) function selector
  // keccak256("donate(uint256,uint256,bool)")[0:4] = 0x6e96e9b1
  // Verified: https://www.4byte.directory/signatures/?bytes4_signature=6e96e9b1
  const FUNCTION_SELECTOR = '0x6e96e9b1';
  const { AbiCoder } = await import('ethers');
  const abiCoder = AbiCoder.defaultAbiCoder();

  // Validate projectId là numeric string trước khi encode
  if (!/^\d+$/.test(projectId)) {
    throw new Error(`projectId không hợp lệ: "${projectId}". Phải là chuỗi số nguyên dương.`);
  }

  const encodedParams = abiCoder.encode(
    ['uint256', 'uint256', 'bool'],
    [BigInt(projectId), BigInt(amount), isAnonymous],
  );
  return FUNCTION_SELECTOR + encodedParams.substring(2);
}

/**
 * Build callData cho Kernel.changeOwner(address newOwner).
 * Dùng ethers AbiCoder để encode theo chuẩn Solidity ABI, đảm bảo address được padding đúng.
 *
 * @param newOwner - Địa chỉ EOA mới làm owner
 * @returns Calldata hex đã encode theo ABI
 */
export async function buildChangeOwnerCallData(newOwner: string): Promise<string> {
  // Kernel.changeOwner(address) function selector
  // keccak256("changeOwner(address)")[0:4] = 0xb8d6d998
  const FUNCTION_SELECTOR = '0xb8d6d998';
  const { AbiCoder } = await import('ethers');
  const abiCoder = AbiCoder.defaultAbiCoder();

  // Dùng ABI encoding để đảm bảo address được pad 32 bytes đúng chuẩn Solidity
  const encodedParams = abiCoder.encode(['address'], [newOwner]);
  return FUNCTION_SELECTOR + encodedParams.substring(2);
}

/**
 * Build payload để gửi claim UserOp lên backend (để BE tính userOpHash chuẩn).
 * Backend sẽ build UserOp đầy đủ theo EIP-4337 và trả về userOpHash để client sign.
 *
 * @param sender - Địa chỉ guest wallet (Kernel Smart Account)
 * @param callData - Calldata cho Kernel.changeOwner(claimEOAAddress)
 * @returns Payload gửi lên backend
 */
export async function buildClaimUserOpPayload(
  sender: string,
  callData: string,
): Promise<{ sender: string; callData: string }> {
  // TODO(@dev): Khi đã cài @zerodev/sdk, dùng createKernelAccountClient
  // để build UserOp đầy đủ (bao gồm nonce, gas limits) từ client side:
  //   const kernelAccountClient = createKernelAccountClient({ ... });
  //   const userOp = await kernelAccountClient.buildUserOp({ calls: [{ to: sender, data: callData }] });
  //   const userOpHash = await kernelAccountClient.getUserOpHash(userOp);
  //   return { userOp, userOpHash };
  return { sender, callData };
}
