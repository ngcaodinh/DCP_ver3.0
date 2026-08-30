import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetchApi } = vi.hoisted(() => ({ mockFetchApi: vi.fn() }));

vi.mock('@/app/utils/apiClient', () => ({
  buildApiUrl: (path: string) => path,
  fetchApi: mockFetchApi,
  getApiErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));

vi.mock('@/app/utils/authSession', () => ({
  readAuthSession: () => ({ accessToken: 'admin-token' }),
}));

import CommitteeSeatsPanel from '@/app/components/systemAdmin/tailwind/CommitteeSeatsPanel';

const chairWalletAddress = '0x1111111111111111111111111111111111111111';

describe('CommitteeSeatsPanel quyền Admin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chỉ hiển thị trạng thái và danh sách khi roster đã bootstrap', async () => {
    mockFetchApi.mockImplementation((url: string) => Promise.resolve({
      data: url.includes('/bootstrap/state')
        ? { transactionHash: '0xbootstrapped' }
        : [{ userId: 'chair-1', displayName: 'Chair', role: 'executive_chair', walletAddress: chairWalletAddress, accountStatus: 'ACTIVE', lastLoginAt: '2026-08-28T00:00:00.000Z' }],
    }));

    render(<CommitteeSeatsPanel />);

    expect(await screen.findByRole('heading', { name: 'Danh sách ghế đã khóa trên chuỗi' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thu ghế' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tạo draft thay ghế/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nạp 5 ghế lên blockchain/i })).not.toBeInTheDocument();
  });

  it('yêu cầu xác nhận địa chỉ đầy đủ trước khi Admin cấp ghế trong giai đoạn bootstrap', async () => {
    mockFetchApi.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/bootstrap/state') ? null : [] }));
    render(<CommitteeSeatsPanel />);

    await screen.findByRole('heading', { name: 'Cấp ghế mới' });
    fireEvent.change(screen.getByLabelText('Tên hiển thị'), { target: { value: 'Ủy viên A' } });
    fireEvent.change(screen.getByLabelText('Địa chỉ ví đầy đủ'), { target: { value: chairWalletAddress } });
    fireEvent.click(screen.getByRole('button', { name: 'Xem lại địa chỉ đầy đủ' }));

    expect(await screen.findByText(chairWalletAddress)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đúng, cấp ghế' })).toBeEnabled();
  });

  it('vẫn hiển thị form cấp ghế khi chưa đọc được proof bootstrap từ server', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/bootstrap/state')) return Promise.reject(new Error('Không kết nối được server'));
      return Promise.resolve({ data: [] });
    });
    render(<CommitteeSeatsPanel />);

    expect(await screen.findByRole('heading', { name: 'Cấp ghế mới' })).toBeInTheDocument();
    expect(screen.getByText(/Không thể xác minh proof bootstrap từ server/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Danh sách ghế đã khóa trên chuỗi' })).not.toBeInTheDocument();
  });

  it('gửi dữ liệu đã review đến API tạo ghế và tải lại danh sách', async () => {
    mockFetchApi.mockImplementation((url: string) => {
      if (url.includes('/bootstrap/state')) return Promise.resolve({ data: null });
      if (url === '/api/governance/seats') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });
    render(<CommitteeSeatsPanel />);

    await screen.findByRole('heading', { name: 'Cấp ghế mới' });
    fireEvent.change(screen.getByLabelText('Tên hiển thị'), { target: { value: 'Ủy viên A' } });
    fireEvent.change(screen.getByLabelText('Địa chỉ ví đầy đủ'), { target: { value: chairWalletAddress } });
    fireEvent.click(screen.getByRole('button', { name: 'Xem lại địa chỉ đầy đủ' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Đúng, cấp ghế' }));

    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledWith('/api/governance/seats', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ walletAddress: chairWalletAddress, displayName: 'Ủy viên A', role: 'executive_member' }),
    })));
  });
});
