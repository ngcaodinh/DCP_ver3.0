'use client';

import { type FormEvent, type ReactElement, useEffect, useRef, useState } from 'react';
import { buildApiUrl, fetchApi } from '@/app/utils/apiClient';
import { readAuthSession } from '@/app/utils/authSession';
import { EvidenceCameraCapture } from '../common/evidenceCamera/EvidenceCameraCapture';
import type { CapturedEvidencePhoto } from '../common/evidenceCamera/types';

type ActiveProject = { projectId: string; name: string; milestonePlan: Array<{ milestoneIndex: number; milestoneKey: string; description: string }>; fieldReport?: { reportId: string } | null };

/** Nộp biên bản hiện trường từ evidence camera và khóa project sau lần nộp đầu tiên. */
export default function AuditorFieldReportForm({ projects, onSubmitted }: { projects: ActiveProject[]; onSubmitted: () => Promise<void> }): ReactElement {
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const [indexes, setIndexes] = useState<number[]>([]);
  const [photos, setPhotos] = useState<CapturedEvidencePhoto[]>([]);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const photosRef = useRef(photos);
  const project = projects.find(item => item.projectId === projectId);
  const eligibleProjects = projects.filter(item => !item.fieldReport && item.milestonePlan.length);
  const ineligibleProjects = projects.filter(item => item.fieldReport || !item.milestonePlan.length);
  const isSuccessMessage = message.startsWith('Đã ');

  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => () => photosRef.current.forEach(photo => URL.revokeObjectURL(photo.previewObjectUrl)), []);

  /** Giải phóng preview sau khi gửi thành công hoặc đổi dự án. */
  function clearPhotos(): void {
    photos.forEach(photo => URL.revokeObjectURL(photo.previewObjectUrl));
    setPhotos([]);
  }

  /** Gửi payload camera đúng hợp đồng API và refresh danh sách đã khóa. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = readAuthSession().accessToken;
    if (!token || !project || note.trim().length < 20 || !indexes.length || !photos.length) {
      setMessage('Chọn dự án, ít nhất một mốc, một ảnh camera và ghi chú từ 20 ký tự.');
      return;
    }
    setIsSubmitting(true);
    try {
      await fetchApi(buildApiUrl('/api/project-governance/auditor/field-report'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          projectId,
          note: note.trim(),
          verifiedMilestoneIndexes: indexes,
          clientSubmittedAt: new Date().toISOString(),
          photos: photos.map(({ localId, previewObjectUrl, ...photo }) => photo)
        })
      });
      setMessage('Đã nộp biên bản; dự án được khóa không thể nộp đè.');
      setProjectId('');
      setNote('');
      setIndexes([]);
      clearPhotos();
      await onSubmitted();
    } catch (error) {
      setMessage((error as { message?: string }).message || 'Không thể nộp biên bản.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return <form onSubmit={event => void submit(event)} className="mt-5 overflow-hidden rounded-2xl border border-emerald-100 bg-white shadow-[0_12px_28px_rgba(14,124,107,0.07)]">
    <div className="border-b border-emerald-100 bg-emerald-50/70 px-5 py-4 sm:px-6">
      <h3 className="text-lg font-bold text-slate-900">Nộp biên bản kiểm tra thực địa</h3>
      <p className="mt-1 text-sm leading-6 text-slate-600">Chọn dự án, các mốc đã kiểm tra và chụp ảnh minh chứng trực tiếp tại hiện trường.</p>
    </div>

    <div className="space-y-5 p-5 sm:p-6">
      {!eligibleProjects.length ? (
        <div className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/60 px-4 py-8 text-center">
          <p className="font-bold text-slate-800">Chưa có dự án đủ điều kiện lập biên bản</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">Dự án cần có kế hoạch cột mốc để Auditor có thể đối chiếu và chưa có biên bản trước đó.</p>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="auditor-field-report-project" className="mb-2 block text-sm font-bold text-slate-800">Dự án cần kiểm tra</label>
            <select id="auditor-field-report-project" className="min-h-11 w-full cursor-pointer rounded-xl border border-emerald-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100" value={projectId} onChange={event => { setProjectId(event.target.value); setIndexes([]); clearPhotos(); }} required>
              <option value="">Chọn dự án chưa có biên bản</option>
              {eligibleProjects.map(item => <option key={item.projectId} value={item.projectId}>{item.name}</option>)}
            </select>
          </div>

          {project && <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <legend className="px-1 text-sm font-bold text-slate-800">Mốc công việc đã kiểm tra</legend>
            <div className="mt-2 space-y-2">
              {project.milestonePlan.map(item => <label key={item.milestoneIndex} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-sm leading-6 text-slate-700 transition hover:bg-white"><input type="checkbox" checked={indexes.includes(item.milestoneIndex)} onChange={() => setIndexes(current => current.includes(item.milestoneIndex) ? current.filter(index => index !== item.milestoneIndex) : [...current, item.milestoneIndex])} className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-500" /> <span><span className="font-mono text-xs font-bold text-emerald-800">{item.milestoneKey}</span>: {item.description}</span></label>)}
            </div>
          </fieldset>}

          <div>
            <label htmlFor="auditor-field-report-note" className="mb-2 block text-sm font-bold text-slate-800">Ghi chú hiện trường</label>
            <textarea id="auditor-field-report-note" rows={5} className="w-full resize-y rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-600 focus:ring-4 focus:ring-emerald-100" minLength={20} value={note} onChange={event => setNote(event.target.value)} placeholder="Mô tả các quan sát thực tế (tối thiểu 20 ký tự)" required />
          </div>

          {project && <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3 sm:p-4"><EvidenceCameraCapture maxPhotos={5} photos={photos} onChange={setPhotos} moduleLabel="biên bản hiện trường" disabled={isSubmitting} /></div>}

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-slate-500">Biên bản đã nộp sẽ khóa dự án và không thể thay thế.</p>
            <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting} className="min-h-11 shrink-0 rounded-xl bg-[#0e7c6b] px-4 text-sm font-bold text-white shadow-sm transition hover:bg-[#0a5c50] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60">{isSubmitting ? 'Đang nộp…' : 'Nộp biên bản một lần'}</button>
          </div>
        </>
      )}

      {ineligibleProjects.length > 0 && <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-4" aria-labelledby="auditor-ineligible-projects-heading">
        <div>
          <h4 id="auditor-ineligible-projects-heading" className="text-sm font-bold text-amber-950">Dự án ACTIVE chưa thể lập biên bản</h4>
          <p className="mt-1 text-xs leading-5 text-amber-900">Các dự án này vẫn được hiển thị để Auditor biết trạng thái dữ liệu, nhưng không thể nộp biên bản khi thiếu mốc đối chiếu hoặc đã có biên bản.</p>
        </div>
        <div className="mt-3 space-y-2">
          {ineligibleProjects.map(item => <div key={item.projectId} className="rounded-lg border border-amber-100 bg-white/80 px-3 py-3 sm:flex sm:items-center sm:justify-between sm:gap-4">
            <p className="text-sm font-bold text-slate-800">{item.name}</p>
            <p className="mt-1 text-xs leading-5 text-amber-900 sm:mt-0 sm:text-right">{item.fieldReport ? 'Đã có biên bản hiện trường; không thể nộp đè.' : 'Chưa có kế hoạch cột mốc để đối chiếu.'}</p>
          </div>)}
        </div>
      </section>}

      {message && <p role={isSuccessMessage ? 'status' : 'alert'} aria-live={isSuccessMessage ? 'polite' : 'assertive'} className={`rounded-xl border px-4 py-3 text-sm leading-6 ${isSuccessMessage ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message}</p>}
    </div>
  </form>;
}
