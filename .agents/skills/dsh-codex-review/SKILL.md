---
name: dsh-codex-review
description: Use when a change needs an independent Codex review and re-verification — dispatch a self-contained review packet to the subagent_codex tool, fix the substantiated findings, and delegate again until the reviewer reports no blocking findings
---

# Codex review and re-verification loop

`subagent_codex` (provider `codex`, `backgroundMode: one-shot`, `maxDepth: provider-managed`) starts a **new Codex session for every call**: different context, no memory of this chat, no memory of the previous round, no workspace diff carried over. Everything the reviewer needs must be in the `prompt` you send, and the reviewer's only output is its final answer.

Use this loop before delivering a non-trivial change, and again whenever a round comes back with findings.

## Preconditions

- The profile installed `@deepseek-ai/dsh-subagent-codex`, and the active Agent Preset enables the `tool-subagent-codex` row. The row keeps `provider: codex`, `backgroundMode: one-shot`, and `maxDepth: provider-managed`.
- Codex configuration and authentication stay native: the reviewer runs with the profile's `HOME`/`CODEX_HOME` and its own model selection. Do not restate or override Codex settings in the prompt.
- The provider sends no model unless its own row pins `model`, so native model selection applies and a native model the CLI rejects for the account fails every turn with `category: product-error`. Pin a supported model on the provider row when the native setting names an app-only model.
- A missing `subagent_codex` tool has two independent causes. The provider must be registered (the tool exists only while its provider does: the bundle is installed, compatible, and active), and the Agent must be bound to a preset revision that enables the row. Settle provider availability first; only then treat the gap as preset rebinding. A running Agent keeps the composition it was created with, so a changed preset reaches a session only after that Agent is re-created (profile restart / new session).

## The dispatch packet

Every call sends all six fields. Omitting one makes the reviewer guess, and a review built on guesses is worse than no review.

| Field | Content |
|---|---|
| Requirement | What the change must achieve and for whom; the user-visible or system-visible outcome. |
| Acceptance criteria | Checkable conditions that make the change correct. State how each one can be observed. |
| File scope | Exact paths or globs the review covers, plus explicit exclusions. Never "the repo". |
| Code version | Commit sha, branch, and the exact commands that show the change (`git rev-parse HEAD`, `git diff <base>...HEAD -- <paths>`, `git status --short`). State whether uncommitted work is in scope. |
| Previous round | On round 2+, the findings from the last round, what you changed for each (commit or hunk), and which ones you rejected and why. Empty on round 1. |
| Output contract | Report findings only: severity (`blocking` / `suggestion`), `path:line`, why it matters, and how to verify. Review only — do not edit files, do not commit, do not run mutating commands. Stop after the findings list. |

Keep the packet factual and compact. Pass paths, commands, and hashes instead of pasted code or pasted transcripts; the reviewer can read the workspace itself.

## Procedure

1. **Ground the packet.** Collect the real version state before writing the prompt: `git rev-parse HEAD`, `git status --short`, and a diff stat over the file scope. Confirm the files you name exist.
2. **Dispatch in the foreground.** Omit `run_in_background`; the call waits and returns the reviewer's final answer directly into this conversation, so no report is copied between applications. Use `run_in_background: true` only for a long review, then collect with `job_output`.
3. **Triage every finding.** Substantiate each claim against the code before acting on it. Fix blocking findings and any suggestion that is genuinely right; for a rejected finding, record the reason and put it in the next round's Previous round field instead of silently dropping it.
4. **Re-delegate after fixing.** Round 2 is a **new** Codex session with the same packet plus the Previous round field, and one added instruction: verify each listed fix, re-report every previous finding whose fix did not hold, then report new blocking findings. A fix the reviewer does not explicitly confirm as resolved is still open. The reviewer does not remember round 1 and cannot see your fixes unless the packet carries them.
5. **Stop only on a clean round.** Done when a round reports no `blocking` findings, including no unresolved previous finding. A loop that keeps returning the same blocker is unresolved, not clean: report the blocker with its evidence and do not claim the change is verified. Two rounds without progress stop the loop as an escalation to the user, never as a pass.
6. **Report the loop.** In the final answer, list the rounds, the findings, what changed for each, and the verification evidence (commands and their results) — not the reviewer's raw transcript.

## Rules

- Never paste this conversation, a summary of it, or the reviewer's previous answer verbatim into the prompt; the packet carries facts, not transcripts.
- Keep the review read-only. The peer can run commands in the profile's working directory, so name the scope and forbid edits explicitly.
- Treat Codex findings as evidence, not authority: check each claim, and neither accept nor dismiss it without reading the code.
- Fix findings in the change under review, not around it: no unrelated rewrites to satisfy a reviewer.
- One reviewer round covers one version. After a fix, the reviewed version is stale; re-delegate before claiming the change is verified.

## Limits of this arrangement

- Each call is one-shot: no continuation, no follow-up message to the same Codex thread, no progress stream. A follow-up is always a new session with a new packet.
- Conversation inheritance does not exist here. `subagent_codex` accepts no `agentOptions`, output schema, persona, or tool filter, and `maxDepth: provider-managed` leaves depth to Codex.
- The loop is a convention enforced by this skill. If the requirement becomes "every delivery must be reviewed, with a hard cap on rework rounds", that needs scheduling/guard code, not a prompt.
