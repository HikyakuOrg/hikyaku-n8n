# Hikyaku n8n example workflows

Ready-to-import n8n workflows using the [`n8n-nodes-hikyaku`](https://www.npmjs.com/package/n8n-nodes-hikyaku) community node package. See the [n8n Integration guide](https://docs.hikyaku.org/plugins/n8n) for install and credential setup first.

## Import a workflow

1. Download the `.json` file you want.
2. In n8n, go to **Workflows → Add workflow → Import from File** (or drag the file onto the canvas).
3. Open each Hikyaku node and select/create your **Hikyaku OAuth2 API** credential — the ones in these files are placeholders and won't resolve on your instance.
4. Do the same for any other credential the workflow uses (SMTP, Google Sheets, OpenAI, etc).
5. Each workflow has a sticky note on the canvas with the specific fields to fill in (e.g. which **Statuses** to select) before activating.

## What's here

| File | What it does |
|---|---|
| `notify-customer-on-delivery.json` | Delivery Status Trigger (`delivered`) → Get Customer → Get Package → email the recipient. |
| `log-status-changes-to-sheets.json` | Delivery Status Trigger (every status) → append a row to a Google Sheet for reporting/audit. |
| `escalate-failed-deliveries.json` | Delivery Status Trigger (your exception statuses) → enrich with both customers and the package → branch → alert dispatch by email. |
| `ai-tracking-assistant.json` | A chat-driven AI Agent with Get Package and Get Customer wired in as tools (`$fromAI()`-bound arguments), so the model decides when to look each one up. |

These are starting points, not finished automations — none of the third-party nodes (email, sheets, chat model) have real credentials or targets configured, and none of the workflows are active on import.
