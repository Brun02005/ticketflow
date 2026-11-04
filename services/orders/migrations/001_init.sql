-- ── Proyección local del catálogo ─────────────────────────────────
-- Copia mínima de lo que publica events-service (vía RabbitMQ). orders no
-- consulta a events en cada compra: si events se cae, se puede seguir vendiendo.
CREATE TABLE events (
  id          uuid PRIMARY KEY,
  title       text,
  starts_at   timestamptz,
  currency    text,
  status      text NOT NULL CHECK (status IN ('published', 'cancelled')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sections (
  id           uuid PRIMARY KEY,
  event_id     uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name         text NOT NULL,
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  position     integer NOT NULL
);

-- ── Inventario ───────────────────────────────────────────────────
-- Una fila por asiento físico. Es la fuente de verdad contra la sobreventa.
CREATE TABLE seats (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  section_id  uuid NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  row         integer NOT NULL,
  number      integer NOT NULL,
  status      text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'sold')),
  order_id    uuid,
  held_until  timestamptz,
  UNIQUE (event_id, section_id, row, number),
  -- Invariantes que la base garantiza aunque el código tenga un bug:
  -- un asiento disponible no pertenece a ninguna orden; uno tomado, sí.
  CHECK ((status = 'available') = (order_id IS NULL)),
  CHECK ((status = 'held') = (held_until IS NOT NULL))
);

CREATE INDEX seats_event_section_idx ON seats (event_id, section_id, row, number);
CREATE INDEX seats_order_idx ON seats (order_id) WHERE order_id IS NOT NULL;

-- ── Órdenes ──────────────────────────────────────────────────────
CREATE TABLE orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  event_id     uuid NOT NULL REFERENCES events (id),
  status       text NOT NULL DEFAULT 'pending_payment'
               CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),
  total_cents  integer NOT NULL CHECK (total_cents >= 0),
  currency     text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
-- El job de expiración solo recorre órdenes pendientes, ordenadas por vencimiento.
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'pending_payment';

CREATE TABLE order_items (
  order_id     uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  seat_id      bigint NOT NULL REFERENCES seats (id),
  section_id   uuid NOT NULL,
  section_name text NOT NULL,
  row          integer NOT NULL,
  number       integer NOT NULL,
  price_cents  integer NOT NULL,
  PRIMARY KEY (order_id, seat_id)
);

-- ── Idempotencia de la API ───────────────────────────────────────
-- La clave es por usuario: dos usuarios distintos pueden usar la misma.
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ── Mensajería ───────────────────────────────────────────────────
-- Inbox: mensajes ya procesados, para descartar entregas duplicadas.
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
