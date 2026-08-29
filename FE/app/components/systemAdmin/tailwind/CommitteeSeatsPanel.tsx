'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { BrowserProvider, Contract, JsonRpcProvider, isAddress } from 'ethers';
import { buildApiUrl, fetchApi, getApiErrorMessage } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import {
  createCommitteeSeatChangeDraft,
  executeCommitteeSeatChangeProposal,
  parseCommitteeSeatChangeDraft,
  signCommitteeSeatChangeDraft,
  submitCommitteeSeatChangeProposal
} from '@/app/utils/committeeSeatChange';

type CommitteeSeat = { userId: string; displayName: string; role: 'executive_chair' | 'executive_member'; walletAddress: string; accountStatus: string; lastLoginAt: string | null };
type EthereumProvider = { request: (input: { method: string; params?: unknown[] }) => Promise<unknown> };

const committeeAbi = [
  'function seatsBootstrapped() view returns (bool)',
  'function bootstrapSeats(address[5] seats,uint8[5] roles)'
];

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
  const [seatChangeOldWallet, setSeatChangeOldWallet] = useState('');
  const [seatChangeNewWallet, setSeatChangeNewWallet] = useState('');
  const [seatChangeDraft, setSeatChangeDraft] = useState('');
  const [seatChangeProposalId, setSeatChangeProposalId] = useState('');
  const [isSeatChangeSubmitting, setIsSeatChangeSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const contractAddress = process.env.NEXT_PUBLIC_COMMITTEE_GOVERNANCE_ADDRESS || '';
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || '';

  /** Lấy token tại thời điểm gọi để token đã bị thu hồi không tiếp tục cấp ghế. */
  const getHeaders = (): HeadersInit => {
    const token = readAuthSession().accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /** Tải roster từ nguồn off-chain cho giai đoạn bootstrap. */
  const loadSeats = useCallback(async (): Promise<void> => {
    try { setSeats((await fetchApi<CommitteeSeat[]>(buildApiUrl('/api/governance/seats'), { headers: getHeaders() })).data); }
    catch (error) { setNotice(getApiErrorMessage(error, 'Không thể tải ghế Ủy ban.')); }
  }, []);

  /** Đọc proof server trước, rồi đối chiếu chain; khi không thể xác minh thì khóa UI thay vì suy diễn chưa bootstrap. */
  const loadBootstrapState = useCallback(async (): Promise<void> => {
    try {
      const persistedProof = (await fetchApi<{ transactionHash: string } | null>(
        buildApiUrl('/api/governance/seats/bootstrap/state'),
        { headers: getHeaders() }
      )).data;
      if (persistedProof) {
        setIsBootstrapped(true);
        return;
      }
    } catch {
      setIsBootstrapped(true);
      setNotice('Không thể xác minh proof bootstrap từ server; roster bị khóa an toàn.');
      return;
    }
    if (!isAddress(contractAddress) || !rpcUrl) return;
    try {
      const contract = new Contract(contractAddress, committeeAbi, new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true }));
      setIsBootstrapped(Boolean(await contract.seatsBootstrapped()));
    } catch {
      setIsBootstrapped(true);
      setNotice('Không thể đọc trạng thái CommitteeGovernance trên chuỗi; roster bị khóa an toàn.');
    }
  }, [contractAddress, rpcUrl]);

  useEffect(() => { void loadSeats(); void loadBootstrapState(); }, [loadBootstrapState, loadSeats]);

  /** Mở bước đối chiếu địa chỉ đầy đủ trước khi cấp ghế ngoài chuỗi. */
  const requestReview = (): void => {
    if (isBootstrapped) { setNotice('Ghế đã nạp lên chuỗi; không thể sửa qua giao diện admin.'); return; }
    if (!walletAddress.trim() || !displayName.trim()) { setNotice('Nhập địa chỉ ví và tên hiển thị trước khi xem lại.'); return; }
    setIsReviewing(true);
  };

  /** Cấp ghế sau bước review; backend tiếp tục là nơi xác thực checksum, trùng và quota 1+4. */
  const createSeat = async (): Promise<void> => {
    try {
      await fetchApi(buildApiUrl('/api/governance/seats'), { method: 'POST', headers: getHeaders(), body: JSON.stringify({ walletAddress: walletAddress.trim(), displayName: displayName.trim(), role }) });
      setWalletAddress(''); setDisplayName(''); setIsReviewing(false);
      setNotice('Đã cấp ghế. Chủ ví phải đăng nhập thử trước khi nạp danh sách lên blockchain.');
      await loadSeats();
    } catch (error) { setNotice(getApiErrorMessage(error, 'Không thể cấp ghế Ủy ban.')); }
  };

  /** Suspend giữ nguyên lịch sử snapshot nhưng thu hồi phiên hiện tại của chủ ghế. */
  const suspendSeat = async (seat: CommitteeSeat): Promise<void> => {
    if (isBootstrapped) { setNotice('Sau bootstrap, thay ghế phải theo đề xuất 3/5 trên chuỗi.'); return; }
    if (!window.confirm(`Thu ghế ${seat.displayName} (${seat.walletAddress})? Phiên đang mở sẽ bị thu hồi.`)) return;
    try { await fetchApi(buildApiUrl(`/api/governance/seats/${seat.walletAddress}`), { method: 'DELETE', headers: getHeaders() }); setNotice('Đã thu ghế và thu hồi phiên đang mở.'); await loadSeats(); }
    catch (error) { setNotice(getApiErrorMessage(error, 'Không thể thu ghế.')); }
  };

  /** Gọi bootstrapSeats từ MetaMask; contract tự xác thực bootstrap admin, tỷ lệ 1 Chair + 4 Member và one-time lock. */
  const bootstrapOnChain = async (): Promise<void> => {
    const activeSeats = seats.filter(seat => seat.accountStatus === 'ACTIVE');
    const chairCount = activeSeats.filter(seat => seat.role === 'executive_chair').length;
    const memberCount = activeSeats.filter(seat => seat.role === 'executive_member').length;
    if (isBootstrapped || activeSeats.length !== 5 || chairCount !== 1 || memberCount !== 4) {
      setNotice('Cần đúng 1 Chủ tịch và 4 Ủy viên ACTIVE trước khi nạp lên blockchain.');
      return;
    }
    if (activeSeats.some(seat => !seat.lastLoginAt)) {
      setNotice('Cả năm chủ ví phải đăng nhập MetaMask thành công trước khi bootstrap để chứng minh quyền sở hữu ví.');
      return;
    }
    if (!secondReviewerConfirmed) { setNotice('Cần xác nhận người thứ hai đã đối chiếu đủ năm địa chỉ.'); return; }
    if (!isAddress(contractAddress)) { setNotice('NEXT_PUBLIC_COMMITTEE_GOVERNANCE_ADDRESS chưa hợp lệ.'); return; }
    const ethereum = (window as Window & { ethereum?: EthereumProvider }).ethereum;
    if (!ethereum) { setNotice('Chưa cài MetaMask.'); return; }
    setIsSubmitting(true);
    try {
      await ethereum.request({ method: 'eth_requestAccounts' });
      await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13882' }] });
      const provider = new BrowserProvider(ethereum);
      const signer = await provider.getSigner();
      const contract = new Contract(contractAddress, committeeAbi, signer);
      const transaction = await contract.bootstrapSeats(activeSeats.map(seat => seat.walletAddress), activeSeats.map(seat => seat.role === 'executive_chair' ? 1 : 2));
      await transaction.wait();
      try {
        await fetchApi(buildApiUrl('/api/governance/seats/bootstrap/confirm'), {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ transactionHash: transaction.hash })
        });
      } catch (error) {
        setNotice(`Transaction ${transaction.hash} đã xác nhận trên chuỗi nhưng server chưa lưu được proof: ${getApiErrorMessage(error, 'hãy liên hệ vận hành, không gửi lại transaction.')}`);
        await loadBootstrapState();
        return;
      }
      setNotice(`Đã nạp 5 ghế lên blockchain. Tx: ${transaction.hash}`);
      await loadBootstrapState();
    } catch (error) { setNotice(getApiErrorMessage(error, 'Không thể nạp ghế. Kiểm tra ví bootstrap admin, mạng Polygon Amoy và xác nhận MetaMask.')); }
    finally { setIsSubmitting(false); }
  };

  /** Tạo draft EIP-712 dùng chung cho ba ghế, ràng buộc vào epoch hiện tại và hạn ký đọc từ chain. */
  const createSeatChangeDraft = async (): Promise<void> => {
    if (!isBootstrapped) { setNotice('Chỉ có thể thay ghế sau khi roster đã bootstrap trên chain.'); return; }
    const oldSeat = seats.find(seat => seat.walletAddress.toLowerCase() === seatChangeOldWallet.toLowerCase() && seat.accountStatus === 'ACTIVE');
    if (!oldSeat) { setNotice('Chọn một ghế ACTIVE cần thay.'); return; }
    setIsSeatChangeSubmitting(true);
    try {
      const draft = await createCommitteeSeatChangeDraft({
        contractAddress,
        rpcUrl,
        oldSeat: oldSeat.walletAddress,
        newSeat: seatChangeNewWallet.trim(),
        role: oldSeat.role === 'executive_chair' ? 1 : 2
      });
      setSeatChangeDraft(JSON.stringify(draft, null, 2));
      setNotice('Đã tạo draft. Chia sẻ nguyên văn JSON cho từng ghế ký; mỗi người mở panel này, dán draft và chọn “Ký draft hiện tại”.');
    } catch (error) { setNotice(getApiErrorMessage(error, 'Không thể tạo draft thay ghế.')); }
    finally { setIsSeatChangeSubmitting(false); }
  };

  /** Ký cùng một draft và ghi lại signature vào JSON để luồng thu thập không cần backend giữ private key. */
  const signSeatChangeDraft = async (): Promise<void> => {
    setIsSeatChangeSubmitting(true);
    try {
      const draft = parseCommitteeSeatChangeDraft(seatChangeDraft);
      const signature = await signCommitteeSeatChangeDraft({ contractAddress, draft });
      setSeatChangeDraft(JSON.stringify({ ...draft, signatures: [...draft.signatures, signature] }, null, 2));
      setNotice('Đã thêm chữ ký vào draft. Cần đủ ba chữ ký ghế khác nhau trước khi gửi proposal.');
    } catch (error) { setNotice(getApiErrorMessage(error, 'Không thể ký draft thay ghế.')); }
    finally { setIsSeatChangeSubmitting(false); }
  };

  /** Bất kỳ ví nào cũng có thể relay proposal, nhưng contract chỉ nhận đủ chữ ký EIP-712 hợp lệ của roster hiện hữu. */
  const submitSeatChangeProposal = async (): Promise<void> => {
    setIsSeatChangeSubmitting(true);
    try {
      const transactionHash = await submitCommitteeSeatChangeProposal({ contractAddress, draft: parseCommitteeSeatChangeDraft(seatChangeDraft) });
      setNotice(`Đã gửi proposal thay ghế. Tx: ${transactionHash}. Ghi lại proposal ID từ event SeatChangeProposed để thực thi sau timelock.`);
    } catch (error) { setNotice(getApiErrorMessage(error, 'Không thể gửi proposal thay ghế.')); }
    finally { setIsSeatChangeSubmitting(false); }
  };

  /** Thực thi proposal sau timelock; event SeatChangeExecuted sẽ được projector backend xác nhận rồi đồng bộ DB. */
  const executeSeatChangeProposal = async (): Promise<void> => {
    setIsSeatChangeSubmitting(true);
    try {
      const draft = parseCommitteeSeatChangeDraft(seatChangeDraft);
      const transactionHash = await executeCommitteeSeatChangeProposal({ contractAddress, chainId: draft.chainId, proposalId: seatChangeProposalId.trim() });
      setNotice(`Đã thực thi thay ghế trên chain. Tx: ${transactionHash}. Roster off-chain sẽ được projector đồng bộ sau finality.`);
      await loadSeats();
    } catch (error) { setNotice(getApiErrorMessage(error, 'Không thể thực thi proposal thay ghế.')); }
    finally { setIsSeatChangeSubmitting(false); }
  };

  const activeSeats = seats.filter(seat => seat.accountStatus === 'ACTIVE');
  return <section className="space-y-5">
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Chỉ dùng địa chỉ do từng Ủy viên tự xác nhận. Sau bootstrap, admin bị khóa vĩnh viễn khỏi việc sửa ghế; thay ghế phải dùng 3/5 chữ ký và chờ ba ngày trên chuỗi.</p>
    {notice ? <p role="status" className="break-all rounded-lg bg-slate-100 p-3 text-sm">{notice}</p> : null}
    <div className="rounded-xl border bg-white p-4"><h2 className="font-bold">Cấp ghế mới</h2><div className="mt-3 grid gap-3 md:grid-cols-3"><input disabled={isBootstrapped} value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Tên hiển thị" className="rounded-lg border p-2 text-sm disabled:bg-slate-100" /><input disabled={isBootstrapped} value={walletAddress} onChange={event => setWalletAddress(event.target.value)} placeholder="0x..." className="rounded-lg border p-2 text-sm disabled:bg-slate-100 md:col-span-2" /><select disabled={isBootstrapped} value={role} onChange={event => setRole(event.target.value as CommitteeSeat['role'])} className="rounded-lg border p-2 text-sm disabled:bg-slate-100"><option value="executive_member">Ủy viên Điều hành</option><option value="executive_chair">Chủ tịch DAO</option></select><button disabled={isBootstrapped} type="button" onClick={requestReview} className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 md:col-span-2">Xem lại địa chỉ đầy đủ</button></div>{isReviewing ? <div className="mt-4 rounded-lg border-2 border-violet-300 bg-violet-50 p-4"><p className="text-sm font-semibold">Xác nhận cấp ghế cho: {displayName}</p><code className="mt-2 block break-all rounded bg-white p-2 text-sm text-slate-900">{walletAddress.trim()}</code><div className="mt-3 flex gap-2"><button type="button" onClick={() => void createSeat()} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white">Đúng, cấp ghế</button><button type="button" onClick={() => setIsReviewing(false)} className="rounded-lg border px-3 py-2 text-sm">Quay lại sửa</button></div></div> : null}</div>
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">Vai trò</th><th className="p-3">Tên</th><th className="p-3">Địa chỉ ví (đầy đủ)</th><th className="p-3">Đã login gần nhất</th><th className="p-3">Thao tác</th></tr></thead><tbody>{seats.map(seat => <tr key={seat.userId} className="border-t"><td className="p-3">{seat.role === 'executive_chair' ? 'Chủ tịch DAO' : 'Ủy viên'}</td><td className="p-3">{seat.displayName}</td><td className="break-all p-3 font-mono text-xs">{seat.walletAddress}</td><td className="p-3">{seat.lastLoginAt ? new Date(seat.lastLoginAt).toLocaleString('vi-VN') : 'Chưa đăng nhập'}</td><td className="p-3">{seat.accountStatus === 'ACTIVE' ? <button disabled={isBootstrapped} type="button" onClick={() => void suspendSeat(seat)} className="text-sm font-semibold text-red-700 disabled:opacity-50">Thu ghế</button> : null}</td></tr>)}</tbody></table></div>
    {isBootstrapped ? <section className="rounded-xl border-2 border-violet-200 bg-violet-50 p-4"><h2 className="font-bold text-violet-950">Thay ghế on-chain (3/5 chữ ký + timelock)</h2><p className="mt-1 text-sm text-violet-900">Draft là dữ liệu EIP-712 có thể chia sẻ giữa các ghế, không chứa private key. Không sửa tay các trường old/new seat, role, epoch hoặc deadline sau khi đã có chữ ký.</p><div className="mt-3 grid gap-3 md:grid-cols-2"><select aria-label="Ghế cần thay" value={seatChangeOldWallet} onChange={event => setSeatChangeOldWallet(event.target.value)} className="rounded-lg border p-2 text-sm"><option value="">Chọn ghế cần thay</option>{activeSeats.map(seat => <option key={seat.userId} value={seat.walletAddress}>{seat.role === 'executive_chair' ? 'Chủ tịch' : 'Ủy viên'} — {seat.displayName} ({seat.walletAddress})</option>)}</select><input value={seatChangeNewWallet} onChange={event => setSeatChangeNewWallet(event.target.value)} placeholder="Địa chỉ ví ghế mới 0x..." className="rounded-lg border p-2 text-sm" /></div><button disabled={isSeatChangeSubmitting} type="button" onClick={() => void createSeatChangeDraft()} className="mt-3 rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Tạo draft thay ghế</button><textarea value={seatChangeDraft} onChange={event => setSeatChangeDraft(event.target.value)} placeholder="Dán hoặc tạo JSON draft EIP-712 ở đây" className="mt-3 min-h-48 w-full rounded-lg border p-2 font-mono text-xs" aria-label="JSON draft thay ghế" /><div className="mt-3 flex flex-wrap gap-2"><button disabled={isSeatChangeSubmitting || !seatChangeDraft.trim()} type="button" onClick={() => void signSeatChangeDraft()} className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Ký draft hiện tại</button><button disabled={isSeatChangeSubmitting || !seatChangeDraft.trim()} type="button" onClick={() => void submitSeatChangeProposal()} className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Gửi proposal (đủ 3 chữ ký)</button></div><div className="mt-4 flex flex-wrap gap-2"><input value={seatChangeProposalId} onChange={event => setSeatChangeProposalId(event.target.value)} inputMode="numeric" placeholder="Proposal ID sau timelock" className="rounded-lg border p-2 text-sm" /><button disabled={isSeatChangeSubmitting || !seatChangeDraft.trim() || !seatChangeProposalId.trim()} type="button" onClick={() => void executeSeatChangeProposal()} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Thực thi proposal</button></div></section> : null}
    <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4"><h2 className="font-bold text-red-950">Nạp 5 ghế lên blockchain — chỉ một lần</h2><p className="mt-1 text-sm text-red-900">Hãy yêu cầu cả năm chủ ví đăng nhập thử, rồi để người thứ hai đối chiếu đủ năm địa chỉ dưới đây. Contract chỉ nhận đúng một Chair và bốn Member.</p><label className="mt-3 block text-sm"><input disabled={isBootstrapped} checked={secondReviewerConfirmed} onChange={event => setSecondReviewerConfirmed(event.target.checked)} type="checkbox" className="mr-2" />Người thứ hai đã đối chiếu địa chỉ và trạng thái đăng nhập.</label><button disabled={isBootstrapped || isSubmitting || activeSeats.length !== 5 || activeSeats.some(seat => !seat.lastLoginAt)} type="button" onClick={() => void bootstrapOnChain()} className="mt-3 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{isBootstrapped ? 'Đã khóa bootstrap trên chuỗi' : isSubmitting ? 'Đang chờ MetaMask…' : 'Nạp 5 ghế lên blockchain'}</button></div>
  </section>;
}
