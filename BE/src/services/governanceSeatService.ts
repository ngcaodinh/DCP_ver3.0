import crypto from 'crypto';
import { Contract, JsonRpcProvider, isAddress } from 'ethers';
import { getBlockchainRpcUrl } from '../config/blockchainRpc';
import {
  countActiveGovernanceSeats,
  countActiveGovernanceSeatsMissingSlot,
  createGovernanceSeatUser,
  findGovernanceSeats,
  findUserByGovernanceWalletAddress,
  revokeRefreshSessionsByUserId,
  suspendGovernanceSeatByWalletAddress,
  upsertGovernanceSeatFromChain,
  type AuthUser
} from '../models/authModel';
import {
  findVerifiedGovernanceBootstrapState,
  upsertVerifiedGovernanceBootstrapState,
  type GovernanceBootstrapState
} from '../models/governanceBootstrapStateModel';
import { isGovernanceSeatMigrationLocked } from '../models/governanceSeatMigrationStateModel';
import { ApplicationError } from '../utils/applicationError';

export type GovernanceSeatRole = 'executive_chair' | 'executive_member';

export type CreateGovernanceSeatInput = {
  walletAddress: string;
  role: GovernanceSeatRole;
  displayName: string;
};

export type ConfirmGovernanceBootstrapInput = {
  transactionHash: string;
};

const SEAT_CAPACITY: Record<GovernanceSeatRole, number> = {
  executive_chair: 1,
  executive_member: 4
};
const COMMITTEE_GOVERNANCE_READ_ABI = [
  'function seatsBootstrapped() view returns (bool)',
  'function getSeats() view returns (address[5] seats,uint8[5] roles)',
  'event SeatsBootstrapped(address[5] seats,uint8[5] roles)'
];

/** Chặn cấp/thu ghế trong lúc dữ liệu legacy chưa có slot để unique index thực thi quota 1+4. */
async function ensureGovernanceSeatSlotMigrationCompleted(): Promise<void> {
  const [isMigrationLocked, missingSlotCount] = await Promise.all([
    isGovernanceSeatMigrationLocked(),
    countActiveGovernanceSeatsMissingSlot()
  ]);
  if (isMigrationLocked || missingSlotCount > 0) {
    throw new ApplicationError(
      'Dữ liệu ghế cũ chưa được gán slot an toàn. Vui lòng chạy migration governance-seat-slots trước khi thay đổi roster.',
      503,
      'GOVERNANCE_SEAT_MIGRATION_REQUIRED'
    );
  }
}

/** Chuẩn hóa địa chỉ ví trước mọi truy vấn để chống tạo ghế trùng khác kiểu chữ. */
function normalizeGovernanceWalletAddress(walletAddress: string): string {
  const normalizedWalletAddress = walletAddress.trim().toLowerCase();
  if (!isAddress(normalizedWalletAddress)) {
    throw new ApplicationError('Địa chỉ ví không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
  return normalizedWalletAddress;
}

/** Kiểm tra role ghế ở service để các caller nội bộ không thể vượt qua validation HTTP. */
function ensureGovernanceSeatRole(role: string): asserts role is GovernanceSeatRole {
  if (role !== 'executive_chair' && role !== 'executive_member') {
    throw new ApplicationError('Vai trò ghế Ủy ban không hợp lệ.', 400, 'VALIDATION_ERROR');
  }
}

/** Chuyển user nội bộ thành DTO không chứa thông tin xác thực cho UI ghế Ủy ban. */
/**
 * Chặn mọi thay đổi roster từ backend sau khi CommitteeGovernance đã bootstrap.
 * Contract là nguồn chân lý của ghế từ thời điểm đó nên RPC lỗi phải fail-closed,
 * tránh để admin tạo phân kỳ giữa MongoDB và blockchain.
 */
async function ensureGovernanceSeatMutationAllowed(): Promise<void> {
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  if (!contractAddress) {
    if (process.env.NODE_ENV === 'production' || await findVerifiedGovernanceBootstrapState()) {
      throw new ApplicationError('Thiếu COMMITTEE_GOVERNANCE_ADDRESS sau bootstrap; roster Mongo bị khóa để tránh phân kỳ với blockchain.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    return;
  }
  if (!isAddress(contractAddress)) {
    throw new ApplicationError('Cấu hình COMMITTEE_GOVERNANCE_ADDRESS không hợp lệ.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }

  const rpcUrl = getBlockchainRpcUrl();
  if (!rpcUrl) {
    throw new ApplicationError('Thiếu BLOCKCHAIN_RPC_URL để kiểm tra khóa ghế trên blockchain.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }

  try {
    const readContract = new Contract(contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, new JsonRpcProvider(rpcUrl));
    if (await readContract.seatsBootstrapped()) {
      throw new ApplicationError('Ghế đã được khóa trên blockchain; chỉ Ủy ban mới được đổi ghế theo quy trình 3/5.', 409, 'INVALID_STATUS_TRANSITION');
    }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('Không thể xác minh trạng thái ghế trên blockchain. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

/** Đọc deployment block cấu hình và fail-closed ở production nếu indexer không có mốc quét xác định. */
function getCommitteeGovernanceDeploymentBlock(): number | null {
  const rawBlock = process.env.COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK?.trim() || '';
  if (!rawBlock) {
    if (process.env.NODE_ENV === 'production') {
      throw new ApplicationError('Thiếu COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK để tự đối soát bootstrap ghế.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    return null;
  }
  const deploymentBlock = Number(rawBlock);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0 || (process.env.NODE_ENV === 'production' && deploymentBlock === 0)) {
    throw new ApplicationError('COMMITTEE_GOVERNANCE_DEPLOYMENT_BLOCK không hợp lệ.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
  return deploymentBlock;
}

/** Tự đối soát SeatsBootstrapped từ deployment block để browser callback không còn là nguồn proof duy nhất. */
export async function reconcileGovernanceBootstrapFromChain(): Promise<GovernanceBootstrapState | null> {
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  const rpcUrl = getBlockchainRpcUrl();
  if (!isAddress(contractAddress) || !rpcUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new ApplicationError('Thiếu cấu hình CommitteeGovernance để đối soát bootstrap ghế khi khởi động.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    return null;
  }
  const deploymentBlock = getCommitteeGovernanceDeploymentBlock();
  if (deploymentBlock === null) return null;
  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const readContract = new Contract(contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, provider);
    if (!(await readContract.seatsBootstrapped())) return null;
    const bootstrapFilter = readContract.filters.SeatsBootstrapped();
    const bootstrapEvents = await readContract.queryFilter(bootstrapFilter, deploymentBlock, 'latest');
    const bootstrapTransactionHash = bootstrapEvents.at(-1)?.transactionHash;
    if (!bootstrapTransactionHash) {
      throw new ApplicationError('Chain báo roster đã bootstrap nhưng không tìm thấy event SeatsBootstrapped từ deployment block.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    return confirmGovernanceBootstrap({ transactionHash: bootstrapTransactionHash });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('Không thể tự đối soát bootstrap ghế với blockchain.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

/** Đồng bộ roster hiện tại từ getSeats sau event SeatChangeExecuted; chain là nguồn chân lý sau bootstrap. */
export async function reconcileGovernanceRosterFromChain(): Promise<ReturnType<typeof toGovernanceSeatDto>[]> {
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  const rpcUrl = getBlockchainRpcUrl();
  if (!isAddress(contractAddress) || !rpcUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new ApplicationError('Thiếu cấu hình CommitteeGovernance để đồng bộ thay ghế on-chain.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    return [];
  }
  try {
    const readContract = new Contract(contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, new JsonRpcProvider(rpcUrl));
    if (!(await readContract.seatsBootstrapped())) return [];
    await ensureGovernanceSeatSlotMigrationCompleted();
    const [wallets, roles] = await readContract.getSeats() as unknown as [readonly string[], readonly bigint[]];
    const expectedSeats = wallets.map((walletAddress, index) => {
      const roleValue = Number(roles[index]);
      if (!isAddress(walletAddress) || (roleValue !== 1 && roleValue !== 2)) {
        throw new ApplicationError('Roster CommitteeGovernance không hợp lệ.', 503, 'BLOCKCHAIN_UNAVAILABLE');
      }
      const role: GovernanceSeatRole = roleValue === 1 ? 'executive_chair' : 'executive_member';
      const governanceSeatSlot = role === 'executive_chair'
        ? 1
        : wallets.slice(0, index + 1).filter((_seat, seatIndex) => Number(roles[seatIndex]) === 2).length;
      return { walletAddress: walletAddress.toLowerCase(), role, governanceSeatSlot };
    });
    if (
      expectedSeats.length !== 5
      || expectedSeats.filter(seat => seat.role === 'executive_chair').length !== 1
      || expectedSeats.filter(seat => seat.role === 'executive_member').length !== 4
      || new Set(expectedSeats.map(seat => seat.walletAddress)).size !== 5
    ) {
      throw new ApplicationError('Roster CommitteeGovernance không còn bất biến 1 Chair + 4 Member.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    const expectedWallets = new Set(expectedSeats.map(seat => seat.walletAddress));
    const existingSeats = await findGovernanceSeats();
    for (const existingSeat of existingSeats) {
      const walletAddress = (existingSeat.governanceWalletAddress || existingSeat.walletAddress).toLowerCase();
      if (existingSeat.accountStatus === 'ACTIVE' && !expectedWallets.has(walletAddress)) {
        const suspended = await suspendGovernanceSeatByWalletAddress(walletAddress);
        if (suspended) await revokeRefreshSessionsByUserId(suspended.id);
      }
    }
    for (const expectedSeat of expectedSeats) {
      await upsertGovernanceSeatFromChain(expectedSeat);
    }
    return (await findGovernanceSeats()).map(toGovernanceSeatDto);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('Không thể đồng bộ roster ủy ban từ blockchain.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

export function toGovernanceSeatDto(user: AuthUser): {
  userId: string;
  displayName: string;
  role: GovernanceSeatRole;
  walletAddress: string;
  accountStatus: AuthUser['accountStatus'];
  lastLoginAt: Date | null;
} {
  ensureGovernanceSeatRole(user.role);
  return {
    userId: user.id,
    displayName: user.fullName,
    role: user.role,
    walletAddress: user.governanceWalletAddress || user.walletAddress,
    accountStatus: user.accountStatus,
    lastLoginAt: user.lastLoginAt
  };
}

/** Lấy toàn bộ ghế hiện có để admin và Ủy ban cùng kiểm tra cấu hình hiện tại. */
export async function listGovernanceSeats(): Promise<ReturnType<typeof toGovernanceSeatDto>[]> {
  const seats = await findGovernanceSeats();
  return seats.map(toGovernanceSeatDto);
}

/** Đọc proof bootstrap đã lưu để client fail-closed khi cấu hình RPC/contract không còn khả dụng. */
export function getVerifiedGovernanceBootstrapState(): Promise<GovernanceBootstrapState | null> {
  return findVerifiedGovernanceBootstrapState();
}

/** Xác minh receipt và roster từ RPC rồi ghi proof bootstrap server-side, tuyệt đối không tin danh sách ghế từ client. */
export async function confirmGovernanceBootstrap(
  input: ConfirmGovernanceBootstrapInput
): Promise<GovernanceBootstrapState> {
  const contractAddress = process.env.COMMITTEE_GOVERNANCE_ADDRESS?.trim() || '';
  const rpcUrl = getBlockchainRpcUrl();
  if (!isAddress(contractAddress) || !rpcUrl) {
    throw new ApplicationError('Thiếu cấu hình blockchain để xác minh bootstrap Ủy ban.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }

  const activeSeats = (await findGovernanceSeats()).filter(seat => seat.accountStatus === 'ACTIVE');
  const expectedRoster = activeSeats.map(seat => {
    ensureGovernanceSeatRole(seat.role);
    return {
      walletAddress: (seat.governanceWalletAddress || seat.walletAddress).toLowerCase(),
      role: seat.role
    };
  });
  const expectedChairCount = expectedRoster.filter(seat => seat.role === 'executive_chair').length;
  const expectedMemberCount = expectedRoster.filter(seat => seat.role === 'executive_member').length;
  if (expectedRoster.length !== 5 || expectedChairCount !== 1 || expectedMemberCount !== 4) {
    throw new ApplicationError('Roster off-chain phải có đúng 1 Chủ tịch và 4 Ủy viên trước khi xác minh bootstrap.', 409, 'COMMITTEE_ROSTER_INVALID');
  }

  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const [network, transaction, receipt] = await Promise.all([
      provider.getNetwork(),
      provider.getTransaction(input.transactionHash),
      provider.getTransactionReceipt(input.transactionHash)
    ]);
    if (!transaction || !receipt || receipt.status !== 1 || transaction.to?.toLowerCase() !== contractAddress.toLowerCase()) {
      throw new ApplicationError('Transaction bootstrap không hợp lệ hoặc chưa được xác nhận.', 409, 'TRANSACTION_REVERTED');
    }

    const readContract = new Contract(contractAddress, COMMITTEE_GOVERNANCE_READ_ABI, provider);
    const bootstrapEvent = readContract.interface.getEvent('SeatsBootstrapped');
    if (!bootstrapEvent) {
      throw new ApplicationError('ABI không chứa event SeatsBootstrapped để xác minh bootstrap.', 503, 'BLOCKCHAIN_UNAVAILABLE');
    }
    const hasBootstrapEvent = receipt.logs.some(log => (
      log.address.toLowerCase() === contractAddress.toLowerCase()
      && log.topics[0]?.toLowerCase() === bootstrapEvent.topicHash.toLowerCase()
    ));
    if (!hasBootstrapEvent || !(await readContract.seatsBootstrapped())) {
      throw new ApplicationError('Không tìm thấy event SeatsBootstrapped hợp lệ trên transaction đã xác nhận.', 409, 'EVENT_NOT_FOUND');
    }

    const onChainSeatResult = await readContract.getSeats() as unknown as [readonly string[], readonly bigint[]];
    const verifiedSeats = onChainSeatResult[0].map((walletAddress, index) => ({
      walletAddress: walletAddress.toLowerCase(),
      role: Number(onChainSeatResult[1][index]) === 1 ? 'executive_chair' as const : 'executive_member' as const
    }));
    const expectedKeys = new Set(expectedRoster.map(seat => `${seat.walletAddress}:${seat.role}`));
    const verifiedKeys = new Set(verifiedSeats.map(seat => `${seat.walletAddress}:${seat.role}`));
    if (verifiedSeats.length !== 5 || verifiedKeys.size !== 5 || expectedKeys.size !== 5 || [...expectedKeys].some(key => !verifiedKeys.has(key))) {
      throw new ApplicationError('Roster blockchain không khớp roster off-chain đã đối chiếu.', 409, 'CONFLICT');
    }

    return await upsertVerifiedGovernanceBootstrapState({
      transactionHash: input.transactionHash.toLowerCase(),
      contractAddress: contractAddress.toLowerCase(),
      chainId: network.chainId.toString(),
      seats: verifiedSeats,
      verifiedAt: new Date()
    });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('Không thể xác minh transaction bootstrap với blockchain. Vui lòng thử lại sau.', 503, 'BLOCKCHAIN_UNAVAILABLE');
  }
}

/**
 * Cấp tài khoản MetaMask không tự sinh private key cho một ghế Ủy ban.
 * Tài khoản đã thu ghế không được tự kích hoạt lại: admin phải cấp địa chỉ mới để audit rõ ràng.
 */
export async function createGovernanceSeat(input: CreateGovernanceSeatInput): Promise<ReturnType<typeof toGovernanceSeatDto>> {
  ensureGovernanceSeatRole(input.role);
  const normalizedWalletAddress = normalizeGovernanceWalletAddress(input.walletAddress);
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new ApplicationError('Tên hiển thị của ghế là bắt buộc.', 400, 'VALIDATION_ERROR');
  }

  await ensureGovernanceSeatSlotMigrationCompleted();
  await ensureGovernanceSeatMutationAllowed();

  const [existingUser, activeSeatCount] = await Promise.all([
    findUserByGovernanceWalletAddress(normalizedWalletAddress),
    countActiveGovernanceSeats(input.role)
  ]);
  if (existingUser) {
    throw new ApplicationError('Địa chỉ ví đã được gắn với một tài khoản.', 409, 'CONFLICT');
  }
  if (activeSeatCount >= SEAT_CAPACITY[input.role]) {
    const label = input.role === 'executive_chair' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành';
    throw new ApplicationError(`Đã đủ số ghế ${label}.`, 409, 'CONFLICT');
  }

  const seatSlotCandidates = buildSeatSlotCandidates(input.role, activeSeatCount);
  for (const governanceSeatSlot of seatSlotCandidates) {
    try {
      const createdUser = await createGovernanceSeatUser({
      id: crypto.randomUUID(),
      // Email nội bộ chỉ bảo toàn schema cũ; tài khoản quản trị không dùng Google/email để đăng nhập.
      email: `${normalizedWalletAddress}@wallet.dcp.local`,
      fullName: displayName,
      role: input.role,
      walletAddress: normalizedWalletAddress,
      governanceWalletAddress: normalizedWalletAddress,
      smartAccountOwnerAddress: null,
      smartAccountOwnerEncryptedPrivateKey: null,
      socialProvider: 'metamask',
      socialAccountId: normalizedWalletAddress,
      isEmailVerified: false,
      accountStatus: 'ACTIVE',
      organizationName: null,
      legalRegistrationNumber: null,
      isSybil: false,
      lastLoginAt: null,
      lastLoginIp: null,
      lastLoginUserAgent: null,
      correlationId: crypto.randomUUID(),
      fcmDeviceToken: null,
      phoneNumber: null,
      authVersion: 1
      }, governanceSeatSlot);
      return toGovernanceSeatDto(createdUser);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        // Wallet duplicate không thể được giải quyết bằng slot khác; duplicate slot thì thử slot khả dụng tiếp theo.
        const conflictedWallet = await findUserByGovernanceWalletAddress(normalizedWalletAddress);
        if (conflictedWallet) {
          throw new ApplicationError('Địa chỉ ví đã được gắn với một tài khoản.', 409, 'CONFLICT');
        }
        continue;
      }
      throw error;
    }
  }
  throw new ApplicationError('Đã đủ số ghế Ủy ban cho vai trò này.', 409, 'CONFLICT');
}

/** Thu ghế theo ví, không xóa user để snapshot biểu quyết lịch sử còn toàn vẹn. */
export async function suspendGovernanceSeat(walletAddress: string): Promise<ReturnType<typeof toGovernanceSeatDto>> {
  const normalizedWalletAddress = normalizeGovernanceWalletAddress(walletAddress);
  await ensureGovernanceSeatSlotMigrationCompleted();
  await ensureGovernanceSeatMutationAllowed();
  const suspendedSeat = await suspendGovernanceSeatByWalletAddress(normalizedWalletAddress);
  if (!suspendedSeat) {
    throw new ApplicationError('Không tìm thấy ghế đang hoạt động để thu hồi.', 404, 'NOT_FOUND');
  }
  await revokeRefreshSessionsByUserId(suspendedSeat.id);
  return toGovernanceSeatDto(suspendedSeat);
}

/** Tạo thứ tự slot để retry duplicate-key vẫn chỉ có tối đa số ghế được policy cho phép. */
function buildSeatSlotCandidates(role: GovernanceSeatRole, activeSeatCount: number): number[] {
  const capacity = SEAT_CAPACITY[role];
  const preferredStartSlot = Math.min(Math.max(activeSeatCount + 1, 1), capacity);
  return [
    ...Array.from({ length: capacity - preferredStartSlot + 1 }, (_, index) => preferredStartSlot + index),
    ...Array.from({ length: preferredStartSlot - 1 }, (_, index) => index + 1)
  ];
}
