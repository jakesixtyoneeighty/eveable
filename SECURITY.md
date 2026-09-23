# Contributing To Eveable

Thanks for helping improve Eveable. This project is an Eve-powered AI app builder, so changes should preserve the core guarantee: generated apps are planned, approved, validated, previewed, security-reviewed, and saved before calling them ready to preview. Publishing is a separate authenticated action.

## Development Setup

1. Install Node.js `>=24 <27`.
2. Install pnpm `11.5.0`.
3. Install dependencies:

```bash
pnpm install --frozen-lockfile
```

4. Create local env:

```bash
cp env.sample .env.local
```

5. Add at least `AI_GATEWAY_API_KEY`. Add `VERCEL_TOKEN` if you are testing deployment.

## Local Workflow

Run Eve locally:

```bash
pnpm run dev
```

The default dev command runs Eve in no-UI API server mode, hides full subagent
streams, and collapses tool calls so generated source does not flood the
terminal. Use the quiet TUI for manual experiments:

```bash
pnpm run dev:tui
```

Use verbose mode only when you need raw child-agent output for debugging:

```bash
pnpm run dev:verbose
```

Run all checks:

```bash
pnpm run ci
```

Use focused checks while developing:

```bash
pnpm run typecheck
pnpm run build
pnpm run smoke
```

## Architecture Rules

- Keep the root workflow in `agent/instructions.md` explicit and conservative.
- Keep generated app writes inside `/workspace/generated-app`.
- Keep tool scopes narrow. Prefer typed Eve tools over broad shell access.
- Keep `bash.ts` and `write_file.ts` disabled unless a change intentionally updates the trust model.
- Preserve the design approval checkpoint before code generation.
- Preserve source readback before security review.
- Preserve autofix loops for build, preview, security, and deployment failures.
- Preserve Vercel URL verification before reporting published status.
- Keep deployment tokens out of generated sandboxes.
- Require server-side membership and project ownership on every web and runtime operation.

## Subagent Rules

Each subagent lives under `agent/subagents/<name>/`.

- `agent.ts` should define the model and short model-facing description.
- `instructions.md` should describe only that subagent's responsibility.
- Subagent tool calls from the root must use exactly one input key: `message`.
- Shared output shapes should be documented in `agent/lib/schemas.ts`.

## Tool Rules

Tools live under `agent/tools/`.

- Validate inputs with Zod.
- Return structured data.
- Redact secrets from command output.
- Avoid non-finite commands in validation tools.
- Do not write secrets into generated files.
- Treat deployment as an external side effect.

## Pull Request Checklist

Before opening a pull request:

- Run `pnpm run ci`.
- Update `README.md` if behavior, setup, env vars, architecture, or release behavior changes.
- Update `env.sample` if env vars change.
- Update `SECURITY.md` if the trust model changes.
- Keep unrelated refactors out of the PR.
- Include clear testing notes.

## License

By contributing to Eveable, you agree that your contribution is licensed under the MIT license.

## Reporting Bugs

Useful bug reports include:

- the prompt used
- whether the failure happened during design, code generation, validation, preview, security review, or deployment
- relevant redacted stream/tool output
- `pnpm run ci` result
- Node.js and pnpm versions

Never include secrets, API keys, tokens, private user data, or generated app credentials in issues.

## Web workspace development

The Next.js application is in `apps/web`; shared server code is in
`packages/core`. Keep runtime orchestration in `agent`. Use `pnpm web:dev` in a
second terminal next to `pnpm dev`. Follow the frontend art-direction skill for
visually significant changes, with the established light studio workspace.

Run `pnpm run ci`, `pnpm web:ci`, `pnpm test:integration`, and `pnpm web:e2e` before
handoff. Browser fixtures are isolated in `tests/ui`; never add fake project
records or test-auth bypasses to production routes. Hosted tests are explicitly
opt-in, cost money, and require a dedicated staging account.

Drizzle schema changes require checked-in SQL migrations. Generate with
`pnpm exec drizzle-kit generate`; apply only to the intended database with
`pnpm db:migrate`. Runtime and web share the same application database and Blob
store within one environment. Do not reuse production secrets in tests.

Preserve user and provider trust boundaries when adding tools: an authenticated
server operation is distinct from the model's plan. Tests must verify denied
cross-user access, replayed approvals, stale version publication, and revoked
membership. Treat ambiguous external writes as uncertain, not as successful or
safe to duplicate. Provider errors and raw tool outputs must not reach browsers.

### Code editor changes

`code-panel.tsx` owns version-scoped browser drafts; `code-editor.tsx` loads
CodeMirror on demand and retains per-file undo state. Preview and Code surfaces
stay mounted while hidden. Keep failed and stale drafts available to the user.
Manual saves are the `code_edit` operation in shared admission and execute bounded
phases through `packages/core/src/code-edit.ts` and the web Workflow. Generated
source stays in private Blob archives; only references/hashes enter operation
records. The final transaction captures the verified version and preview together.
The agent tool and manual validator share `packages/core/src/source-review.ts`.
Use `pnpm run ci` explicitly: `pnpm ci` is the package manager's clean-install
command. Manual editor validation requires the database and browser acceptance
suites, including stale versions, duplicate saves, failure retention, and revoked
membership. Mocked Sandbox/Blob responses are not hosted acceptance.

### Terminal changes

The Terminal tab is backed by `packages/core/src/terminal.ts` (admission, locks,
DTOs and cleanup), `terminal-runtime.ts` (sandbox execution), and
`terminal-output.ts` (command/output boundaries). The web routes dispatch durable
Workflow jobs; the startup workflow schedules expiry. `terminals` and
`terminal_commands` require migration `0002_gifted_black_tom.sql`.

Keep terminal execution separate from the agent sandbox and saved source. Stop
and every provider call that can create/resume/dispatch share a terminal row lock.
Claim a command before dispatch; a replay with uncertain execution closes the
session rather than repeating shell side effects. Run as the dedicated `runner`
user, clear its environment, kill remaining runner processes before releasing the
command slot, and stop the sandbox on abnormal completion. Unconfirmed cleanup
must retain the slot. Never add platform secrets or public ports.

Run `pnpm run ci`, `pnpm run web:ci`, `pnpm test:integration`, and `pnpm web:e2e`.
Integration tests apply migrations to disposable Postgres and mock provider
responses. Hosted acceptance must separately verify non-root execution, deny-all
networking, dependency installation, streaming, Stop, expiry, and process cleanup
using dedicated staging credentials. Do not treat local tests as that evidence.

## User terminal

Terminal API reads require active membership and project ownership; writes also
require the builder origin. Creation and command admission use durable locks,
idempotency keys, and limits. Workers recheck membership, ownership, archive
state, expiry, and terminal state before provider dispatch; running commands
monitor revocation. Browser DTOs exclude provider names, workflow identifiers,
owner identifiers, and request keys.

Terminal source is read from the private immutable archive into a separate,
nonpersistent Node 24 sandbox with zero exposed ports. Setup installs dependencies
as a dedicated unprivileged `runner` user using `npm install --ignore-scripts`,
restricted to the npm registry; it then changes the network policy to deny-all.
Commands run as that user with `env -i` and a small fixed environment. Platform
credentials and generated-app deployment credentials are never forwarded.
Terminal edits never change saved archives, source-review results or previews.

Execution is bounded to two minutes and 64 KB combined output per command,
20 commands per terminal, 15 minutes per session, and ten starts per account per
UTC day. The UI renders output as text; server-side filtering strips ANSI/control
sequences and recognized credentials. Incomplete output lines remain buffered
until they can be filtered together. Commands containing recognized credentials
are rejected before persistence. This filtering is not a safe secret storage
mechanism: users must not enter credentials.

Stop, cancellation, timeout, output overflow, revocation, and ambiguous execution
stop the full sandbox. Normal exits kill all remaining processes owned by runner
and confirm none remain before releasing the command slot. Creation, dispatch,
and process cleanup are fenced against Stop so late provider calls cannot resume
a cancelled terminal. If termination cannot be confirmed, keep `cleanup_required`
and the active slot for Retry Stop; provider execution is still bounded by its
own timeout. Dispatch uncertainty never grants an automatic command replay.
Command text and bounded filtered output remain private database records; the
terminal workspace itself is discarded. A new migration is required before rollout.


## Model-generated application source

The generator calls the configured code model inside the trusted Eve tool runtime,
using AI Gateway authentication. Only the approved implementation spec is sent;
platform credentials are not part of its prompt or returned source. CodeWriter
continues to return a spec, not source. The generator validates bounded structured
source, required routes, safe paths, duplicates, and credential filtering before
any generated file write, and runs the shared deterministic source review before
executing it. Missing or invalid output blocks instead of selecting a template.
Approval and membership are checked before generation and again before mutation.

Package manifests, dependency versions, build scripts, and TypeScript/Next config
are runtime-owned. Application generation cannot replace them. Installation uses
`--ignore-scripts`; platform InsForge credentials are no longer injected into
sandbox commands. Generated client integrations require an explicitly designed
service contract; generation does not provision service secrets. Existing sandbox
network policy is unchanged. Static review does not make arbitrary generated code
trusted: the sandbox, subsequent quality/preview/source checks, and immutable
version verification remain required. Publishing remains a separate web action.

One generation call has a three-minute timeout, a 32,000 output-token ceiling, and
no SDK retries. Completed Eve steps replay their results; interrupted steps may
rerun, so these limits are not an exactly-once billing or account cost guarantee.
Provider failures expose a fixed safe message, never raw model output or errors.
