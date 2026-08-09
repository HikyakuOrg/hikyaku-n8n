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
   Hikyaku account. (If the OAuth Redirect URL hasn't been registered for this tenant yet, see
   the known limitation above — that's a one-time step for the developer, not the tenant.)
3. Add the **Hikyaku Delivery Status Trigger** node to a workflow and set a poll interval — no
   per-node tenant config needed, the authenticated session determines scope.

## Known limitations

- Triggers on *any* status change — no per-status filtering yet.
- Delivery status changes are only noticed on the next poll, not the instant they happen — set
  the node's poll interval to match how time-sensitive the downstream workflow is.