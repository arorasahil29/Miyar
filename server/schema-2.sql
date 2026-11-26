-- Miyar server schema, version 2: playgrounds.
-- "mine" items are visible only to their owner; "shared" items to everyone in the organisation.
CREATE TABLE IF NOT EXISTS playground_items (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder       text NOT NULL CHECK (folder IN ('mine', 'shared')),
  name         text NOT NULL,
  pages        integer NOT NULL DEFAULT 0,
  rows         integer NOT NULL DEFAULT 0,
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playground_org_folder ON playground_items (org_id, folder, updated_at DESC);
CREATE INDEX IF NOT EXISTS playground_owner ON playground_items (owner_id);
