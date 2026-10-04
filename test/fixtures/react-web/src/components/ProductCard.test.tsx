import { ProductCard } from './ProductCard';

test('renders', () => {
  expect(ProductCard({ title: 'x', price: 1 })).toBeTruthy();
});
