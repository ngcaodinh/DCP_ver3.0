'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { fetchDonationCertificate } from '../../certificates/services';
import type { DonationCertificatePublicResponse } from '../../certificates/types';

const presentation = { VERIFIED: { label: 'Đã xác minh on-chain', tone: 'text-emerald-700 bg-emerald-50' }, PENDING: { label: 'Đang chờ blockchain finality', tone: 'text-amber-800 bg-amber-50' }, UNAVAILABLE: { label: 'Tạm thời chưa thể kiểm tra blockchain', tone: 'text-amber-800 bg-amber-50' }, REVOKED: { label: 'Chứng nhận đã bị thu hồi', tone: 'text-red-700 bg-red-50' } } as const;

/** Hiển thị certificate public, polling bounded theo trạng thái verification không ổn định. */
export default function DonationCertificateVerification({ certificateId }: { certificateId: string }): ReactElement {
  const [certificate, setCertificate] = useState<DonationCertificatePublicResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => { try { setCertificate(await fetchDonationCertificate(certificateId, signal)); setError(null); } catch (caught) { const status = (caught as { statusCode?: number }).statusCode; setError(status === 404 ? 'Không tìm thấy chứng nhận' : 'Không thể kiểm tra chứng nhận lúc này.'); } }, [certificateId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { if (!certificate || !['PENDING', 'UNAVAILABLE'].includes(certificate.verificationStatus)) return; const timer = window.setInterval(() => void load(), certificate.verificationStatus === 'PENDING' ? 2_000 : 5_000); return () => window.clearInterval(timer); }, [certificate, load]);
  if (error) return <main className="mx-auto max-w-2xl p-8"><h1 className="text-xl font-semibold">{error}</h1></main>;
  if (!certificate) return <main className="mx-auto max-w-2xl p-8">Đang kiểm tra chứng nhận…</main>;
  const status = presentation[certificate.verificationStatus];
  return <main className="mx-auto max-w-2xl space-y-5 p-8"><h1 className="text-2xl font-bold">Xác minh Chứng nhận Tri ân</h1><p className={`inline-block rounded px-3 py-2 font-medium ${status.tone}`}>{status.label}</p>{certificate.certificate && <section className="rounded border p-5"><p><strong>{certificate.certificate.donorName}</strong> đã đóng góp {BigInt(certificate.certificate.amountRaw).toLocaleString('vi-VN')} DCT cho “{certificate.certificate.projectName}”.</p><p className="mt-3 font-mono break-all">{certificate.certificate.donorAddress}</p></section>}{certificate.chain && <section className="rounded border p-5"><p className="font-mono break-all">{certificate.chain.transactionHash}</p><a className="mt-3 inline-block text-teal-700 underline" href={certificate.chain.explorerUrl} target="_blank" rel="noreferrer">Mở blockchain explorer</a></section>}{certificate.pdfUrl && <a className="inline-block rounded bg-teal-700 px-4 py-2 text-white" href={certificate.pdfUrl}>{certificate.verificationStatus === 'REVOKED' ? 'Tải bản đánh dấu đã thu hồi' : 'Tải PDF'}</a>}<button type="button" className="ml-3 underline" onClick={() => void load()}>Kiểm tra lại</button></main>;
}
