-- Un pago por orden. Se crea al consumir order.created: el monto sale del
-- evento de orders, nunca de lo que mande el cliente.
CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL UNIQUE,
  user_id              uuid NOT NULL,
  event_id             uuid NOT NULL,
  amount_cents         integer NOT NULL CHECK (amount_cents >= 0),
  currency             text NOT NULL,
  status               text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
                         'awaiting_payment', -- esperando que el cliente pague
                         'processing',       -- hay un cobro en curso en la pasarela
                         'succeeded',        -- cobrado
                         'refund_pending',   -- hay que devolver el dinero
                         'refunded',         -- devuelto
                         'voided'            -- la orden venció o se canceló antes de pagar
                       )),
  expires_at           timestamptz NOT NULL,
  psp_charge_id        text,
  refund_requested_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_refund_pending_idx ON payments (refund_requested_at NULLS FIRST)
  WHERE status = 'refund_pending';

-- Cada intento de cobro. Su id es la "reference" que viaja a la pasarela y la
-- Idempotency-Key del pedido: reintentar la llamada nunca cobra dos veces.
CREATE TABLE charges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES payments (id),
  psp_charge_id   text UNIQUE,
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  card_last4      text NOT NULL,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Barrera en la base contra el doble cobro: nunca dos cobros en curso para el mismo pago.
CREATE UNIQUE INDEX charges_one_in_flight_idx ON charges (payment_id) WHERE status = 'processing';
CREATE INDEX charges_processing_idx ON charges (created_at) WHERE status = 'processing';

-- Webhooks ya procesados: la pasarela puede mandar el mismo más de una vez.
CREATE TABLE webhook_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processed_messages (
  message_id    uuid PRIMARY KEY,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id    uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  aggregate_id  text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text
);

CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL;
