# Small models for coordinator decisions

Research date and source access date: **2026-10-01**. The installed CLI is
**0.159.1**; `codex --help` and `codex exec --help` were inspected, with captures
in ignored `artifacts/decision-models/before/`. This is a pilot recommendation,
not a change to lane permissions or model configuration.

## What exists

The owner's phrase “decision models” most likely combines two things: small
general models used for narrow classification, and Codex's dedicated approval
reviewer. That is an inference, not an official model-family name. The
[Codex models guide](https://developers.openai.com/codex/models) recommends
Luna for extraction, classification and structured summaries. It recommends
Sol for complex work and Astra for the hardest workflows. The
[changelog](https://developers.openai.com/codex/changelog/) records Sol/Luna's
rollout on September 22 and GPT-6.1 Sol's rollout on September 29, 2026.
Both sources accessed 2026-10-01.

| Model | Role / cost tier | Standard credits per million input / cached / output | Published API context |
| --- | --- | --- | --- |
| `gpt-6-luna` | Efficient focused work; pilot choice | 2.5 / 0.25 / 12.5 | 1,050,000 |
| `gpt-6.1-sol` | Complex work below Astra's cost | 50 / 2.5 / 250 | 1,050,000 |
| `gpt-6-astra` | Highest capability and cost here | 250 / 25 / 1,250 | 1,050,000 |
| `gpt-reserve` | Brief reports fast, affordable agentic coding | **unverified** | **unverified** |
| `codex-auto-review` | Brief reports automatic approval review | **unverified** | **unverified** |

Credit rates come from [Codex pricing](https://developers.openai.com/codex/pricing).
They are subscription credit rates, not API dollars. Availability depends on
account, client, rollout and workspace controls; included usage also depends
on task size and reasoning. The public pages searched did not establish
Reserve's availability, price, context, or invocation guarantees, nor a
separate public price/context specification for `codex-auto-review`.
Accessed 2026-10-01.

Published API specifications for
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
list 922,000 maximum input and 128,000 maximum output tokens. These API ceilings
do not establish the effective CLI window or compaction threshold: those are
**unverified** for this account. Luna supports API reasoning through `max`;
Codex documents no Luna `ultra`. Accessed 2026-10-01.

Invoke a task model with `codex exec -m gpt-6-luna -s read-only`, or set `model`
and `model_reasoning_effort` in configuration. `--output-schema` constrains
the final JSON shape; `--json` exposes events, including usage when reported.
CLI help confirms these switches locally. Choosing `-m codex-auto-review`
is not documented as enabling approval review; use the reviewer setting.

## Auto-review and lane boundaries

[Auto-review](https://developers.openai.com/codex/sandboxing/auto-review)
routes eligible approval requests to another agent. It covers escalated shell
actions, blocked network access, writes outside roots and approval-required
MCP/app actions. Routine sandbox-permitted commands receive no review.
It aims to reject private-data exfiltration, credential probing, persistent
security weakening and destructive operations. Native Computer Use app
approvals still go to the person. A denial returns a rationale and directs
the main agent toward a materially safer alternative or the user; it is not
permission to retry indirectly. Timeouts are distinct from denials. Review is
probabilistic, not a deterministic security guarantee. Accessed 2026-10-01.

The [configuration reference](https://developers.openai.com/codex/config-reference)
documents `approvals_reviewer = "auto_review"` with an eligible `on-request`
or granular `approval_policy`. `never` provides no approval requests to review.
The local `--approve-for-me` shortcut selects automatic review with
workspace-write. Local `auto_review.policy` replaces policy;
`auto_review.extra_policy` adds instructions. Managed `guardian_policy_config`
and `guardian_extra_policy` take precedence; administrators can restrict
reviewer choices with `allowed_approvals_reviewers`. Accessed 2026-10-01.

Recommendation: consider an owner-approved, scoped lane trial after preserving
the complete reviewer policy and adding the lane prohibitions. Auto-review
does not expand filesystem/network grants, so it cannot promise builds, e2e or
Blender without escalations. Narrow scratch/store/worktree roots and assigned
ports make routine validation fit better; process or browser restrictions can
still fail. Keep independent deny rules for push/deploy/release/tag/publish,
family sync, installed-helper access, registry changes and the owner's Chrome.
Keep Playwright Chromium, guarded Link copies, the **no new sessions** e2e
guard, scoped reruns and coordinator review. AGENTS.md alone is not enforcement
for actions already allowed in the sandbox. No configuration is enabled here.

## Pilot boundaries

`lane digest` compresses the reported hand-back; `triage` recommends reruns.
Neither merges nor runs tests. Both invoke Luna in a temporary read-only,
ephemeral CLI session with user configuration ignored, shell/apps/plugins,
subagents and search disabled, strict schema validation and a 30-second timeout.
Inputs are bounded, allowlisted local logs; secret paths and links are refused
and secret-bearing lines excluded. Fallbacks preserve an extractive JSON summary.
The digest fits 1,200 characters, downgrading its verdict if facts are cut.

Files and recommendations stay local; **inference is remote** through the
authenticated Codex provider. Sanitized prompt text is sent to that provider.
This is not an offline model or a guarantee that arbitrary logs contain no
unknown secrets. Review sensitive logs first. Token counts are recorded when
reported, never inferred as billed cost. Coordinator context savings must be
measured separately from classifier usage; real pilot outputs and sizes live
under ignored `artifacts/decision-models/after/`.

The real pilot read marble-mobile and viewer-stray-objects: 852,518 and
671,456 source bytes became 1,185 and 1,093 JSON characters. The retained sims
failure log shrank from 76,669 bytes to 661 characters, preserving the exact
kart timeout and recommending the temporal selector. All three used fallback:
the local CLI's provider connection failed certificate validation and timed
out. Tokens and successful Luna inference remain unverified; no TLS protection
was disabled and no rerun was performed by triage.
