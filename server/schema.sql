-- Miyar server schema, version 1.
-- Every table carries org_id, so one installation can later host several organisations.
CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY,
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  issuer         text NOT NULL,
  subject        text NOT NULL,
  email          text,
  name           text,
  role           text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  UNIQUE (org_id, issuer, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash     text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  id_token    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS datasets (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name         text NOT NULL,
  columns      jsonb NOT NULL,
  row_count    integer NOT NULL DEFAULT 0,
  storage_key  text,
  source       jsonb,
  calcs        jsonb NOT NULL DEFAULT '[]',
  fmt          jsonb NOT NULL DEFAULT '{}',
  version      integer NOT NULL DEFAULT 1,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE IF NOT EXISTS reports (
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  id          text NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  name        text NOT NULL,
  content     jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      uuid,
  user_email   text,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  target_name  text,
  detail       jsonb,
  count        integer NOT NULL DEFAULT 1,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_at ON audit_log (org_id, at DESC);
