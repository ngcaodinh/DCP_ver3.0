type ZeroDevConfig = {
  projectId: string;
  rpcUrl: string;
  bundlerUrl: string;
  paymasterUrl: string;
  entryPointAddress: `0x${string}`;
};

/**
 * Hàm lấy cấu hình ZeroDev từ biến môi trường.
 * Mục đích: đảm bảo thông tin SDK được khai báo đầy đủ trước khi khởi tạo Smart Account.
 */
function buildZeroDevConfig(): ZeroDevConfig {
  const projectId = process.env.ZERODEV_PROJECT_ID;
  const rpcUrl = process.env.ZERODEV_RPC_URL;
  const bundlerUrl = process.env.ZERODEV_BUNDLER_URL;
  const paymasterUrl = process.env.ZERODEV_PAYMASTER_URL;
  const entryPointAddress =
    (process.env.ZERODEV_ENTRYPOINT_ADDRESS as `0x${string}` | undefined) ||
    '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

  if (!projectId || !rpcUrl || !bundlerUrl || !paymasterUrl) {
    throw new Error('Thiếu cấu hình ZeroDev. Kiểm tra ZERODEV_PROJECT_ID, ZERODEV_RPC_URL, ZERODEV_BUNDLER_URL, ZERODEV_PAYMASTER_URL.');
  }

  return {
    projectId,
    rpcUrl,
    bundlerUrl,
    paymasterUrl,
    entryPointAddress
  };
}

let cachedZeroDevConfig: ZeroDevConfig | null = null;

/**
 * Hàm lấy cấu hình ZeroDev.
 * Mục đích: chỉ khởi tạo cấu hình khi cần để tránh lỗi khi thiếu biến môi trường trong các endpoint không dùng ZeroDev.
 */
export function getZeroDevConfig(): ZeroDevConfig {
  if (!cachedZeroDevConfig) {
    cachedZeroDevConfig = buildZeroDevConfig();
  }

  return cachedZeroDevConfig;
}

