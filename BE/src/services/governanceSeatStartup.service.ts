import { getLogger } from '../config/logger';
import { reconcileGovernanceBootstrapFromChain, reconcileGovernanceRosterFromChain } from './governanceSeatService';

const logger = getLogger();

/** Đồng bộ proof và roster khi khởi động; môi trường local vẫn phục vụ API nếu RPC tạm thời mất kết nối. */
export async function reconcileGovernanceAtStartup(): Promise<void> {
  try {
    await reconcileGovernanceBootstrapFromChain();
    await reconcileGovernanceRosterFromChain();
  } catch (error) {
    // Production phải dừng để không phục vụ bằng roster có thể đã lệch với CommitteeGovernance.
    if (process.env.NODE_ENV === 'production') throw error;
    logger.warn('Không thể đồng bộ CommitteeGovernance khi khởi động local; API vẫn tiếp tục phục vụ và worker sẽ thử lại.', {
      errorMessage: error instanceof Error ? error.message : String(error)
    });
  }
}
