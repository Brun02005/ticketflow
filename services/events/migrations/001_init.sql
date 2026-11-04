CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Id del usuario en auth-service. No hay FK: cada servicio es dueño de su base.
  organizer_id  uuid NOT NULL,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  venue_name    text NOT NULL,
  city          text NOT NULL,
  starts_at     timestamptz NOT NULL,
  currency      text NOT NULL DEFAULT 'ARS' CHECK (currency IN ('ARS', 'USD')),
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'cancelled')),
  -- Bloqueo optimista: cada UPDATE incrementa la versión y exige la versión leída.
  version       integer NOT NULL DEFAULT 1,
  published_at  timestamptz,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Listado público: filtra por estado y ordena por (starts_at, id) para la paginación por cursor.
CREATE INDEX events_public_listing_idx ON events (starts_at, id) WHERE status = 'published';
CREATE INDEX events_organizer_idx ON events (organizer_id, created_at DESC);
-- Búsqueda por texto parcial (ILIKE '%rock%') usando trigramas.
CREATE INDEX events_title_trgm_idx ON events USING gin (title gin_trgm_ops);

-- Un sector es una grilla de asientos numerados (filas x asientos por fila) con un precio.
CREATE TABLE sections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name           text NOT NULL,
  price_cents    integer NOT NULL CHECK (price_cents >= 0),
  rows           integer NOT NULL CHECK (rows BETWEEN 1 AND 100),
  seats_per_row  integer NOT NULL CHECK (seats_per_row BETWEEN 1 AND 200),
  position       integer NOT NULL,
  UNIQUE (event_id, name)
);

CREATE INDEX sections_event_idx ON sections (event_id, position);

-- Transactional outbox: eventos de dominio pendientes de publicar en RabbitMQ.
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
