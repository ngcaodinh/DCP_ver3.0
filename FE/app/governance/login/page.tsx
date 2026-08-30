'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildApiUrl, fetchApi, getApiErrorMessage, parseJsonSafely } from '@/app/utils/apiClient';
import { clearAuthSession, persistAuthSession } from '@/app/utils/authSession';

type EthereumProvider = {
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (eventName: 'accountsChanged', handler: (accounts: string[]) => void) => void;
  removeListener?: (eventName: 'accountsChanged', handler: (accounts: string[]) => void) => void;
};

declare global {
  interface Window { ethereum?: EthereumProvider; }
}

type WalletLoginResult = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  refreshSessionId: string;
  expiresAt: string;
  user: { id: string; fullName: string; email: string; walletAddress: string; role: string };
};

const POLYGON_AMOY_CHAIN_ID = '0x13882';
const CHAIN_NOT_ADDED_ERROR_CODE = 4902;
const POLYGON_AMOY_NETWORK = {
  chainId: POLYGON_AMOY_CHAIN_ID,
  chainName: 'Polygon Amoy testnet',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  rpcUrls: ['https://rpc-amoy.polygon.technology/'],
  blockExplorerUrls: ['https://amoy.polygonscan.com/']
} as const;
const METAMASK_FOX_ICON_URL = 'https://images.ctfassets.net/clixtyxoaeas/1ezuBGezqfIeifWdVtwU4c/d970d4cdf13b163efddddd5709164d2e/MetaMask-icon-Fox.svg';
const HONEYCOMB_PATTERN = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='52'%3E%3Cpolygon points='30,2 58,16 58,44 30,58 2,44 2,16' fill='none' stroke='rgba(255,255,255,0.08)' stroke-width='1.5'/%3E%3C/svg%3E\")";

/** Điều hướng quản trị sau xác thực; không cho role lạ rơi vào cổng Ủy ban. */
function resolveGovernanceDestination(role: string): string | null {
  if (role === 'admin') return '/admin';
  if (role === 'executive_chair') return '/executive/chair';
  if (role === 'executive_member') return '/executive/member';
  return null;
}

/** Hiển thị cổng MetaMask độc lập, không ảnh hưởng màn đăng nhập Google của người dùng thường. */
export default function GovernanceLoginPage(): ReactElement {
  const router = useRouter();
  const [isConnecting, setIsConnecting] = useState(false);
  const [message, setMessage] = useState('Kết nối ví MetaMask để tiếp tục !');
  const [walletAddress, setWalletAddress] = useState('');

  /** Đảm bảo ví ở Polygon Amoy trước khi ký để luồng quản trị không vô tình chạy ở mạng khác. */
  const ensurePolygonAmoy = useCallback(async (): Promise<void> => {
    const provider = window.ethereum;
    if (!provider) throw new Error('Chưa phát hiện MetaMask. Vui lòng cài đặt MetaMask từ https://metamask.io/download/.');
    const chainId = await provider.request({ method: 'eth_chainId' });
    if (chainId === POLYGON_AMOY_CHAIN_ID) return;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_AMOY_CHAIN_ID }] });
    } catch (error: unknown) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        (error.code !== CHAIN_NOT_ADDED_ERROR_CODE && error.code !== String(CHAIN_NOT_ADDED_ERROR_CODE))
      ) {
        throw error;
      }

      // MetaMask chỉ cho chuyển sau khi người dùng xác nhận thêm mạng chưa từng được cấu hình.
      await provider.request({ method: 'wallet_addEthereumChain', params: [POLYGON_AMOY_NETWORK] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_AMOY_CHAIN_ID }] });
    }
  }, []);

  /** Gọi nonce một lần, ký personal_sign và đổi chữ ký lấy JWT quản trị. */
  const connectAndLogin = useCallback(async (): Promise<void> => {
    const provider = window.ethereum;
    if (!provider) {
      setMessage('Chưa cài MetaMask. Hãy cài đặt từ https://metamask.io/download/.');
      return;
    }
    setIsConnecting(true);
    setMessage('Đang kết nối MetaMask…');
    try {
      await ensurePolygonAmoy();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const address = Array.isArray(accounts) ? String(accounts[0] || '').toLowerCase() : '';
      if (!address) throw new Error('MetaMask chưa trả về địa chỉ ví.');
      setWalletAddress(address);
      const nonceResult = await fetchApi<{ nonce: string; message: string }>(buildApiUrl('/auth/wallet/nonce'), {
        method: 'POST',
        body: JSON.stringify({ walletAddress: address })
      });
      setMessage('Hãy xác nhận chữ ký trong MetaMask.');
      let signature: string;
      try {
        signature = String(await provider.request({ method: 'personal_sign', params: [nonceResult.data.message, address] }));
      } catch (error) {
        if ((error as { code?: number }).code === 4001) throw new Error('Bạn đã huỷ ký. Bấm kết nối lại để thử.');
        throw error;
      }
      const response = await fetch(buildApiUrl('/auth/wallet/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, nonce: nonceResult.data.nonce, signature })
      });
      const data = await parseJsonSafely(response) as WalletLoginResult | { message?: string } | null;
      if (!response.ok || !data || !('accessToken' in data)) {
        const errorMessage = data && typeof data === 'object' && 'message' in data ? data.message : undefined;
        throw new Error(typeof errorMessage === 'string' ? errorMessage : 'Đăng nhập ví thất bại.');
      }
      const destination = resolveGovernanceDestination(data.user.role);
      if (!destination) throw new Error('Ví này chưa được cấp quyền quản trị. Liên hệ quản trị viên.');
      persistAuthSession({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        csrfToken: data.csrfToken,
        refreshSessionId: data.refreshSessionId,
        refreshTokenExpiresAt: data.expiresAt,
        userFullName: data.user.fullName,
        userEmail: data.user.email,
        userWalletAddress: data.user.walletAddress,
        userId: data.user.id,
        userRole: data.user.role
      });
      setMessage('Đăng nhập thành công, đang chuyển trang…');
      router.replace(destination);
    } catch (error) {
      setMessage(getApiErrorMessage(error, error instanceof Error ? error.message : 'Không thể đăng nhập bằng ví.'));
    } finally {
      setIsConnecting(false);
    }
  }, [ensurePolygonAmoy, router]);

  /** Xóa phiên ngay khi người dùng đổi tài khoản MetaMask để không giữ quyền của ví cũ. */
  useEffect(() => {
    const handleAccountsChanged = (accounts: string[]): void => {
      if (walletAddress && String(accounts[0] || '').toLowerCase() !== walletAddress) {
        clearAuthSession();
        setMessage('MetaMask đã đổi ví. Vui lòng đăng nhập lại.');
      }
    };
    window.ethereum?.on?.('accountsChanged', handleAccountsChanged);
    return () => window.ethereum?.removeListener?.('accountsChanged', handleAccountsChanged);
  }, [walletAddress]);

  return <main className="relative grid min-h-dvh overflow-x-hidden bg-[#f8fafb] text-[#0d1117] lg:grid-cols-[0.9fr_1.1fr]">
    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,rgba(26,174,151,0.12),transparent_32%),radial-gradient(circle_at_10%_90%,rgba(14,124,107,0.08),transparent_28%)]" />
    <aside className="relative hidden overflow-hidden bg-gradient-to-br from-[#0e7c6b] via-[#0a5c50] to-[#073d36] px-8 py-10 text-white lg:flex lg:min-h-dvh lg:flex-col lg:justify-between lg:px-12">
      <div className="pointer-events-none absolute inset-0 opacity-100" style={{ backgroundImage: HONEYCOMB_PATTERN, backgroundSize: '60px 52px' }} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_78%_18%,rgba(26,174,151,0.26),transparent_30%),linear-gradient(120deg,transparent_45%,rgba(255,255,255,0.04)_100%)]" />
      <div className="absolute -right-28 -top-28 h-80 w-80 rounded-full bg-[#1aae97]/20 blur-3xl" />
      <a href="/" className="relative flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/30 bg-white/15 backdrop-blur"><svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-white"><path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" /></svg></div><div><div className="text-[19px] font-extrabold tracking-[-0.3px]">DCP</div><div className="text-[10.5px] leading-none text-white/55">Decentralized Charity Platform</div></div></a>
      <div className="relative max-w-md"><div className="mb-7 flex h-[60px] w-[60px] items-center justify-center rounded-2xl border border-white/20 bg-white/10"><svg viewBox="0 0 24 24" className="h-7 w-7 fill-none stroke-white" strokeWidth="1.7"><path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg></div><h2 className="text-[clamp(20px,2.2vw,26px)] font-bold leading-[1.35] tracking-[-0.3px]">Mỗi đồng quyên góp đều để lại <span className="text-[#f59e0b]">dấu vết</span> trên Blockchain.</h2><p className="mt-4 text-[13.5px] italic text-white/55">Không thể xóa. Không thể giả mạo. Mãi minh bạch.</p></div>
      <div className="relative space-y-2.5"><div className="flex items-center gap-4 rounded-xl border border-white/15 bg-white/10 px-[18px] py-[13px] transition hover:bg-white/15"><div className="h-2 w-2 rounded-full bg-[#f59e0b]" /><div><div className="text-[14.5px] font-semibold leading-tight">Quản trị dựa trên quyền hạn</div><div className="text-[11.5px] text-white/55">Chỉ ví được cấp quyền mới có thể truy cập</div></div></div><div className="flex items-center gap-4 rounded-xl border border-white/15 bg-white/10 px-[18px] py-[13px] transition hover:bg-white/15"><div className="h-2 w-2 rounded-full bg-[#1aae97]" /><div><div className="text-[14.5px] font-semibold leading-tight">Xác thực bằng chữ ký</div><div className="text-[11.5px] text-white/55">Không yêu cầu hoặc lưu private key</div></div></div></div>
    </aside>
    <section className="relative flex min-h-dvh flex-col items-center justify-start px-4 py-6 sm:px-8 sm:py-10 lg:justify-center lg:px-14 lg:py-12">
      <a href="/" className="mb-6 flex w-full max-w-[460px] items-center gap-3 px-1 lg:hidden"><div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#0e7c6b]"><svg viewBox="0 0 24 24" className="h-5 w-5 fill-white"><path d="M12 21.7C5.8 17.5 2 13.2 2 9a6 6 0 0112 0 6 6 0 0112 0c0 4.2-3.8 8.5-10 12.7z" /></svg></div><span className="text-lg font-extrabold tracking-[-0.3px] text-[#0d1117]">DCP</span></a>
      <div className="w-full max-w-[460px] rounded-3xl border border-[#e5e7eb] bg-white p-6 shadow-[0_18px_50px_rgba(15,23,42,0.1)] sm:p-10">

        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#0e7c6b]">DCP · CỔNG QUẢN TRỊ</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-[#0d1117]">Đăng nhập bằng MetaMask</h1>
        <p className="mt-3 text-sm leading-6 text-[#4b5563]">Chỉ ví admin, Chủ tịch DAO và Ủy viên Điều hành đã được cấp ghế mới có thể đăng nhập. DCP không yêu cầu hoặc lưu private key của bạn.</p>
        <button type="button" onClick={() => void connectAndLogin()} disabled={isConnecting} className="mt-8 flex w-full items-center justify-center gap-3 rounded-xl bg-[#0e7c6b] px-4 py-3.5 font-bold text-white shadow-[0_10px_24px_rgba(14,124,107,0.22)] transition hover:-translate-y-0.5 hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0e7c6b]/20 disabled:cursor-wait disabled:opacity-60">
          <img src={METAMASK_FOX_ICON_URL} alt="MetaMask logo" className="h-6 w-6 shrink-0" />
          {isConnecting ? 'Đang xác thực…' : 'Kết nối ví MetaMask'}
        </button>
        <p role="status" className="mt-4 rounded-xl border border-[#d7eee9] bg-[#f2fbf9] px-4 py-3 text-sm leading-6 text-[#0a5c50]">{message}</p>
        <div className="mt-6 rounded-xl border border-[#e5e7eb] bg-[#f8fafb] p-4 text-xs leading-5 text-[#4b5563]">DCP chỉ yêu cầu bạn xác nhận chữ ký đăng nhập trong MetaMask. Không cần private key, không chuyển tài sản và không phát sinh phí gas.</div>
      </div>
    </section>
    <style jsx global>{`
      main > aside h2 { text-wrap: balance; }
      main > aside h2 span { white-space: nowrap; }
      main > section h1, main > section p { text-wrap: pretty; }
      @media (min-width: 1024px) {
        main > section h1 { white-space: nowrap; font-size: 27px; }
      }
    `}</style>
  </main>;
/*
    <section className="w-full max-w-lg rounded-2xl border border-violet-400/30 bg-slate-900 p-8 shadow-2xl">
      <p className="text-sm font-semibold tracking-wide text-violet-300">DCP · CỔNG QUẢN TRỊ</p>
      <h1 className="mt-2 text-3xl font-bold">Đăng nhập bằng MetaMask</h1>
      <p className="mt-3 text-sm leading-6 text-slate-300">Chỉ ví admin, Chủ tịch DAO và Ủy viên Điều hành đã được cấp ghế mới có thể đăng nhập. DCP không yêu cầu hoặc lưu private key của bạn.</p>
      <button type="button" onClick={() => void connectAndLogin()} disabled={isConnecting} className="mt-7 w-full rounded-xl bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500 disabled:cursor-wait disabled:opacity-60">
        {isConnecting ? 'Đang xác thực…' : 'Kết nối ví MetaMask'}
      </button>
      <p role="status" className="mt-4 rounded-lg bg-slate-800 px-3 py-3 text-sm text-slate-200">{message}</p>
      <p className="mt-5 text-xs text-slate-400">Yêu cầu ký chỉ xác thực đăng nhập, không chuyển tiền và không tạo giao dịch blockchain.</p>
    </section>
  </main>;
*/
}
