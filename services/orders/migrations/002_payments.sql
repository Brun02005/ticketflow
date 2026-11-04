-- Fase 4: las órdenes se pagan. Migración aditiva (no rompe datos existentes).
ALTER TABLE orders
  ADD COLUMN paid_at     timestamptz,
  ADD COLUMN payment_id  uuid;

-- Una orden pagada siempre tiene fecha y pago asociado.
ALTER TABLE orders
  ADD CONSTRAINT orders_paid_consistency CHECK ((status = 'paid') <= (paid_at IS NOT NULL AND payment_id IS NOT NULL));
