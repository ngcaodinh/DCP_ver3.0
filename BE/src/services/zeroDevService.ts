import crypto from 'crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { polygonAmoy } from 'viem/chains';
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  getUserOperationGasPrice
} from '@zerodev/sdk';
import { getZeroDevConfig } from '../config/zeroDev';
import { getLogger } from '../config/logger';
import { AppError } from '../utils/appError';

const logger = getLogger();
const zeroDevConfig = getZeroDevConfig();
let cachedPublicClient: ReturnType<typeof createPublicClient> | null = null;
let cachedPaymasterClient: ReturnType<typeof createZeroDevPaymasterClient> | null = null;
let cachedEncryptionKey: Buffer | null = null;

type ZeroDevSmartAccountProvisionResult = {
  smartAccountAddress: string;
  ownerAddress: string;
  encryptedOwnerPrivateKey: string;
};

/**
 * Hàm lấy khóa mã hóa owner key với caching.
 * Mục đích: đảm bảo private key luôn được mã hóa trước khi lưu DB.
 * Performance: Cache khoá ở module level để tránh đọc process.env nhiều lần.
 * @returns Buffer chứa khóa mã hóa 32 bytes (hex)
 * @throws AppError nếu SMART_ACCOUNT_ENCRYPTION_KEY không được cấu hình hoặc không hợp lệ
 */
function getOwnerEncryptionKey(): Buffer {
  if (cachedEncryptionKey !== null) {
    return cachedEncryptionKey;
  }

  const encryptionSecret = String(process.env.SMART_ACCOUNT_ENCRYPTION_KEY || '').trim();
  if (!encryptionSecret) {
    throw new AppError('Thiếu SMART_ACCOUNT_ENCRYPTION_KEY để bảo vệ owner private key.', 500);
  }

  const normalizedSecret = encryptionSecret.startsWith('0x') ? encryptionSecret.slice(2) : encryptionSecret;
  if (!/^[a-fA-F0-9]{64}$/.test(normalizedSecret)) {
    throw new AppError('SMART_ACCOUNT_ENCRYPTION_KEY phải là chuỗi hex 32 bytes.', 500);
  }

  cachedEncryptionKey = Buffer.from(normalizedSecret, 'hex');
  return cachedEncryptionKey;
}

/**
 * Hàm mã hóa private key owner.
 * Mục đích: lưu private key an toàn trong DB theo định dạng iv:ciphertext:tag.
 * @param ownerPrivateKey - Private key cần mã hóa (định dạng 0x...)
 * @returns Chuỗi đã mã hóa theo định dạng iv:ciphertext:tag (hex)
 */
export function encryptOwnerPrivateKey(ownerPrivateKey: string): string {
  const encryptionKey = getOwnerEncryptionKey();
  const ivBuffer = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, ivBuffer);
  const encryptedBuffer = Buffer.concat([cipher.update(ownerPrivateKey, 'utf8'), cipher.final()]);
  const authTagBuffer = cipher.getAuthTag();
  return `${ivBuffer.toString('hex')}:${encryptedBuffer.toString('hex')}:${authTagBuffer.toString('hex')}`;
}

/**
 * Hàm giải mã private key owner.
 * Mục đích: khôi phục signer để backend gửi UserOperation thay người dùng.
 * @param encryptedOwnerPrivateKey - Chuỗi đã mã hóa theo định dạng iv:ciphertext:tag
 * @returns Private key gốc (định dạng 0x...)
 * @throws AppError nếu định dạng encrypted key không hợp lệ
 */
export function decryptOwnerPrivateKey(encryptedOwnerPrivateKey: string): `0x${string}` {
  const [ivHexValue, encryptedHexValue, authTagHexValue] = String(encryptedOwnerPrivateKey || '').split(':');
  if (!ivHexValue || !encryptedHexValue || !authTagHexValue) {
    throw new AppError('Định dạng encrypted owner private key không hợp lệ.', 400);
  }

  const encryptionKey = getOwnerEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivHexValue, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHexValue, 'hex'));
  const decryptedText = Buffer.concat([decipher.update(Buffer.from(encryptedHexValue, 'hex')), decipher.final()]).toString('utf8');
  return decryptedText as `0x${string}`;
}

/**
 * Hàm tạo owner account ngẫu nhiên.
 * Mục đích: sinh signer gốc cho tài khoản smart account mới.
 * Security: Sử dụng generatePrivateKey() từ viem/accounts để đảm bảo key nằm trong secp256k1 curve.
 * @returns Object chứa ownerPrivateKey và ownerAccount
 */
function createOwnerAccount() {
  const ownerPrivateKey = generatePrivateKey();
  return { ownerPrivateKey, ownerAccount: privateKeyToAccount(ownerPrivateKey) };
}

/**
 * Hàm lấy public client ZeroDev dùng chung.
 * Mục đích: tái sử dụng kết nối RPC để giảm chi phí khởi tạo.
 * @returns PublicClient của viem
 */
function getPublicClient() {
  if (!cachedPublicClient) {
    cachedPublicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(zeroDevConfig.rpcUrl)
    });
  }
  return cachedPublicClient;
}

/**
 * Hàm lấy paymaster client dùng chung.
 * Mục đích: tránh khởi tạo lại client cho mỗi request donation.
 * @returns ZeroDev Paymaster Client
 */
function getPaymasterClient() {
  if (!cachedPaymasterClient) {
    // SDK v5 gắn chain vào paymaster để tạo đúng payload ERC-7677 cho EntryPoint v0.7.
    cachedPaymasterClient = createZeroDevPaymasterClient({
      chain: polygonAmoy,
      transport: http(zeroDevConfig.paymasterUrl)
    } as never);
  }
  return cachedPaymasterClient;
}

/**
 * Hàm tạo kernel account client từ owner private key.
 * Mục đích: dựng client để backend gửi transaction batch.
 * @param ownerPrivateKey - Private key của owner (định dạng 0x...)
 * @param usePaymaster - Có sử dụng paymaster tài trợ gas không
 * @returns Kernel Account Client của ZeroDev
 */
async function createKernelClientFromOwnerPrivateKey(ownerPrivateKey: `0x${string}`, usePaymaster: boolean) {
  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const publicClient = getPublicClient();

  // ZeroDev SDK v5 có type inference phức tạp trên các generic như entryPoint, kernelVersion, bundlerTransport.
  // `as never` suppress TypeScript errors vì SDK types không align với actual runtime interface.
  // Runtime safety đảm bảo bởi viem/zerodev runtime khi gọi thực tế.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kernelAccount = await createKernelAccount(publicClient as any, {
    entryPoint: {
      address: zeroDevConfig.entryPointAddress,
      version: '0.7'
    },
    kernelVersion: '0.3.3',
    eip7702Account: ownerAccount
  } as never);

  if (!usePaymaster) {
    return createKernelAccountClient({
      account: kernelAccount,
      chain: polygonAmoy,
      // SDK >= 5.4 cần public client để chuẩn bị gas và UserOperation trước khi gửi bundler.
      client: publicClient,
      bundlerTransport: http(zeroDevConfig.bundlerUrl),
      userOperation: {
        estimateFeesPerGas: async ({ bundlerClient }: { bundlerClient: unknown }) => getUserOperationGasPrice(bundlerClient as never)
      }
    } as never);
  }

  return createKernelAccountClient({
    account: kernelAccount,
    chain: polygonAmoy,
    // SDK >= 5.4 cần public client để chuẩn bị gas và UserOperation trước khi gửi bundler.
    client: publicClient,
    bundlerTransport: http(zeroDevConfig.bundlerUrl),
    paymaster: getPaymasterClient(),
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }: { bundlerClient: unknown }) => getUserOperationGasPrice(bundlerClient as never)
    }
  } as never);
}

/**
 * Lấy đường dẫn paymaster URL — dùng cho logging/debugging.
 */
export function getPaymasterUrl(): string {
  return zeroDevConfig.paymasterUrl;
}

/**
 * Hàm tạo kernel account client từ owner private key đã mã hóa.
 * Mục đích: tái sử dụng signer đã lưu bảo mật trong DB với paymaster tài trợ gas.
 * @param encryptedOwnerPrivateKey - Chuỗi private key đã mã hóa
 * @returns Kernel Account Client với paymaster
 */
export async function createKernelClientFromEncryptedOwnerKey(encryptedOwnerPrivateKey: string) {
  const ownerPrivateKey = decryptOwnerPrivateKey(encryptedOwnerPrivateKey);
  return createKernelClientFromOwnerPrivateKey(ownerPrivateKey, true);
}

/**
 * Hàm tạo kernel account client không dùng paymaster.
 * Mục đích: fallback khi policy tài trợ gas từ paymaster không khớp.
 * @param encryptedOwnerPrivateKey - Chuỗi private key đã mã hóa
 * @returns Kernel Account Client không có paymaster
 */
export async function createKernelClientFromEncryptedOwnerKeyWithoutPaymaster(
  encryptedOwnerPrivateKey: string
): Promise<ReturnType<typeof createKernelClientFromOwnerPrivateKey>> {
  const ownerPrivateKey = decryptOwnerPrivateKey(encryptedOwnerPrivateKey);
  return createKernelClientFromOwnerPrivateKey(ownerPrivateKey, false);
}


/**
 * Hàm tạo Smart Account và dữ liệu owner bảo mật.
 * Mục đích: cấp đủ thông tin để user đăng nhập social nhưng donate kiểu web2 click.
 * @returns Object chứa smartAccountAddress, ownerAddress, encryptedOwnerPrivateKey
 * @throws AppError nếu không thể khởi tạo Smart Account
 */
export async function createZeroDevSmartAccount(): Promise<ZeroDevSmartAccountProvisionResult> {
  const { ownerPrivateKey, ownerAccount } = createOwnerAccount();
  const kernelClient = await createKernelClientFromOwnerPrivateKey(ownerPrivateKey, true);

  const kernelClientAccount = (kernelClient as { account?: { address?: string } }).account;
  if (!kernelClientAccount?.address) {
    throw new AppError('Không thể khởi tạo Smart Account ZeroDev do thiếu account.', 500);
  }

  const smartAccountAddress = String(kernelClientAccount.address).toLowerCase();
  const ownerAddress = ownerAccount.address.toLowerCase();
  const encryptedOwnerPrivateKey = encryptOwnerPrivateKey(ownerPrivateKey);

  logger.info('ZeroDev smart account created.', { smartAccountAddress });

  return {
    smartAccountAddress,
    ownerAddress,
    encryptedOwnerPrivateKey
  };
}
