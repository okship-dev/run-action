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

The action posts to OKShip's `/api/runs` endpoint with the supplied app and (optional) scenarios, then polls `/api/runs/<id>/status` until the run reaches a terminal state (`complete`, `failed`, or `cancelled`). The verdict (`pass | fail | mixed | ambiguous`) is emitted as a workflow output for downstream steps.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `api_key` | yes | — | OKShip API key. Generate one in your OKShip dashboard under Settings → API keys and store it in repo secrets. |
| `app_id` | yes | — | OKShip app UUID to run scenarios against. |
| `scenarios` | no | (all) | Comma-separated scenario UUIDs. Defaults to all scenarios on the app. |
| `wait_for_completion` | no | `true` | If `true`, poll until the run terminates and emit `verdict`. If `false`, return immediately after the run is enqueued. |
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
- `mixed`: the scenarios got different verdicts, for example some reached their goal and some didn't.
- `ambiguous`: OKShip couldn't tell whether the goals were reached. Review the run.

## Behavior

- **Polling cadence:** 10s initial delay, exponential backoff up to 60s cap, 30-minute overall timeout.
- **Polling timeout:** If the run hasn't reached a terminal state within 30 minutes, the action exits successfully with `run_id` and `run_url` set and surfaces a warning. `verdict` is not set in this case. Long-running scenarios are a valid outcome — check the dashboard link.
- **Trigger failures:** Non-2xx response from `POST /api/runs` fails the workflow step. The one exception is `503 admission_busy`, below.
- **Busy retry:** If OKShip answers `503 admission_busy` (it is starting another run for your organisation and created nothing), the action waits for the `Retry-After` time (at most 60s) and tries again, up to 3 times, within the 30-minute budget. Each retry is logged. No other trigger failure is retried, so a retry can never create a second run.
- **Poll failures:** Transient errors (5xx, network, timeout) retry with backoff. A 404 during polling fails the workflow step with "run not found."
- **Enqueue warning:** If OKShip returns `warning: run_created_but_enqueue_failed`, the action sets `run_id`/`run_url` and surfaces a warning without polling. Check the dashboard for the pending run.
- **Finished without a verdict:** The action stops polling, leaves `verdict` unset and surfaces a warning that names the reason: the run failed, the run was cancelled, or the run finished and OKShip is holding its verdict for review.
- **Unrecognised verdict:** If OKShip returns a verdict this version of the action doesn't know, the step fails and asks you to update the action.

## Common errors

These are the errors `POST /api/runs` can return to this action. The error code is the `error` field of the response body.

| Error code | HTTP status | Cause | Fix |
|---|---|---|---|
| `invalid_api_key` | 401 | The API key is malformed, revoked, or doesn't match an active key. | Create a new key under Settings → API keys and update the repo secret. |
| `api_key_creator_not_member` | 403 | The person who created the API key is no longer a member of the organisation. | Have a current member create a new key and update the repo secret. |
| `insufficient_role` | 403 | The person who created the API key doesn't have a role that can start runs. The key acts with its creator's role, and starting a run needs `editor` or above. | Raise that member's role, or have an editor or owner create the key. |
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

```yaml
- uses: okship-dev/run-action@v0.1.0
  id: okship_run
  with:
    api_key: ${{ secrets.OKSHIP_API_KEY }}
    app_id: <your-app-uuid>

- name: Fail the build if any goal didn't work
  if: steps.okship_run.outputs.verdict == 'fail' || steps.okship_run.outputs.verdict == 'mixed'
  run: exit 1

- name: Flag a not-sure verdict for review
  if: steps.okship_run.outputs.verdict == 'ambiguous'
  run: echo "Review needed at ${{ steps.okship_run.outputs.run_url }}"
```

## Versioning

This action uses [semantic versioning](https://semver.org/). Pin to a tag in your workflows (`@v0.1.0`), not a branch (`@main`), so breaking changes don't break your workflows automatically. A full commit SHA (`@<40-character SHA>`) is the strictest pin.

## License

MIT — see [LICENSE](./LICENSE).
