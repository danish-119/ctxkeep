import { Button } from '@/components/Button';
import { ProductCard } from './components/ProductCard';

export function App() {
  return (
    <main>
      <ProductCard title="Mug" price={12} />
      <Button label="Checkout" />
    </main>
  );
}
