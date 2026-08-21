-- ============================================================================
-- App Config Table — stores application-level settings (e.g. access PIN)
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

CREATE TABLE app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

COMMENT ON TABLE app_config IS 'Key-value store for application configuration (e.g. access PIN)';

-- Disable RLS to allow client reads (PIN is not a security secret — it is a
-- simple access gate, not a full auth system)
ALTER TABLE app_config DISABLE ROW LEVEL SECURITY;

-- Seed the access PIN
INSERT INTO app_config (key, value) VALUES ('access_pin', '404354');
