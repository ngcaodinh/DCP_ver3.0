'use client';

import { useEffect, useState } from 'react';
import DonationModal from './components/DonationModal';
import { ApiErrorResponse, buildApiUrl, fetchApi } from '../utils/apiClient';

type DonationCampaignItem = {
  projectId: string;
  name: string;
  description: string;
  goalAmount: number;
  donatedAmount: number;
  donationCount: number;
  status: string;
  updatedAt: string;
  deadline?: string;
  minDonation: number;
  maxDonation: number;
};

/** Hàm định dạng số tiền. Mục đích: hiển thị số liệu gây quỹ rõ ràng và đồng nhất. */
function formatCurrency(amountValue: number): string {
  return new Intl.NumberFormat('vi-VN').format(amountValue);
}

/** Hàm kiểm tra campaign còn hạn donate. Mục đích: chặn thao tác donate với dự án quá hạn. */
function isCampaignBeforeDeadline(deadlineIso?: string): boolean {
  if (!deadlineIso) return true;
  const parsedDeadline = new Date(deadlineIso);
  if (Number.isNaN(parsedDeadline.getTime())) return true;
  return parsedDeadline.getTime() >= Date.now();
}

/** Hàm kiểm tra campaign đủ điều kiện donate. Mục đích: gom rule nghiệp vụ UC3.1 tại một nơi. */
function isCampaignEligibleForDonation(campaignItem: DonationCampaignItem): boolean {
  return campaignItem.status === 'ACTIVE' && isCampaignBeforeDeadline(campaignItem.deadline);
}

/** Hàm lấy lý do campaign chưa thể donate. Mục đích: hiển thị phản hồi rõ ràng thay vì im lặng khi người dùng bấm nút. */
function getCampaignIneligibleReason(campaignItem: DonationCampaignItem): string {
  if (campaignItem.status !== 'ACTIVE') {
    return 'Dự án chưa ở trạng thái ACTIVE.';
  }

  if (!isCampaignBeforeDeadline(campaignItem.deadline)) {
    return 'Dự án đã quá hạn nhận quyên góp.';
  }

  return 'Dự án hiện chưa đủ điều kiện nhận quyên góp.';
}

/** Hàm trang danh sách chiến dịch. Mục đích: hiển thị campaign và mở modal donate không chuyển trang. */
export default function DonationCampaignListPage() {
  const [campaignList, setCampaignList] = useState<DonationCampaignItem[]>([]);
  const [isLoadingCampaignList, setIsLoadingCampaignList] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedCampaign, setSelectedCampaign] = useState<DonationCampaignItem | null>(null);
  const [interactionMessage, setInteractionMessage] = useState('');
  const [interactionNoticeVersion, setInteractionNoticeVersion] = useState(0);

  /** Hàm tải danh sách campaign. Mục đích: dùng cho lần tải đầu và refresh sau donate thành công. */
  const loadCampaignList = async () => {
    setIsLoadingCampaignList(true);
    setErrorMessage('');

    try {
      const campaignResponse = await fetchApi<DonationCampaignItem[]>(buildApiUrl('/donations/campaigns?limit=12'), { method: 'GET', cache: 'no-store' });
      setCampaignList(campaignResponse.data);
    } catch (error) {
      const apiError = error as ApiErrorResponse;
      setErrorMessage(apiError.message || 'Không thể tải danh sách chiến dịch.');
    } finally {
      setIsLoadingCampaignList(false);
    }
  };

  useEffect(() => {
    void loadCampaignList();
  }, []);

  /** Hàm mở modal donate. Mục đích: chỉ mở modal khi campaign còn nhận quyên góp và luôn trả phản hồi ngay sau click. */
  const openDonationModal = (campaignItem: DonationCampaignItem) => {
    if (!isCampaignEligibleForDonation(campaignItem)) {
      const ineligibleReason = getCampaignIneligibleReason(campaignItem);
      setSelectedCampaign(null);
      setInteractionMessage(`Không thể quyên góp cho "${campaignItem.name}": ${ineligibleReason}`);
      // Ghi chú logic phức tạp: tăng version để UI phản hồi lại cả khi message không đổi giữa các lần click liên tiếp.
      setInteractionNoticeVersion(previousVersion => previousVersion + 1);
      return;
    }

    setInteractionMessage(`Đang mở form quyên góp cho "${campaignItem.name}"...`);
    setInteractionNoticeVersion(previousVersion => previousVersion + 1);
    setSelectedCampaign(campaignItem);
  };

  /** Hàm xử lý sau donate thành công. Mục đích: refresh campaign list tại chỗ, không reload toàn trang. */
  const handleDonationSuccess = async () => {
    await loadCampaignList();
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-bold text-[#0d1117]">Chiến dịch quyên góp công khai</h1>
      {isLoadingCampaignList && <div className="mt-5 rounded-lg border border-[#e5e7eb] p-4">Đang tải chiến dịch...</div>}
      {!isLoadingCampaignList && errorMessage && <div className="mt-5 rounded-lg border border-[#fecaca] bg-[#fff1f2] p-4 text-[#b91c1c]">{errorMessage}</div>}
      {!isLoadingCampaignList && !errorMessage && interactionMessage && (
        <div key={interactionNoticeVersion} className="mt-5 rounded-lg border border-[#fde68a] bg-[#fffbeb] p-4 text-[#92400e]">
          {interactionMessage}
        </div>
      )}
      {!isLoadingCampaignList && !errorMessage && campaignList.length === 0 && <div className="mt-5 rounded-lg border border-[#e5e7eb] p-4">Hiện chưa có chiến dịch công khai.</div>}

      <section className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {campaignList.map(campaignItem => {
          const donationPercent = campaignItem.goalAmount > 0 ? Math.min(100, Math.floor((campaignItem.donatedAmount / campaignItem.goalAmount) * 100)) : 0;
          const isEligibleForDonation = isCampaignEligibleForDonation(campaignItem);

          return (
            <article key={campaignItem.projectId} className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <h2 className="text-base font-semibold text-[#111827]">{campaignItem.name}</h2>
              <p className="mt-2 line-clamp-3 text-sm text-[#4b5563]">{campaignItem.description}</p>
              <div className="mt-2 text-xs text-[#6b7280]">Trạng thái: {campaignItem.status}</div>
              <div className="mt-3 text-sm text-[#374151]">{formatCurrency(campaignItem.donatedAmount)} / {formatCurrency(campaignItem.goalAmount)} token ({donationPercent}%)</div>
              <button
                type="button"
                onClick={() => openDonationModal(campaignItem)}
                className={`mt-4 inline-flex rounded-md px-3 py-2 text-sm font-semibold text-white ${isEligibleForDonation ? 'bg-[#0e7c6b]' : 'bg-[#9ca3af]'}`}
              >
                Quyên góp ngay
              </button>
              {!isEligibleForDonation && <p className="mt-2 text-xs text-[#92400e]">{getCampaignIneligibleReason(campaignItem)}</p>}
            </article>
          );
        })}
      </section>

      {selectedCampaign && (
        <DonationModal campaignItem={selectedCampaign} onClose={() => setSelectedCampaign(null)} onDonationSuccess={handleDonationSuccess} />
      )}
    </main>
  );
}
