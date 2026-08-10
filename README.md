# n8n-nodes-hikyaku

n8n community node package for [Hikyaku](https://hikyaku.org). 

## Prerequisites (Hikyaku-side, one-time)

1. **Register an OAuth client app** in the Supabase dashboard: Authentication → OAuth Apps → Add a
   new client. Use **Public** client type. You will get a Client ID.
2. **OAuth Server is in beta** (public beta since Nov 2025, free on all plans) — treat this as
   subject to change, not a hard platform guarantee yet.

## Setup

Supabase Project URL, anon key, and OAuth Client ID are the same for every tenant, so the
*developer* deploying this node sets them once — tenants never see or enter them. Since n8n
community nodes can't read `process.env`/`.env` at runtime, these are
set as literal constants directly in the credential source. Edit the three constants at the top of
[`HikyakuOAuth2Api.credentials.ts`](credentials/HikyakuOAuth2Api.credentials.ts):

```ts
const HIKYAKU_SUPABASE_URL = ''; // e.g. https://xxxxxxxxxxxx.supabase.co
const HIKYAKU_SUPABASE_ANON_KEY = ''; // Supabase publishable/anon key — not secret
const HIKYAKU_OAUTH_CLIENT_ID = ''; // Public OAuth client ID from step 1 above
```

then build:

```bash
npm install
npm run build
```

Install into a tenant's n8n instance:

```bash
mkdir -p ~/.n8n/custom && cd ~/.n8n/custom && npm init -y
npm install /path/to/n8n-nodes-hikyaku --install-links
```

Note: because the config above is baked into `dist/` at build time rather than read from a
runtime `.env`, changing it means editing the constants and running `npm run build` again — there
is no separate per-install configuration step.

In n8n, all a tenant does is:
1. Add **Hikyaku OAuth2 API** credentials — every field is pre-filled, so the only visible action
   is the **Connect my account** button.
2. Click **Connect my account** to complete the OAuth consent flow, logging into their own
   Hikyaku account. 
   
## Requirements

- **Node.js 22 or newer** on the n8n host. The trigger uses the `WebSocket` client built into
  Node (stable from v22.5), so verified/Cloud installs don't need
  one but that means it also can't run on an older Node. On an unsupported Node version the
  node fails activation with a clear error rather than crashing.
- One Supabase Realtime concurrent connection per **active** workflow using this trigger (not
  per execution) — each activated workflow holds its own socket open. Supabase's free plan
  includes 200 concurrent realtime connections, Pro 500.

## Known limitations

- Triggers on *any* status change — no per-status filtering yet.
- If the connection drops (network blip, host restart, token issues), the node reconnects with
  backoff and replays anything it missed from its cursor once resubscribed — but a change that
  happens while every reconnect attempt is still failing (default: 5 attempts, capped at 30s
  apart) will only be caught once the connection recovers, not the instant it happens.