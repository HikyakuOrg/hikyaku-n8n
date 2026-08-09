# n8n-nodes-hikyaku

n8n community node package for [Hikyaku](https://hikyaku.org). MVP scope: one polling trigger,
**Delivery Status Trigger**, which starts a workflow whenever a package's delivery status
changes — built so any tenant can install it into their own, independently-run n8n instance.

## How it works

Status changes are recorded as `INSERT`s into `package_timeline` (see `insert_package_timeline()`
in the Hikyaku schema) — there's no `current_status` column to watch directly.
[`HikyakuDeliveryStatusTrigger.node.ts`](nodes/HikyakuDeliveryStatusTrigger/HikyakuDeliveryStatusTrigger.node.ts)
polls `package_timeline` on an interval (n8n's standard "Poll Times" node setting), tracking the
highest `id` seen so far in the workflow's own static data. Each poll fetches only the rows newer
than that cursor and, for each one, looks up the matching row from `packages_with_latest_status`
to emit — so a workflow that was paused catches up on everything it missed the next time it polls,
rather than losing those events the way a live subscription would.

n8n community nodes running on n8n Cloud may only import from a small allowlisted set of modules
at runtime (`n8n-workflow`, `lodash`, `moment`, `p-limit`, `luxon`, `zod`, `crypto`) — this rules
out WebSocket client libraries, so polling REST reads (via n8n's own HTTP-with-credentials helper)
is the Cloud-compatible way to build this trigger.

**Tenant isolation is not done in node code.** The node authenticates via
[Supabase's OAuth 2.1 Server](https://supabase.com/docs/guides/auth/oauth-server) (PKCE, no client
secret) — each tenant clicks "Connect" in their own n8n and logs into their own Hikyaku account.
The resulting session is an ordinary Supabase JWT, used to authenticate every REST call this node
makes, so the existing `is_org_member()` RLS policies scope every request to that tenant's
organisation the same way they already scope the frontend. That's what makes independent,
per-tenant installs work without a bespoke API-key system.

## Prerequisites (Hikyaku-side, one-time)

1. **Register an OAuth client app** in the Supabase dashboard: Authentication → OAuth Apps → Add a
   new client. Use **Public** client type (there's no secret — PKCE replaces it). You'll get a
   Client ID; there is no Client Secret to store.
2. **Confirm RLS allows tenants to read their own rows** on `package_timeline` and
   `packages_with_latest_status` (or the tables it's built from) for org members — the OAuth token
   carries the same claims as a normal login, so whatever the frontend already relies on for
   `is_org_member()`-scoped reads should apply, but this hasn't been verified against the live
   schema in this session.
3. **OAuth Server is in beta** (public beta since Nov 2025, free on all plans) — treat this as
   subject to change, not a hard platform guarantee yet.

## Known limitation: redirect URIs are per-tenant, not wildcard

Supabase OAuth client redirect URIs require an **exact URL match** — no wildcards. n8n's OAuth2
credential callback is `https://<tenant's-n8n-host>/rest/oauth2-credential/callback`, which is
different for every tenant's independently-hosted instance. As registered today, **each new
tenant's callback URL needs to be added to the OAuth client's allowed redirect list by hand** in
the Supabase dashboard — this doesn't self-serve yet. (Supabase's dynamic client registration,
built for MCP clients, could remove this step later, but that's out of scope here.)

## Setup

Supabase Project URL, anon key, and OAuth Client ID are the same for every tenant, so the
*developer* deploying this node sets them once — tenants never see or enter them. Since n8n
community nodes can't read `process.env`/`.env` at runtime (see "How it works" above), these are
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

Install into a tenant's n8n instance (community nodes aren't published to npm yet, so use the
custom-extensions folder rather than the in-UI installer):

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

## Known limitations (MVP)

- Triggers on *any* status change — no per-status filtering yet.
- Delivery status changes are only noticed on the next poll, not the instant they happen — set
  the node's poll interval to match how time-sensitive the downstream workflow is.
- One extra REST request per changed package (`packages_with_latest_status` lookup) per event,
  plus one `package_timeline` request per poll regardless of whether anything changed.
- Redirect URI registration is manual per tenant (see above).
