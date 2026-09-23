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
- Preserve bounded autofix loops for build, preview, and security failures.
  Publishing failures belong to the separate web publishing service.
- Preserve Vercel URL verification before reporting published status.
- Keep deployment tokens out of generated sandboxes.
- Require server-side membership and project ownership on every web and runtime operation.

## Subagent Rules

Each subagent lives under `agent/subagents/<name>/`.

- `agent.ts` should define the model and short model-facing description.
- `instructions.md` should describe only that subagent's responsibility.
- Subagent tool calls from the root must use exactly one input key: `message`.
- Shared output shapes should be documented in `agent/lib/schemas.ts`.
- CodeWriter returns only `ImplementationSpec`; the legacy `CodeWriterResult`
  declaration is not its active handoff. Do not reintroduce source-file or
  quality-plan generation instructions into that specialist.
- `agent/lib/app-generation.ts` owns the private structured source-generation
  call and build scaffold. Do not reintroduce fixed page markup, industry copy,
  styles, or stock imagery. Preserve approved page/design/interaction fields.
- Generated source must pass schema, required-route, path, duplicate, size,
  secret, and pre-execution security checks before workspace mutation. Recheck
  operation approval after model generation; failed generation has no fallback.
  Keep source-generation calls bounded and report provider errors without raw
  output. Validate model output with fixtures separately from live acceptance.
- Review prompt changes alongside model-facing tool descriptions and smoke
  checks. Keep capability claims within the actual renderer and tool behavior.
- Repairs require current source and return changed files only. New-build repair
  writes must pass `resetWorkspace:false`; full-manifest readback still precedes
  the deterministic security gate and version capture.
- `pnpm run ci` verifies local runtime contracts, not model instruction adherence
  or hosted behavior. Exercise representative build, edit, analysis, blocked-spec,
  and repair conversations separately when running provider-backed acceptance.

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
