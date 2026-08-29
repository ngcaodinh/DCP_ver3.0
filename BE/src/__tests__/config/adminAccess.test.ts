import { afterEach, describe, expect, it } from 'vitest';
import { getAdminLoginWalletAddresses, getPrimaryAdminLoginWalletAddress, isAuthorizedAdminLoginWallet, validateAdminLoginWalletConfiguration } from '../../config/adminAccess';

const originalAdminLoginWalletAddresses = process.env.ADMIN_LOGIN_WALLET_ADDRESSES;
const originalNodeEnvironment = process.env.NODE_ENV;

describe('adminAccess allowlist', () => {
  afterEach(() => {
    if (originalAdminLoginWalletAddresses === undefined) delete process.env.ADMIN_LOGIN_WALLET_ADDRESSES;
    else process.env.ADMIN_LOGIN_WALLET_ADDRESSES = originalAdminLoginWalletAddresses;
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
  });

  it('chỉ chấp nhận ví admin đã chỉ định, không phân biệt chữ hoa chữ thường', () => {
    const primaryAdminWallet = getPrimaryAdminLoginWalletAddress();
    expect(isAuthorizedAdminLoginWallet(primaryAdminWallet)).toBe(true);
    expect(isAuthorizedAdminLoginWallet(primaryAdminWallet.toLowerCase())).toBe(true);
  });

  it.each([
    '0x3333333333333333333333333333333333333333',
    'not-an-evm-address',
    '',
    null,
    undefined
  ])('từ chối mọi địa chỉ không thuộc allowlist: %s', (walletAddress) => {
    expect(isAuthorizedAdminLoginWallet(walletAddress)).toBe(false);
  });

  it('cho phép nhiều ví hợp lệ trong cửa sổ xoay khóa và từ chối cấu hình sai', () => {
    process.env.ADMIN_LOGIN_WALLET_ADDRESSES = '0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222';

    expect(getAdminLoginWalletAddresses()).toEqual([
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222'
    ]);
    expect(isAuthorizedAdminLoginWallet('0x2222222222222222222222222222222222222222')).toBe(true);

    process.env.ADMIN_LOGIN_WALLET_ADDRESSES = 'not-an-address';
    expect(validateAdminLoginWalletConfiguration).toThrow('ADMIN_LOGIN_WALLET_ADDRESSES');
  });

  it('fail-closed khi production thiếu allowlist nhưng cho phép test/dev không cấu hình ví', () => {
    delete process.env.ADMIN_LOGIN_WALLET_ADDRESSES;
    process.env.NODE_ENV = 'production';

    expect(validateAdminLoginWalletConfiguration).toThrow('Thiếu ADMIN_LOGIN_WALLET_ADDRESSES');

    process.env.NODE_ENV = 'test';
    expect(getAdminLoginWalletAddresses()).toEqual([]);
  });

  it('đọc ví admin chính tại thời điểm gọi thay vì khóa giá trị lúc module được import', () => {
    process.env.ADMIN_LOGIN_WALLET_ADDRESSES = '0x1111111111111111111111111111111111111111';
    expect(getPrimaryAdminLoginWalletAddress()).toBe('0x1111111111111111111111111111111111111111');

    process.env.ADMIN_LOGIN_WALLET_ADDRESSES = '0x2222222222222222222222222222222222222222';
    expect(getPrimaryAdminLoginWalletAddress()).toBe('0x2222222222222222222222222222222222222222');
  });
});
