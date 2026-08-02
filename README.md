# OKShip Run Action

Official GitHub Action for OKShip — trigger evidence-generation runs from CI.

## Quick Start

```yaml
name: OKShip CI run
on: [push]
jobs:
  okship:
    runs-on: ubuntu-latest
    steps:
      - uses: okship-dev/run-action@v0.1.0
        with:
          api_key: ${{ secrets.OKSHIP_API_KEY }}
          app_id: <your-app-uuid>
          okship_api_base: https://your-okship-host.example.com
```

## What it does

The action posts to your OKShip deployment's `/api/runs` endpoint with the supplied app and (optional) scenarios, then polls `/api/runs/<id>/status` until the run reaches a terminal state (`complete`, `failed`, or `cancelled`). The verdict (`pass | fail | ambiguous`) is emitted as a workflow output for downstream steps.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api_key` | yes | — | OKShip API key. Generate one in your OKShip dashboard (typically under Settings → API Keys) and store in repo secrets. |
| `app_id` | yes | — | OKShip app UUID to run scenarios against. |
| `scenarios` | no | (all) | Comma-separated scenario UUIDs. Defaults to all scenarios on the app. |
| `wait_for_completion` | no | `true` | If `true`, poll until the run terminates and emit `verdict`. If `false`, return immediately after the run is enqueued. |
| `okship_api_base` | yes | — | OKShip API base URL for your deployment. Example: `https://your-okship-host.example.com`. |

## Outputs

| Name | When set | Description |
|---|---|---|
| `run_id` | After successful trigger | The OKShip run UUID. |
| `run_url` | After successful trigger | Direct link to the run in the OKShip dashboard. |
| `verdict` | When `wait_for_completion=true` AND run reaches a terminal state with `overall_result` computed | `pass`, `fail`, or `ambiguous`. |

## Behavior

- **Polling cadence:** 10s initial delay, exponential backoff up to 60s cap, 30-minute overall timeout.
- **Polling timeout:** If the run hasn't reached a terminal state within 30 minutes, the action exits successfully with `run_id` and `run_url` set and surfaces a warning. `verdict` is not set in this case. Long-running scenarios are a valid outcome — check the dashboard link.
- **Trigger failures:** Non-2xx response from `POST /api/runs` fails the workflow step.
- **Poll failures:** Transient errors (5xx, network, timeout) retry with backoff. A 404 during polling fails the workflow step with "run not found."
- **Enqueue warning:** If OKShip returns `warning: run_created_but_enqueue_failed`, the action sets `run_id`/`run_url` and surfaces a warning without polling. Check the dashboard for the pending run.

## Common errors

| Error code | Cause | Fix |
|---|---|---|
| `invalid_api_key` | API key is missing, malformed, revoked, or doesn't match an active key | Regenerate from OKShip dashboard, update the repo secret. |
| `app_not_found` | `app_id` doesn't exist or doesn't belong to your org | Verify the UUID via your OKShip dashboard. |
| `no_scenarios` | The app has no scenarios attached, or all `scenario_ids` you supplied aren't on the app | Add scenarios to the app, or check the `scenarios` input. |
| `free_daily_run_limit` | Free plan exceeded its 1-run-per-day cap | Wait for the next UTC day, or upgrade the plan. |
| Other 403s (plan caps) | Monthly execution cap reached on your plan | Upgrade the plan or wait for the next billing cycle. |

## Gating workflows on the verdict

```yaml
- uses: okship-dev/run-action@v0.1.0
  id: okship_run
  with:
    api_key: ${{ secrets.OKSHIP_API_KEY }}
    app_id: <your-app-uuid>
    okship_api_base: https://your-okship-host.example.com

- name: Fail the build if scenarios failed
  if: steps.okship_run.outputs.verdict == 'fail'
  run: exit 1

- name: Notify on ambiguous outcome
  if: steps.okship_run.outputs.verdict == 'ambiguous'
  run: echo "Manual review needed at ${{ steps.okship_run.outputs.run_url }}"
```

## Versioning

This action uses [semantic versioning](https://semver.org/). Pin to a tag in your workflows (`@v0.1.0`), not a branch (`@main`), so breaking changes don't break your workflows automatically.

## License

MIT — see [LICENSE](./LICENSE).
