-- Fase 5: auth publica eventos de dominio (user.registered) con el mismo
-- patrón outbox que el resto de los servicios.
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
