/**
 * Blockchain provider abstraction — tách biệt ethers khỏi service layer.
 * Mục đích: dễ mock trong unit test mà không phụ thuộc vào ethers mock complexity.
 */
import { ethers } from 'ethers';
import { getZeroDevConfig } from '../config/zeroDev';

/** Singleton lazy-initialized JsonRpcProvider — tái sử dụng provider cho tất cả on-chain calls. */
let sharedRpcProvider: ethers.JsonRpcProvider | null = null;

/**
 * Reset sharedRpcProvider — chỉ dùng trong unit test để ensure mỗi test
 * khởi tạo provider với mock mới nhất.
 */
export function resetSharedRpcProvider(): void {
  sharedRpcProvider = null;
}

/**
 * Lấy hoặc khởi tạo singleton JsonRpcProvider dùng chung.
 * Dùng lazy initialization để tránh tạo provider khi module load.
 */
export function getSharedRpcProvider(): ethers.JsonRpcProvider {
  if (!sharedRpcProvider) {
    const config = getZeroDevConfig();
    sharedRpcProvider = new ethers.JsonRpcProvider(config.rpcUrl);
  }
  return sharedRpcProvider;
}
