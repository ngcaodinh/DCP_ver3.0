import { Fragment } from 'react';

interface StarRatingProps {
  name?: string;
}

/** Hiển thị nhóm radio số điểm bằng HTML và CSS để vẫn hoạt động khi JavaScript bị tắt. */
export default function StarRating({ name = 'rating' }: StarRatingProps): React.ReactElement {
  const ratingValues = [1, 2, 3, 4, 5];

  return (
    <fieldset>
      <legend className="block text-sm font-semibold text-slate-800">
        Mức độ hài lòng
        <span className="mt-1 block text-xs font-normal text-slate-500">Chọn từ 1 đến 5</span>
      </legend>
      <div className="mt-3 grid grid-cols-5 gap-2" aria-label="Chọn mức độ hài lòng">
        {ratingValues.map((ratingValue) => (
          <Fragment key={ratingValue}>
            <input
              id={`${name}-${ratingValue}`}
              className="peer sr-only"
              type="radio"
              name={name}
              value={ratingValue}
              aria-label={`${ratingValue} sao`}
              required
            />
            <label
              htmlFor={`${name}-${ratingValue}`}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-slate-300 px-2 text-sm font-semibold text-slate-700 transition-colors duration-200 hover:border-emerald-500 hover:bg-emerald-50 peer-checked:border-emerald-700 peer-checked:bg-emerald-50 peer-checked:text-emerald-800 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-emerald-600"
            >
              {ratingValue} sao
            </label>
          </Fragment>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">1 là chưa hài lòng · 5 là rất hài lòng</p>
    </fieldset>
  );
}
