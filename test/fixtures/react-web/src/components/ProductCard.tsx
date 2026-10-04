import { formatPrice } from '@/lib/format-price';
import { Button } from './Button';

export function ProductCard({ title, price }: { title: string; price: number }) {
  return (
    <div>
      {title} {formatPrice(price)} <Button label="Add" />
    </div>
  );
}
