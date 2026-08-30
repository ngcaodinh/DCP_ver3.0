'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { BrowserProvider, Contract, JsonRpcProvider, isAddress } from 'ethers';
import { buildApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';

interface CommitteeSeat {
  userId: string;
  displayName: string;
  role: 'executive_chair' | 'executive_member';
  walletAddress: string;
  accountStatus: string;
  lastLoginAt: string | null;
}

interface EthereumProvider {
  request: (input: { method: string; params?: unknown[] }) => Promise<unknown>;
}

const COMMITTEE_ABI = [
  'function seatsBootstrapped() view returns (bool)',
  'function bootstrapSeats(address[5] seats,uint8[5] roles)',
];
const POLYGON_AMOY_CHAIN_ID = '0x13882';

/** Quản lý ghế off-chain và bootstrap một lần lên chuỗi bằng chữ ký MetaMask của bootstrap admin. */
export default function CommitteeSeatsPanel(): ReactElement {
  const [seats, setSeats] = useState<CommitteeSeat[]>([]);
  const [walletAddress, setWalletAddress] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<CommitteeSeat['role']>('executive_member');
  const [isReviewing, setIsReviewing] = useState(false);
  const [secondReviewerConfirmed, setSecondReviewerConfirmed] = useState(false);
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const contractAddress = process.env.NEXT_PUBLIC_COMMITTEE_GOVERNANCE_ADDRESS || '';
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || '';

  /** Lấy header xác thực mới tại thời điểm gọi để token đã bị thu hồi không tiếp tục được dùng. */
  const getHeaders = (): HeadersInit => {
    const token = readAuthSession().accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /** Tải danh sách ghế từ nguồn off-chain trong giai đoạn Admin được phép bootstrap. */
  const loadSeats = useCallback(async (): Promise<void> => {
    try {
      const response = await fetchApi<CommitteeSeat[]>(buildApiUrl('/api/governance/seats'), { headers: getHeaders() });
      setSeats(response.data);
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể tải danh sách ghế Ủy ban.'));
    }
  }, []);

  /** Ưu tiên proof server rồi đối chiếu chain; chỉ khóa UI khi bootstrap được xác nhận rõ ràng. */
  const loadBootstrapState = useCallback(async (): Promise<void> => {
    try {
      const response = await fetchApi<{ transactionHash: string } | null>(
        buildApiUrl('/api/governance/seats/bootstrap/state'),
        { headers: getHeaders() },
      );
      if (response.data) {
        setIsBootstrapped(true);
        return;
      }
    } catch {
      setIsBootstrapped(false);
      setNotice('Không thể xác minh proof bootstrap từ server. Bạn vẫn có thể chuẩn bị danh sách ghế; trước khi nạp, contract sẽ kiểm tra trạng thái bootstrap trên chuỗi.');
      return;
    }

    if (!isAddress(contractAddress) || !rpcUrl) return;

    try {
      const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
      const contract = new Contract(contractAddress, COMMITTEE_ABI, provider);
      setIsBootstrapped(Boolean(await contract.seatsBootstrapped()));
    } catch {
      setIsBootstrapped(false);
      setNotice('Không thể đọc trạng thái CommitteeGovernance trên chuỗi. Bạn vẫn có thể chuẩn bị danh sách ghế; trước khi nạp, contract sẽ kiểm tra trạng thái bootstrap trên chuỗi.');
    }
  }, [contractAddress, rpcUrl]);

  useEffect(() => {
    void loadSeats();
    void loadBootstrapState();
  }, [loadBootstrapState, loadSeats]);

  /** Mở bước đối chiếu địa chỉ đầy đủ trước khi Admin cấp ghế trong giai đoạn bootstrap. */
  const requestReview = (): void => {
    if (!walletAddress.trim() || !displayName.trim()) {
      setNotice('Nhập địa chỉ ví và tên hiển thị trước khi xem lại.');
      return;
    }
    setIsReviewing(true);
  };

  /** Cấp ghế sau bước review; backend tiếp tục xác thực checksum, trùng lặp và tỷ lệ 1 Chủ tịch + 4 Ủy viên. */
  const createSeat = async (): Promise<void> => {
    try {
      await fetchApi(buildApiUrl('/api/governance/seats'), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ walletAddress: walletAddress.trim(), displayName: displayName.trim(), role }),
      });
      setWalletAddress('');
      setDisplayName('');
      setIsReviewing(false);
      setNotice('Đã cấp ghế. Chủ ví cần đăng nhập bằng MetaMask trước khi nạp danh sách lên blockchain.');
      await loadSeats();
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể cấp ghế Ủy ban.'));
    }
  };

  /** Thu ghế trước bootstrap, đồng thời backend thu hồi phiên hiện tại và lưu audit trail. */
  const suspendSeat = async (seat: CommitteeSeat): Promise<void> => {
    if (!window.confirm(`Thu ghế ${seat.displayName} (${seat.walletAddress})? Phiên đang mở sẽ bị thu hồi.`)) return;

    try {
      await fetchApi(buildApiUrl(`/api/governance/seats/${seat.walletAddress}`), {
        method: 'DELETE',
        headers: getHeaders(),
      });
      setNotice('Đã thu ghế và thu hồi phiên đang mở.');
      await loadSeats();
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể thu ghế.'));
    }
  };

  /** Nạp roster một lần bằng ví bootstrap admin; contract xác thực tỷ lệ ghế và khóa thay đổi trực tiếp sau giao dịch. */
  const bootstrapOnChain = async (): Promise<void> => {
    const activeSeats = seats.filter(seat => seat.accountStatus === 'ACTIVE');
    const chairCount = activeSeats.filter(seat => seat.role === 'executive_chair').length;
    const memberCount = activeSeats.filter(seat => seat.role === 'executive_member').length;

    if (activeSeats.length !== 5 || chairCount !== 1 || memberCount !== 4) {
      setNotice('Cần đúng 1 Chủ tịch và 4 Ủy viên ACTIVE trước khi nạp lên blockchain.');
      return;
    }
    if (activeSeats.some(seat => !seat.lastLoginAt)) {
      setNotice('Cả năm chủ ví phải đăng nhập MetaMask thành công trước khi bootstrap để chứng minh quyền sở hữu ví.');
      return;
    }
    if (!secondReviewerConfirmed) {
      setNotice('Cần xác nhận người thứ hai đã đối chiếu đủ năm địa chỉ.');
      return;
    }
    if (!isAddress(contractAddress)) {
      setNotice('Địa chỉ CommitteeGovernance chưa hợp lệ.');
      return;
    }

    const ethereum = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!ethereum) {
      setNotice('Chưa cài MetaMask.');
      return;
    }

    setIsSubmitting(true);
    try {
      await ethereum.request({ method: 'eth_requestAccounts' });
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_AMOY_CHAIN_ID }] });
      const provider = new BrowserProvider(ethereum);
      const signer = await provider.getSigner();
      const contract = new Contract(contractAddress, COMMITTEE_ABI, signer);
      const transaction = await contract.bootstrapSeats(
        activeSeats.map(seat => seat.walletAddress),
        activeSeats.map(seat => seat.role === 'executive_chair' ? 1 : 2),
      );
      await transaction.wait();

      try {
        await fetchApi(buildApiUrl('/api/governance/seats/bootstrap/confirm'), {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ transactionHash: transaction.hash }),
        });
      } catch (error) {
        setNotice(`Giao dịch ${transaction.hash} đã xác nhận trên chuỗi nhưng server chưa lưu proof: ${getApiErrorMessage(error, 'liên hệ vận hành và không gửi lại giao dịch.')}`);
        await loadBootstrapState();
        return;
      }

      setNotice(`Đã nạp 5 ghế lên blockchain. Tx: ${transaction.hash}`);
      await loadBootstrapState();
    } catch (error) {
      setNotice(getApiErrorMessage(error, 'Không thể nạp ghế. Kiểm tra ví bootstrap admin, mạng Polygon Amoy và xác nhận MetaMask.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeSeats = seats.filter(seat => seat.accountStatus === 'ACTIVE');

  return (
    <section className="space-y-5" aria-label="Quản lý ghế Ủy ban">
      <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="note">
        <p className="font-semibold">Xác minh ví trước khi cấp ghế</p>
        <p className="mt-1">
          Chỉ thêm địa chỉ ví do chính Chủ tịch hoặc Ủy viên xác nhận và đã đăng nhập bằng MetaMask. Trước khi nạp lên chuỗi, người thứ hai phải đối chiếu toàn bộ địa chỉ. Sau bootstrap, Admin chỉ theo dõi danh sách; việc thay ghế do Ủy ban xử lý theo đề xuất 3/5 chữ ký và timelock 3 ngày trên chuỗi.
        </p>
      </aside>

      {notice ? <p role="status" aria-live="polite" className="break-all rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 shadow-sm">{notice}</p> : null}

      {isBootstrapped ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5" aria-label="Trạng thái bootstrap ghế Ủy ban">
          <h2 className="font-semibold text-emerald-950">Danh sách ghế đã khóa trên chuỗi</h2>
          <p className="mt-1 text-sm leading-6 text-emerald-900">Admin không còn quyền thêm, thu, ký hoặc thực thi thay ghế. Ủy ban thực hiện thay ghế bằng cổng riêng, theo đủ 3/5 chữ ký hợp lệ và timelock 3 ngày.</p>
        </section>
      ) : (
        <section className="rounded-2xl border border-emerald-900/15 bg-white p-4 shadow-sm sm:p-5" aria-labelledby="create-committee-seat-heading">
          <div>
            <h2 id="create-committee-seat-heading" className="font-semibold text-slate-900">Cấp ghế mới</h2>
            <p className="mt-1 text-sm text-slate-500">Hoàn tất đủ 1 Chủ tịch và 4 Ủy viên trước khi bootstrap.</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label htmlFor="committee-seat-name" className="grid gap-1.5 text-sm font-medium text-slate-700">
              Tên hiển thị
              <input id="committee-seat-name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Ví dụ: Nguyễn Văn A" className="min-h-10 rounded-xl border border-slate-200 px-3 text-sm outline-none transition focus:border-[#0E7C6B] focus:ring-2 focus:ring-emerald-100" />
            </label>
            <label htmlFor="committee-seat-wallet" className="grid gap-1.5 text-sm font-medium text-slate-700 md:col-span-2">
              Địa chỉ ví đầy đủ
              <input id="committee-seat-wallet" value={walletAddress} onChange={event => setWalletAddress(event.target.value)} placeholder="0x..." className="min-h-10 rounded-xl border border-slate-200 px-3 font-mono text-sm outline-none transition focus:border-[#0E7C6B] focus:ring-2 focus:ring-emerald-100" />
            </label>
            <label htmlFor="committee-seat-role" className="grid gap-1.5 text-sm font-medium text-slate-700">
              Vai trò
              <select id="committee-seat-role" value={role} onChange={event => setRole(event.target.value as CommitteeSeat['role'])} className="min-h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-[#0E7C6B] focus:ring-2 focus:ring-emerald-100">
                <option value="executive_member">Ủy viên Điều hành</option>
                <option value="executive_chair">Chủ tịch DAO</option>
              </select>
            </label>
            <div className="flex items-end md:col-span-2">
              <button type="button" onClick={requestReview} className="min-h-10 w-full rounded-xl bg-[#0E7C6B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0A5C50] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">Xem lại địa chỉ đầy đủ</button>
            </div>
          </div>

          {isReviewing ? (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-950">Xác nhận cấp ghế cho {displayName}</p>
              <code className="mt-2 block break-all rounded-lg border border-emerald-100 bg-white p-3 text-sm text-slate-900">{walletAddress.trim()}</code>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={() => void createSeat()} className="min-h-10 rounded-xl bg-[#0E7C6B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0A5C50]">Đúng, cấp ghế</button>
                <button type="button" onClick={() => setIsReviewing(false)} className="min-h-10 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Quay lại sửa</button>
              </div>
            </div>
          ) : null}
        </section>
      )}

      <section className="rounded-2xl border border-emerald-900/15 bg-white shadow-sm" aria-labelledby="committee-seat-list-heading">
        <div className="border-b border-slate-100 px-4 py-4 sm:px-5">
          <h2 id="committee-seat-list-heading" className="font-semibold text-slate-900">Danh sách ghế hiện tại</h2>
          <p className="mt-1 text-sm text-slate-500">Địa chỉ ví luôn hiển thị đầy đủ để người vận hành đối chiếu.</p>
        </div>

        <ul className="divide-y divide-slate-100 md:hidden">
          {seats.length === 0 ? <li className="p-4 text-sm text-slate-500">Chưa có ghế nào được cấp.</li> : null}
          {seats.map(seat => (
            <li key={seat.userId} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">{seat.displayName}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{seat.role === 'executive_chair' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành'}</p>
                </div>
                {!isBootstrapped && seat.accountStatus === 'ACTIVE' ? <button type="button" onClick={() => void suspendSeat(seat)} className="min-h-10 shrink-0 rounded-xl px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50">Thu ghế</button> : null}
              </div>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-xs font-medium text-slate-500">Địa chỉ ví</dt><dd className="mt-1 break-all font-mono text-xs text-slate-800">{seat.walletAddress}</dd></div>
                <div><dt className="text-xs font-medium text-slate-500">Đăng nhập gần nhất</dt><dd className="mt-1 text-slate-700">{seat.lastLoginAt ? <time dateTime={seat.lastLoginAt}>{new Date(seat.lastLoginAt).toLocaleString('vi-VN')}</time> : 'Chưa đăng nhập'}</dd></div>
              </dl>
            </li>
          ))}
        </ul>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr><th className="px-5 py-3 font-semibold">Vai trò</th><th className="px-5 py-3 font-semibold">Tên</th><th className="px-5 py-3 font-semibold">Địa chỉ ví đầy đủ</th><th className="px-5 py-3 font-semibold">Đăng nhập gần nhất</th><th className="px-5 py-3 font-semibold">Thao tác</th></tr></thead>
            <tbody>
              {seats.length === 0 ? <tr><td colSpan={5} className="px-5 py-8 text-center text-slate-500">Chưa có ghế nào được cấp.</td></tr> : null}
              {seats.map(seat => <tr key={seat.userId} className="border-t border-slate-100"><td className="px-5 py-4 text-slate-700">{seat.role === 'executive_chair' ? 'Chủ tịch DAO' : 'Ủy viên Điều hành'}</td><td className="px-5 py-4 font-medium text-slate-900">{seat.displayName}</td><td className="max-w-sm break-all px-5 py-4 font-mono text-xs text-slate-800">{seat.walletAddress}</td><td className="px-5 py-4 text-slate-700">{seat.lastLoginAt ? <time dateTime={seat.lastLoginAt}>{new Date(seat.lastLoginAt).toLocaleString('vi-VN')}</time> : 'Chưa đăng nhập'}</td><td className="px-5 py-4">{!isBootstrapped && seat.accountStatus === 'ACTIVE' ? <button type="button" onClick={() => void suspendSeat(seat)} className="min-h-10 rounded-xl px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50">Thu ghế</button> : <span className="text-xs text-slate-400">—</span>}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>

      {!isBootstrapped ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5" aria-labelledby="bootstrap-committee-seat-heading">
          <h2 id="bootstrap-committee-seat-heading" className="font-semibold text-amber-950">Nạp 5 ghế lên blockchain — chỉ một lần</h2>
          <p className="mt-1 text-sm leading-6 text-amber-900">Yêu cầu cả năm chủ ví đăng nhập thử bằng MetaMask, sau đó một người thứ hai đối chiếu đủ năm địa chỉ. Contract chỉ chấp nhận đúng một Chủ tịch và bốn Ủy viên.</p>
          <label className="mt-4 flex items-start gap-2 text-sm text-amber-950"><input checked={secondReviewerConfirmed} onChange={event => setSecondReviewerConfirmed(event.target.checked)} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-amber-400 text-[#0E7C6B] focus:ring-emerald-500" />Người thứ hai đã đối chiếu địa chỉ và trạng thái đăng nhập.</label>
          <button disabled={isSubmitting || activeSeats.length !== 5 || activeSeats.some(seat => !seat.lastLoginAt)} type="button" onClick={() => void bootstrapOnChain()} className="mt-4 min-h-10 rounded-xl bg-[#0E7C6B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#0A5C50] disabled:cursor-not-allowed disabled:opacity-50">{isSubmitting ? 'Đang chờ MetaMask…' : 'Nạp 5 ghế lên blockchain'}</button>
        </section>
      ) : null}
    </section>
  );
}
