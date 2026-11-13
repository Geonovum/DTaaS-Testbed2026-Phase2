-- CKAN needs pg_trgm for its trigram-based search/filtering features.
-- Runs automatically via Postgres's docker-entrypoint-initdb.d convention,
-- but only against a genuinely empty data volume (see DECISIONS.md, D14
-- and docker-compose.yml's ckan-db service).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- A second database for CKAN's "datastore" plugin. This project never
-- calls datastore's own API (records-wrapper only ever uses package_*
-- actions) — the plan was to omit datastore entirely — but CKAN 2.11
-- eagerly initializes every plugin named in its *declared* config schema
-- (image_view/text_view/datatables_view/datastore) during its very first
-- bootstrap pass, before any env-var plugin-list override takes effect, so
-- datastore's own configure() step runs regardless and needs a real,
-- reachable database or CKAN never finishes loading. Simplest fix: give it
-- one. Same "ckan" role for both read/write — the read/write role split
-- real CKAN deployments use is a security separation this no-auth sandbox
-- doesn't need (see the project's open-CORS decision for the same
-- posture, DECISIONS.md D11). See DECISIONS.md, D14.
CREATE DATABASE datastore_default OWNER ckan;

-- CKAN refuses to start if datastore's write and read-only connection URLs
-- are literally identical, so a second, distinct role is required even
-- though this sandbox has no real read/write separation need. `ckan
-- datastore set-permissions` (run automatically by ckan-base's own
-- prerun.py against CKAN_DATASTORE_WRITE_URL/READ_URL) grants this role the
-- actual read-only permissions at container startup — this just needs to
-- exist as a distinct, connectable role.
CREATE USER datastore_ro WITH PASSWORD 'ckanpass';

\connect datastore_default
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT CONNECT ON DATABASE datastore_default TO datastore_ro;
