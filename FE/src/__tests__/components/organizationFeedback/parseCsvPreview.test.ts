import { describe, expect, it } from 'vitest';
import { hasCsvPreviewErrors, parseCsvPreview } from '@/app/components/organizationFeedback/parseCsvPreview';

describe('parseCsvPreview', () => {
  it('xử lý BOM, dấu phẩy trong nháy kép, nháy kép lồng và xuống dòng trong ô', () => {
    const csv = '\uFEFFprojectId,beneficiaryName,rating,comment,submittedAt\r\n'
      + 'DA-1,"Nguyen, Van",5,"Dòng một\nDòng ""hai""",2026-08-01T00:00:00Z\r\n';

    const result = parseCsvPreview(csv);

    expect(result.fileErrors).toEqual([]);
    expect(result.rows[0].values.beneficiaryName).toBe('Nguyen, Van');
    expect(result.rows[0].values.comment).toBe('Dòng một\nDòng "hai"');
    expect(hasCsvPreviewErrors(result)).toBe(false);
  });

  it('đánh dấu thiếu cột, rating sai, rating ngoài khoảng, ngày sai và comment quá dài', () => {
    const longComment = 'a'.repeat(5001);
    const csv = [
      'projectId,beneficiaryName,rating,comment,submittedAt,location',
      `,Nguyen A,abc,${longComment},01/08/2026,Quảng Bình`,
      'DA-2,Nguyen B,99,Ổn,2026-08-01,Huế'
    ].join('\n');

    const result = parseCsvPreview(csv);

    expect(result.rows[0].fieldErrors.projectId).toContain('projectId là bắt buộc.');
    expect(result.rows[0].fieldErrors.rating).toContain('rating phải là số nguyên.');
    expect(result.rows[0].fieldErrors.comment).toContain('comment vượt quá giới hạn 5000 ký tự.');
    expect(result.rows[0].fieldErrors.submittedAt?.[0]).toContain('2026-08-01T00:00:00Z');
    expect(result.rows[1].fieldErrors.rating).toContain('Rating phải từ 1 đến 5.');
    expect(hasCsvPreviewErrors(result)).toBe(true);
  });

  it('cảnh báo cột thừa nhưng không khóa upload và chỉ coi tối đa 50 dòng là preview ở component layer', () => {
    const rows = Array.from({ length: 51 }, (_, index) => `DA-${index},Name,5,Good,2026-08-01T00:00:00Z,Extra`).join('\n');
    const result = parseCsvPreview(`projectId,beneficiaryName,rating,comment,submittedAt\n${rows}`);

    expect(result.rows[0].rowWarnings).toContain('Dòng thừa 1 cột; các cột này sẽ được bỏ qua khi tải lên.');
    expect(result.rows[0].rowErrors).toEqual([]);
    expect(hasCsvPreviewErrors(result)).toBe(false);
    expect(result.totalRows).toBe(51);
  });

  it('mở quote sau khoảng trắng đầu ô giống parser phía server', () => {
    const result = parseCsvPreview([
      'projectId,beneficiaryName,rating,comment,submittedAt',
      'DA-1,  "Nguyen, Van",5,Good,2026-08-01T00:00:00Z'
    ].join('\n'));

    expect(result.fileErrors).toEqual([]);
    expect(result.rows[0].values.beneficiaryName).toBe('Nguyen, Van');
    expect(hasCsvPreviewErrors(result)).toBe(false);
  });

  it('chặn header trùng, header rỗng và file chỉ có header', () => {
    const result = parseCsvPreview('projectId,projectId,beneficiaryName,rating,comment,submittedAt,\n');

    expect(result.fileErrors).toEqual(expect.arrayContaining([
      'Cột bị lặp: projectId.',
      'Tên cột không được để trống.',
      'File CSV không có dòng dữ liệu.'
    ]));
    expect(hasCsvPreviewErrors(result)).toBe(true);
  });

  it('chấp nhận location tùy chọn và boundary rating 1/5', () => {
    const result = parseCsvPreview([
      'projectId,beneficiaryName,rating,comment,submittedAt',
      'DA-1,Name A,1,Low,2026-08-01T00:00:00Z',
      'DA-2,Name B,5,High,2026-08-01T00:00:00.123Z'
    ].join('\n'));

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every(row => Object.keys(row.fieldErrors).length === 0)).toBe(true);
    expect(hasCsvPreviewErrors(result)).toBe(false);
  });

  it('hiển thị lỗi parse khi dấu nháy kép không đóng', () => {
    const result = parseCsvPreview('projectId,beneficiaryName,rating,comment,submittedAt\nDA-1,Name,5,"broken,2026-08-01T00:00:00Z');

    expect(result.fileErrors).toEqual(['CSV có dấu nháy kép chưa được đóng.']);
    expect(result.rows).toEqual([]);
  });
});
