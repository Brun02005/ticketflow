-- ── Proyecciones ─────────────────────────────────────────────────
-- Copias locales de lo que necesitan los emails: el worker nunca llama
-- sincrónicamente a otro servicio para armar un mensaje.
CREATE TABLE users (
  id          uuid PRIMARY KEY,
  email       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id          uuid PRIMARY KEY,
  title       text NOT NULL,
  venue_name  text NOT NULL,
  city        text NOT NULL,
  starts_at   timestamptz NOT NULL
);

-- ── Notificaciones ───────────────────────────────────────────────
-- Cada email a enviar es una fila. Recibir el mensaje de RabbitMQ y enviar el
-- email quedan desacoplados: el consumidor solo registra la intención (rápido,
-- transaccional) y un despachador envía, con reintentos persistentes.
CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Qué hecho de negocio originó el email (ej.: "tickets:<orderId>"). Si el
  -- mismo hecho llega dos veces, por el canal que sea, se manda un solo email.
  dedupe_key       text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN (
                     'welcome', 'tickets', 'payment_failed', 'order_expired', 'event_cancelled', 'refund'
                   )),
  user_id          uuid NOT NULL,
  event_id         uuid,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- El despachador solo mira las pendientes, en orden de vencimiento.
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'pending';
CREATE INDEX notifications_status_idx ON notifications (status, created_at DESC);

CREATE TABLE processed_messages (
  message_id    uuid PRIMARY KEY,
  processed_at  timestamptz NOT NULL DEFAULT now()
);
