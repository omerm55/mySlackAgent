-- Per-user Atlassian OAuth tokens. One row per Slack user, written on Connect and on every refresh,
-- deleted by Disconnect (and by an admin when someone leaves — §12.5).
--
-- access_token / refresh_token are CIPHERTEXT since Sept 2026: AES-256-GCM, 'enc:v1:<iv>:<tag>:<data>'
-- (src/utils/tokenCrypto.js). The database never sees TOKEN_ENCRYPTION_KEY, and rows written under a
-- previous key are rewritten on the next start (TOKEN_ENCRYPTION_KEY_PREVIOUS).
--
-- This table predates the SQL files in this directory — it was created by hand in the Supabase editor
-- and the definition lived only in §6.1 of the specification. Written down here in Sept 2026 so a new
-- environment can be provisioned from the repository (§12.7); it is the same DDL as §6.1.

create table if not exists public.oauth_tokens (
  slack_user_id  text primary key,
  access_token   text not null,   -- ciphertext: enc:v1:<iv>:<tag>:<data>
  refresh_token  text not null,   -- same
  expires_at     timestamptz not null,
  cloud_id       text not null,   -- Atlassian site id the token is scoped to
  updated_at     timestamptz not null default now()
);
