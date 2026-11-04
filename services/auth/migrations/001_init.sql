CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'customer'
                 CHECK (role IN ('customer', 'organizer', 'admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Unicidad case-insensitive: "Ana@Mail.com" y "ana@mail.com" son la misma cuenta.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- Refresh tokens con rotación: cada uso emite uno nuevo y revoca el anterior.
-- Todos los tokens que nacen de un mismo login comparten family_id; si alguien
-- reutiliza un token ya rotado (señal de robo), se revoca la familia entera.
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid REFERENCES refresh_tokens (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
