# OKShip Run Action

Official GitHub Action for OKShip — trigger evidence-generation runs from CI.

## Requirements

CI runs need two things set up in your OKShip organisation first: your own Anthropic key, saved under **Settings → Bring your own Anthropic key (BYOK)**, and a connected **GitHub Actions** integration, under **Settings → GitHub Actions**.

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
```

## What it does

The action posts to OKShip's `/api/runs` endpoint with the supplied app and (optional) scenarios, then reads the run through OKShip MCP (`get_run` on `/api/mcp`, with the same API key) until it reaches a terminal state (`complete`, `failed`, or `cancelled`). The verdict (`pass | fail | mixed | ambiguous`) is emitted as a workflow output, and **the step fails unless the verdict is `pass`**.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api_key` | yes | — | OKShip API key. An organisation owner generates one in the OKShip dashboard under Settings → API keys. Store it in repo secrets. It needs the **Start runs** scope, and the **Read** scope too when `wait_for_completion` is `true`. |
| `app_id` | yes | — | OKShip app UUID to run scenarios against. |
| `scenarios` | no | (all) | Comma-separated scenario UUIDs. Defaults to all scenarios on the app. |
| `wait_for_completion` | no | `true` | If `true`, wait until the run finishes, emit `verdict`, and fail the step unless it is `pass`. If `false`, return immediately after the run is enqueued. |
| `timeout_minutes` | no | `30` | How long to wait for the verdict, in whole minutes, from 1 to 120. Any other value fails the step before a run is started. |
| `okship_api_base` | no | `https://okship.dev` | OKShip API base URL. Set it only to point the action at a different OKShip deployment. |

## Outputs

| Name | When set | Description |
|---|---|---|
| `run_id` | After successful trigger | The OKShip run UUID. |
| `run_url` | After successful trigger | Direct link to the run in the OKShip dashboard. |
| `verdict` | When `wait_for_completion=true` AND the run reaches a terminal state with `overall_result` returned | `pass`, `fail`, `mixed`, or `ambiguous`. |

What each verdict means:

- `pass`: every scenario's goal was reached.
- `fail`: no scenario's goal was reached.
- `mixed`: the scenarios got different verdicts. That includes some goals passing while others are "not sure" (`ambiguous`), with none failing.
- `ambiguous`: OKShip couldn't tell whether the goals were reached. Review the run.

No verdict at all is also possible: the run failed, the run was cancelled, OKShip is withholding the verdict, or polling timed out. The step fails in every one of those cases, and for `fail`, `mixed` and `ambiguous`. Only `pass` passes it.

## Behavior

- **Polling cadence:** 10s initial delay, exponential backoff up to 60s cap, `timeout_minutes` overall budget (default 30).
- **Polling timeout:** If the run hasn't reached a terminal state within the budget, the step fails with `run_id` and `run_url` set. `verdict` is not set. The run keeps going; check the dashboard link.
- **Trigger failures:** Non-2xx response from `POST /api/runs` fails the workflow step, and the log quotes OKShip's refusal message word for word. The one exception is `503 admission_busy`, below.
- **Busy retry:** If OKShip answers `503 admission_busy` (it is starting another run for your organisation and created nothing), the action waits for the `Retry-After` time (at most 60s) and tries again, up to 3 times, within the 30-minute budget. Each retry is logged. No other trigger failure is retried, so a retry can never create a second run.
- **Poll failures:** Transient errors (5xx, network, timeout) retry with backoff. A refused read (401 or 403 from `/api/mcp`, for example `insufficient_scope` on a key without the Read scope, or a `run_not_found` tool error) fails the step at once.
- **Enqueue warning:** If OKShip returns `warning: run_created_but_enqueue_failed`, the action sets `run_id`/`run_url` and surfaces a warning without polling. Check the dashboard for the pending run.
- **Finished without a verdict:** The action stops polling, leaves `verdict` unset and fails the step, naming the reason: the run failed, the run was cancelled, or the run's results are on hold.
- **Your API key stays out of the log:** The action registers the key as a secret as soon as it reads it, and removes it from every message it writes.
- **Unrecognised verdict:** If OKShip returns a verdict this version of the action doesn't know, the step fails and asks you to update the action.

## Common errors

These are the errors `POST /api/runs` can return to this action. The error code is the `error` field of the response body.

| Error code | HTTP status | Cause | Fix |
|---|---|---|---|
| `invalid_api_key` | 401 | The API key is malformed, revoked, or doesn't match an active key. | Have an organisation owner create a new key under Settings → API keys, then update the repo secret. |
| `api_key_creator_not_member` | 403 | The person who created the API key is no longer a member of the organisation. | Have a current organisation owner create a new key, then update the repo secret. |
| `insufficient_role` | 403 | The person who created the API key no longer has a role that can start runs. The key acts with its creator's current role, and starting a run needs `editor` or above. | Give that member back a role of `editor` or above, or have a current organisation owner create a new key. Only owners can create API keys. |
| `invalid_app_id` | 400 | `app_id` isn't a well-formed UUID. | Copy the app's UUID from your OKShip dashboard. |
| `invalid_scenario_ids` | 400 | One of the `scenarios` values isn't a well-formed UUID. One bad ID refuses the whole request. | Check the `scenarios` input. |
| `app_not_found` | 404 | `app_id` doesn't exist or doesn't belong to your organisation. | Verify the UUID via your OKShip dashboard. |
| `scenario_not_in_app` | 400 | One or more of the `scenarios` you supplied aren't on this app. | Check the `scenarios` input against the app's scenarios. |
| `no_scenarios` | 422 | The app has no scenarios. | Add scenarios to the app. |
| `target_auth_host_mismatch` | 409 | A connection attached to the app or a scenario is for a different host than the app's URL. | Correct the app's URL or the connection. |
| `password_connections_manual_only` | 409 | The app or a scenario uses a password connection, and those runs can only be started from the dashboard. | Start this run from the dashboard, or detach the connection. |
| `session_connections_disabled` | 409 | The app or a scenario uses a saved browser session connection, which isn't available. | Detach the connection. |
| `free_lifetime_run_limit` | 402 | The Free plan includes 2 runs for the lifetime of the account, and both have been used. This doesn't renew. | Upgrade your plan. |
| `free_lifetime_exec_limit` | 402 | The Free plan includes 6 executions (one per scenario per run) for the lifetime of the account, and this run needs more than are left. This doesn't renew. | Run fewer scenarios with the `scenarios` input, or upgrade your plan. |
| `hosted_exec_limit_no_byok` | 403 | Your plan's hosted executions for this billing cycle are used up, and runs above that need your own Anthropic key. | Save your Anthropic key under Settings → Bring your own Anthropic key (BYOK), wait for the next billing cycle, or upgrade. |
| `total_exec_limit` | 403 | This run would go over your plan's monthly execution cap. | Wait for the next billing cycle, run fewer scenarios, or upgrade. |
| `org_not_found` | 403 | The organisation the key belongs to no longer exists. | Create a new key in an active organisation. |
| `admission_busy` | 503 | OKShip is busy starting another run for your organisation. Nothing was created. | The action retries this on its own (see Behavior). If it still fails, re-run the job. |

## Gating workflows on the verdict

The action's own step now fails on any verdict other than `pass`, so the gate step below is optional. It still works, and it still names the verdict in its own log line.

One gate step stops the build on any verdict other than `pass`, including no verdict. It needs `wait_for_completion: true` (the default): without waiting there is never a verdict, so the gate always stops the build.

```yaml
- uses: okship-dev/run-action@v0.1.0
  id: okship_run
  with:
    api_key: ${{ secrets.OKSHIP_API_KEY }}
    app_id: <your-app-uuid>
    wait_for_completion: true

- name: Stop the build unless every goal passed
  if: steps.okship_run.outputs.verdict != 'pass'
  run: |
    echo "OKShip verdict: ${{ steps.okship_run.outputs.verdict || 'no verdict' }}"
    echo "Review the run: ${{ steps.okship_run.outputs.run_url }}"
    exit 1
```

## Versioning

This action uses [semantic versioning](https://semver.org/). Pin to a tag in your workflows (`@v0.1.0`), not a branch (`@main`), so breaking changes don't break your workflows automatically. A full commit SHA (`@<40-character SHA>`) is the strictest pin.

## License

MIT — see [LICENSE](./LICENSE).
