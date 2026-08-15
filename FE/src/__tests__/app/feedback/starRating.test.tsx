import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StarRating from '@/app/components/feedback/StarRating';

describe('StarRating', () => {
  it('renders accessible radios and keeps the selected value in native form state', () => {
    render(<StarRating />);

    const fourStarRadio = screen.getByRole('radio', { name: '4 sao' });
    fireEvent.click(fourStarRadio);

    expect(fourStarRadio).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getAllByText(/^[1-5] sao$/)).toHaveLength(5);
  });

  it('uses native radio inputs for no-JavaScript form submission', () => {
    const { container } = render(<StarRating />);
    const inputs = Array.from(container.querySelectorAll('input'));

    expect(inputs).toHaveLength(5);
    expect(inputs.every((input) => input.getAttribute('type') === 'radio')).toBe(true);
    expect(inputs.every((input) => input.getAttribute('name') === 'rating')).toBe(true);
    expect(inputs.map((input) => input.getAttribute('value'))).toEqual(['1', '2', '3', '4', '5']);
  });
});
