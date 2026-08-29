import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrimaryAdminLoginWalletAddress } from '../../config/adminAccess';

const ADMIN_LOGIN_WALLET_ADDRESS = getPrimaryAdminLoginWalletAddress();

const mocks = vi.hoisted(() => ({
  addAuditLog: vi.fn(),
  bcryptCompare: vi.fn(),
  bcryptHash: vi.fn(),
  consumeWalletLoginNonce: vi.fn(),
  createRefreshSession: vi.fn(),
  createUser: vi.fn(),
  findRefreshSessionById: vi.fn(),
  findRootAdminWalletUsers: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserByGovernanceWalletAddress: vi.fn(),
  findUserById: vi.fn(),
  findWalletLoginNonce: vi.fn(),
  jsonWebTokenSign: vi.fn(),
  revokeRefreshSession: vi.fn(),
  revokeRefreshSessionsByUserId: vi.fn(),
  updateRefreshSession: vi.fn(),
  updateUser: vi.fn(),
  verifyMessage: vi.fn(),
  verifyGoogleIdToken: vi.fn()
}));

vi.mock('bcryptjs', () => ({ default: { compare: mocks.bcryptCompare, hash: mocks.bcryptHash } }));
vi.mock('jsonwebtoken', () => ({ default: { sign: mocks.jsonWebTokenSign } }));
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return { ...actual, verifyMessage: mocks.verifyMessage };
});
vi.mock('google-auth-library', () => ({ OAuth2Client: vi.fn(() => ({ verifyIdToken: mocks.verifyGoogleIdToken })) }));
vi.mock('../../config/googleAuth', () => ({ getGoogleAuthConfig: vi.fn(() => ({ clientId: 'google-client', tokenIssuers: ['issuer'] })) }));
vi.mock('../../config/jsonWebToken', () => ({
  getJsonWebTokenConfig: vi.fn(() => ({ issuer: 'issuer', audience: 'audience', accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '30d' })),
  getJsonWebTokenSecret: vi.fn(() => 'jwt-secret')
}));
vi.mock('../../config/logger', () => ({ getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) }));
vi.mock('../../utils/timeUtils', () => ({ parseDurationToMilliseconds: vi.fn(() => 60 * 60 * 1000) }));
vi.mock('../../services/zeroDevService', () => ({ createZeroDevSmartAccount: vi.fn() }));
vi.mock('../../models/authModel', () => ({
  addAuditLog: mocks.addAuditLog,
  consumeWalletLoginNonce: mocks.consumeWalletLoginNonce,
  createRefreshSession: mocks.createRefreshSession,
  createUser: mocks.createUser,
  findRefreshSessionById: mocks.findRefreshSessionById,
  findRootAdminWalletUsers: mocks.findRootAdminWalletUsers,
  findUserByEmail: mocks.findUserByEmail,
  findUserByGovernanceWalletAddress: mocks.findUserByGovernanceWalletAddress,
  findUserById: mocks.findUserById,
  findWalletLoginNonce: mocks.findWalletLoginNonce,
  getActiveRefreshSessionsByUserId: vi.fn(),
  revokeRefreshSession: mocks.revokeRefreshSession,
  revokeRefreshSessionsByUserId: mocks.revokeRefreshSessionsByUserId,
  updateRefreshSession: mocks.updateRefreshSession,
  updateUser: mocks.updateUser
}));

import { ensureRootAdminWallets, loginWithGoogle, loginWithWallet, refreshAccessToken } from '../../services/authService';

const unauthorizedAdminWallet = '0x1111111111111111111111111111111111111111';
const ipAddress = '127.0.0.1';
const userAgent = 'vitest';

/** Tạo user quản trị tối thiểu cho các nhánh xác thực ví và refresh token. */
function createGovernanceUser(role: 'admin' | 'executive_chair' | 'executive_member' | 'donor' | 'organization' | 'auditor', governanceWalletAddress: string) {
  return {
    id: `${role}-1`, email: `${role}@dcp.local`, fullName: role, role,
    walletAddress: governanceWalletAddress, governanceWalletAddress,
    accountStatus: 'ACTIVE', isSybil: false, authVersion: 1,
    lastLoginAt: null, lastLoginIp: null, lastLoginUserAgent: null
  };
}

/** Tạo nonce hợp lệ để cô lập test allowlist khỏi xác minh SIWE. */
function createWalletNonceRecord() {
  return { id: 'nonce-1', nonce: 'nonce-1', createdAt: new Date('2026-08-28T00:00:00.000Z'), expiresAt: new Date('2030-01-01T00:00:00.000Z') };
}

/** Tạo refresh session hợp lệ để kiểm tra gate sau khi token đã được phát hành. */
function createRefreshSessionRecord(userId: string) {
  return {
    id: 'session-1', userId, refreshTokenHash: 'hash', csrfToken: 'csrf-token', ipAddress, userAgent,
    expiresAt: new Date('2030-01-01T00:00:00.000Z'), lockedUntil: null, failedRefreshCount: 0,
    createdAt: new Date('2026-08-28T00:00:00.000Z'), updatedAt: new Date('2026-08-28T00:00:00.000Z')
  };
}

describe('authService admin wallet allowlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addAuditLog.mockResolvedValue(undefined);
    mocks.bcryptCompare.mockResolvedValue(true);
    mocks.bcryptHash.mockResolvedValue('hashed-refresh-token');
    mocks.consumeWalletLoginNonce.mockResolvedValue(true);
    mocks.createRefreshSession.mockResolvedValue(undefined);
    mocks.findRootAdminWalletUsers.mockResolvedValue([]);
    mocks.jsonWebTokenSign.mockReturnValue('access-token');
    mocks.updateRefreshSession.mockResolvedValue(undefined);
    mocks.updateUser.mockImplementation(async (user) => user);
    mocks.verifyMessage.mockReturnValue(ADMIN_LOGIN_WALLET_ADDRESS);
    mocks.verifyGoogleIdToken.mockResolvedValue({
      getPayload: () => ({ iss: 'issuer', email: 'member@dcp.local', name: 'Governance User', sub: 'google-sub', email_verified: true })
    });
  });

  it('phát session admin khi chữ ký thuộc đúng ví allowlist', async () => {
    const admin = createGovernanceUser('admin', ADMIN_LOGIN_WALLET_ADDRESS);
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(admin);

    const result = await loginWithWallet(ADMIN_LOGIN_WALLET_ADDRESS.toLowerCase(), 'nonce-1', '0xsig', ipAddress, userAgent);

    expect(result.user.role).toBe('admin');
    expect(mocks.createRefreshSession).toHaveBeenCalledOnce();
  });

  it('từ chối admin legacy dù chữ ký và nonce hợp lệ khi ví không thuộc allowlist', async () => {
    const legacyAdmin = createGovernanceUser('admin', unauthorizedAdminWallet);
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.verifyMessage.mockReturnValue(unauthorizedAdminWallet);
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(legacyAdmin);

    await expect(loginWithWallet(unauthorizedAdminWallet, 'nonce-1', '0xsig', ipAddress, userAgent)).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.createRefreshSession).not.toHaveBeenCalled();
  });

  it('không áp allowlist admin lên executive member đăng nhập bằng ví ghế hợp lệ', async () => {
    const member = createGovernanceUser('executive_member', unauthorizedAdminWallet);
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.verifyMessage.mockReturnValue(unauthorizedAdminWallet);
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(member);

    await expect(loginWithWallet(unauthorizedAdminWallet, 'nonce-1', '0xsig', ipAddress, userAgent)).resolves.toMatchObject({ user: { role: 'executive_member' } });
  });

  it('từ chối chữ ký được khôi phục từ signer khác trước khi tiêu thụ nonce', async () => {
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.verifyMessage.mockReturnValue(unauthorizedAdminWallet);

    await expect(loginWithWallet(ADMIN_LOGIN_WALLET_ADDRESS, 'nonce-1', '0xsig', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.consumeWalletLoginNonce).not.toHaveBeenCalled();
  });

  it('từ chối nonce đã hết hạn hoặc không còn tồn tại', async () => {
    mocks.findWalletLoginNonce.mockResolvedValue(null);

    await expect(loginWithWallet(ADMIN_LOGIN_WALLET_ADDRESS, 'expired-nonce', '0xsig', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.verifyMessage).not.toHaveBeenCalled();
  });

  it('từ chối replay khi thao tác consume nonce nguyên tử trả về false', async () => {
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.consumeWalletLoginNonce.mockResolvedValue(false);

    await expect(loginWithWallet(ADMIN_LOGIN_WALLET_ADDRESS, 'nonce-1', '0xsig', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.findUserByGovernanceWalletAddress).not.toHaveBeenCalled();
  });

  it('từ chối ví donor dù chữ ký và nonce đều hợp lệ', async () => {
    const donor = createGovernanceUser('donor', unauthorizedAdminWallet);
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.verifyMessage.mockReturnValue(unauthorizedAdminWallet);
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(donor);

    await expect(loginWithWallet(unauthorizedAdminWallet, 'nonce-1', '0xsig', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.createRefreshSession).not.toHaveBeenCalled();
  });

  it('từ chối ví chưa được gán vào ghế quản trị', async () => {
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(null);

    await expect(loginWithWallet(ADMIN_LOGIN_WALLET_ADDRESS, 'nonce-1', '0xsig', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.createRefreshSession).not.toHaveBeenCalled();
  });

  it('từ chối ghế đã bị suspend và không phát token mới', async () => {
    const suspendedMember = { ...createGovernanceUser('executive_member', unauthorizedAdminWallet), accountStatus: 'SUSPENDED' as const };
    mocks.findWalletLoginNonce.mockResolvedValue(createWalletNonceRecord());
    mocks.verifyMessage.mockReturnValue(unauthorizedAdminWallet);
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(suspendedMember);

    await expect(loginWithWallet(unauthorizedAdminWallet, 'nonce-1', '0xsig', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.createRefreshSession).not.toHaveBeenCalled();
  });

  it('thu hồi refresh session admin legacy thay vì phát access token mới', async () => {
    const legacyAdmin = createGovernanceUser('admin', unauthorizedAdminWallet);
    mocks.findRefreshSessionById.mockResolvedValue(createRefreshSessionRecord(legacyAdmin.id));
    mocks.findUserById.mockResolvedValue(legacyAdmin);

    await expect(refreshAccessToken('session-1', 'refresh-token', 'csrf-token', ipAddress, userAgent)).rejects.toThrow('no longer authorized');
    expect(mocks.revokeRefreshSessionsByUserId).toHaveBeenCalledWith(legacyAdmin.id);
    expect(mocks.updateRefreshSession).not.toHaveBeenCalled();
  });

  it('làm mới session cho đúng admin allowlist', async () => {
    const admin = createGovernanceUser('admin', ADMIN_LOGIN_WALLET_ADDRESS);
    mocks.findRefreshSessionById.mockResolvedValue(createRefreshSessionRecord(admin.id));
    mocks.findUserById.mockResolvedValue(admin);

    await expect(refreshAccessToken('session-1', 'refresh-token', 'csrf-token', ipAddress, userAgent)).resolves.toMatchObject({ accessToken: 'access-token' });
    expect(mocks.updateRefreshSession).toHaveBeenCalledOnce();
  });

  it('chỉ provision ví admin allowlist và thu hồi root admin cũ khi server khởi động', async () => {
    mocks.findUserByGovernanceWalletAddress.mockResolvedValue(null);
    mocks.findUserByEmail.mockResolvedValue(null);
    mocks.createUser.mockResolvedValue(undefined);
    const previousAdmin = { ...createGovernanceUser('admin', unauthorizedAdminWallet), isRootAdminWallet: true };
    mocks.findRootAdminWalletUsers.mockResolvedValue([previousAdmin]);

    await ensureRootAdminWallets();

    expect(mocks.createUser).toHaveBeenCalledWith(expect.objectContaining({ governanceWalletAddress: ADMIN_LOGIN_WALLET_ADDRESS.toLowerCase(), role: 'admin' }));
    expect(mocks.updateUser).toHaveBeenCalledWith(expect.objectContaining({ id: previousAdmin.id, accountStatus: 'SUSPENDED' }));
    expect(mocks.revokeRefreshSessionsByUserId).toHaveBeenCalledWith(previousAdmin.id);
  });

  it.each(['admin', 'executive_chair', 'executive_member'] as const)('chặn Google login cho role quản trị %s', async (role) => {
    mocks.findUserByEmail.mockResolvedValue(createGovernanceUser(role, ADMIN_LOGIN_WALLET_ADDRESS));

    await expect(loginWithGoogle('google-id-token', 'donor', ipAddress, userAgent))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.createRefreshSession).not.toHaveBeenCalled();
  });

  it.each(['donor', 'organization', 'auditor'] as const)('cho phép Google login tiếp tục cho role dữ liệu %s', async (role) => {
    const user = {
      ...createGovernanceUser(role, ADMIN_LOGIN_WALLET_ADDRESS),
      smartAccountOwnerEncryptedPrivateKey: 'encrypted-owner-key',
      smartAccountOwnerAddress: ADMIN_LOGIN_WALLET_ADDRESS
    };
    mocks.findUserByEmail.mockResolvedValue(user);
    mocks.updateUser.mockResolvedValue(user);

    await expect(loginWithGoogle('google-id-token', 'donor', ipAddress, userAgent))
      .resolves.toMatchObject({ user: { role } });
    expect(mocks.createRefreshSession).toHaveBeenCalledOnce();
  });
});
