'use client';

import type { ReactElement } from 'react';
import type { CsvPreviewResult } from './types';

interface CsvPreviewTableProps {
  preview: CsvPreviewResult;
}

const PREVIEW_ROW_LIMIT = 50;

/** Hiển thị tối đa 50 dòng preview, phân biệt cảnh báo không chặn upload và lỗi chưa thể gửi. */
export function CsvPreviewTable({ preview }: CsvPreviewTableProps): ReactElement {
  const visibleRows = preview.rows.slice(0, PREVIEW_ROW_LIMIT);
  const hiddenRowCount = Math.max(0, preview.totalRows - visibleRows.length);

  return (
    <div className="space-y-3">
      {preview.fileErrors.map(error => (
        <p key={error} role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ))}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-[900px] w-full text-left text-xs">
          <caption className="sr-only">Bản xem trước file CSV feedback</caption>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th scope="col" className="px-3 py-2">Dòng</th>
              {preview.headers.map(header => <th scope="col" key={header} className="px-3 py-2">{header}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map(row => (
              <tr key={row.rowNumber} className="align-top">
                <td className="px-3 py-2 font-mono text-slate-500">{row.rowNumber}</td>
                {preview.headers.map(header => {
                  const errors = row.fieldErrors[header] ?? [];
                  return (
                    <td key={header} className={`max-w-[260px] whitespace-pre-wrap px-3 py-2 ${errors.length > 0 ? 'bg-red-50 text-red-700' : 'text-slate-700'}`}>
                      <span>{row.values[header] ?? ''}</span>
                      {errors.map(error => <span key={error} className="mt-1 block font-medium">{error}</span>)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visibleRows.some(row => row.rowErrors.length > 0 || row.rowWarnings.length > 0) && (
        <div className="space-y-1 text-xs">
          {visibleRows.flatMap(row => row.rowErrors.map(error => <p key={`${row.rowNumber}-${error}`} className="text-red-700">Dòng {row.rowNumber}: {error}</p>))}
          {visibleRows.flatMap(row => row.rowWarnings.map(warning => <p key={`${row.rowNumber}-${warning}`} className="text-amber-700">Dòng {row.rowNumber}: {warning}</p>))}
        </div>
      )}
      {hiddenRowCount > 0 && <p className="text-xs text-slate-500">Còn {hiddenRowCount} dòng nữa chưa hiển thị.</p>}
    </div>
  );
}
