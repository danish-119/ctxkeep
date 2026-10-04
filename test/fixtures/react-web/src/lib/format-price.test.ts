import { formatPrice } from './format-price';

test('formats', () => {
  expect(formatPrice(100)).toBe('$1.00');
});
