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

Run `pnpm ci`, `pnpm web:ci`, `pnpm test:integration`, and `pnpm web:e2e` before
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
