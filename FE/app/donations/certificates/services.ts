import { buildSameOriginApiUrl, fetchApi } from '../../utils/apiClient';
import type { DonationCertificatePublicResponse } from './types';

/** Lấy trạng thái certificate public với no-store để luôn phản ánh live verification. */
export async function fetchDonationCertificate(certificateId: string, signal?: AbortSignal): Promise<DonationCertificatePublicResponse> { const response = await fetchApi<DonationCertificatePublicResponse>(buildSameOriginApiUrl(`/api/donations/certificates/${encodeURIComponent(certificateId)}`), { method: 'GET', cache: 'no-store', signal }); return response.data; }

/** Tạo đường dẫn PDF same-origin để browser dùng Next rewrite và header bảo mật backend. */
export function buildDonationCertificatePdfUrl(certificateId: string): string { return buildSameOriginApiUrl(`/api/donations/certificates/${encodeURIComponent(certificateId)}/pdf`); }
