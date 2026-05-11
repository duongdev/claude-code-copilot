---
description: Show GitHub Copilot quota and usage (premium requests, plan, reset date)
allowed-tools: Bash
---

Show the user their current GitHub Copilot usage and quota.

1. Determine the proxy base URL (default `http://localhost:18080` unless the user has set `ANTHROPIC_BASE_URL` to point at the Copilot proxy).

2. Fetch the usage endpoint. If the user has set `COPILOT_PROXY_API_KEY`, include it as `x-api-key`:
   ```bash
   curl -s "${ANTHROPIC_BASE_URL:-http://localhost:18080}/v1/copilot/usage" \
     ${COPILOT_PROXY_API_KEY:+-H "x-api-key: $COPILOT_PROXY_API_KEY"}
   ```

3. Parse the JSON response and present a concise summary. The most useful fields:
   - `summary` — one-line human-readable summary (use this as the headline)
   - `copilot_plan` — `free` / `individual` / `business` / `enterprise`
   - `quota_snapshots.premium_interactions` — `entitlement` (monthly limit), `remaining`, `percent_remaining`, `overage_permitted`. Negative `remaining` means they've gone over and are accruing overage charges (only billed if `overage_permitted` is true).
   - `quota_snapshots.chat` / `completions` — usually `unlimited: true` on paid plans
   - `quota_reset_date` — when premium counter rolls over (YYYY-MM-DD)
   - `organization_list` — which orgs are paying for the seat (if any)

4. Format example (when over quota):
   ```
   GitHub Copilot · business plan
   Premium requests: 1200 / 300 (overage: 400% · billable)
   Chat / completions: unlimited
   Resets: 2026-01-01
   Org: your-org
   ```

   When over quota, show overage count as numerator and entitlement as denominator — the "X%" is `(overage / entitlement) × 100`. Append `· billable` when `overage_permitted` is true, `· blocked` when false. When under quota, just show `{used} / {entitlement}` with no overage suffix.

5. If the proxy returns 502 or the request fails, the proxy is likely not running or the OAuth token expired. Suggest:
   - Check the proxy is up: `curl http://localhost:18080/health`
   - Re-authenticate: `node scripts/auth.mjs`

Be concise — usually the user just wants the summary line plus the reset date.
