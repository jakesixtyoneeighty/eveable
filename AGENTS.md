# Eveable Agent Guide

## What this project is

Eveable is an open-source Lovable-style application builder built on Vercel
Eve. A user prompt is routed through specialist agents, converted into an
approved design, generated as a Next.js app inside an Eve sandbox, validated,
previewed, security-reviewed, and optionally deployed to Vercel.

This repository contains the Eve agent runtime, builder pipeline, and the
Next.js web workspace in `apps/web`. Shared server contracts and storage live
in `packages/core`. Generated
customer applications are also not repository source: they live in the sandbox
at `/workspace/generated-app`.

Read these files before changing behavior:

- `README.md` for product behavior, local API usage, and the current architecture.
- `CONTRIBUTING.md` for contribution and tool conventions.
- `SECURITY.md` before changing auth, sandboxing, secret handling, or deployment.
- `agent/instructions.md` before changing orchestration.
- `scripts/smoke.mjs` before changing files or phrases that define the workflow contract.
- The relevant guide in `node_modules/eve/docs/` before using or changing an Eve API.

Trust the implementation and configuration over prose when they disagree, then
update the affected documentation in the same change.

## Stack and required versions

- Node.js: `>=24 <27`; CI runs Node 24.
- Package manager: pnpm `11.5.0`.
- Module system: ESM with TypeScript `NodeNext`.
- Runtime framework: `eve@0.18.0`, exactly pinned in both root and web manifests.
- AI SDK: `ai@7.0.0`, deliberately pinned through dependency,
  override, and resolution entries.
- Validation: Zod `4.4.3`.
- Type checking: `tsgo` from `@typescript/native-preview`.

Use pnpm for this repository. `pnpm-lock.yaml` is authoritative; do not update
`package-lock.json` or switch package managers as part of unrelated work.

## Repository map

```text
agent/
  agent.ts                         Root Eve agent configuration
  instructions.md                  Root routing and completion contract
  channels/eve.ts                  Eve HTTP channel and auth configuration
  lib/model.ts                     Model selection and environment overrides
  lib/schemas.ts                   Shared Zod contracts and inferred types
  lib/sandbox.ts                   Path safety, command normalization, redaction
  sandbox/sandbox.ts               Eve sandbox backend configuration
  subagents/<name>/                Specialist agent.ts + instructions.md
  tools/                           Narrow, typed pipeline tools
scripts/smoke.mjs                  CI contract checks
scripts/package-release.sh         Release archive creation
env.sample                         Canonical environment-variable template
.github/workflows/                 CI and release automation
```

Important pipeline tools:

- `generate_next_app_from_spec.ts`: model-backed Next.js source generation from the approved spec.
- `run_quality_commands.ts`: finite validation commands only.
- `start_preview.ts`: preview startup and HTTP health check.
- `read_generated_files.ts`: source readback before review.
- `run_security_review.ts`: deterministic release gate.
- `deploy_to_vercel.ts`: generated-app deployment and URL verification.
- `bash.ts` and `write_file.ts`: intentionally disabled broad tools.

The TypeScript alias `#*` maps to `agent/*`; `#evals/*` is reserved for a future
`evals/` tree. Local ESM imports in TypeScript use `.js` suffixes.

## Commands

```bash
pnpm install --frozen-lockfile  # install exactly from the pnpm lockfile
pnpm run dev                    # API server; clears Eve workflow caches first
pnpm run dev:tui                # interactive Eve terminal UI
pnpm run dev:verbose            # full subagent/tool output for debugging
pnpm run build                  # Eve production build
pnpm run start                  # start the built Eve runtime
pnpm run typecheck              # strict TypeScript check with tsgo
pnpm run smoke                  # repository shape and workflow contract checks
pnpm run audit                  # critical production dependency audit
pnpm run ci                     # audit + typecheck + build + smoke
```

Run `pnpm run ci` for runtime changes. Run `pnpm web:ci` for web lint, shared/web
typechecks, Vitest, and the web production build; `pnpm test:integration` tests
against disposable Postgres; `pnpm web:e2e` runs desktop/mobile component fixtures.
Hosted acceptance is opt-in and requires dedicated staging credentials. Never
claim mocked provider tests prove hosted authentication, previews, or publishing.

The dev scripts intentionally delete `.eve`, `.output`, and `.workflow-data` to
prevent stale workflow resumptions. Preserve that behavior unless the cache
lifecycle is the subject of the change.

## Architecture rules

Preserve these invariants:

1. Every non-approval request calls `intent` first and waits for its result.
2. Root-to-subagent payloads contain exactly one key: `message`.
3. Build requests pass through design research and explicit user approval before generation.
4. Normal one-page sites use `generate_next_app_from_spec` for bespoke model-generated source; `code_writer` is for complex, non-standard apps and returns a compact `ImplementationSpec`, not source blobs.
5. Generated writes stay under the safe relative workspace `generated-app`.
6. Validation commands are finite; preview/server commands run only through the preview tool.
7. Completion order is quality checks, healthy internal preview, source readback, deterministic security review, then immutable version capture. Publishing is separate.
8. A build is never called ready or deployed without a verified result from the corresponding tool.
9. Build, preview, security, and deployment repair loops stay bounded.
10. Refero remains scoped to the design-research subagent.

Keep root orchestration in `agent/instructions.md`, shared structured contracts
in `agent/lib/schemas.ts`, and business/tool logic in focused TypeScript
modules. Each subagent owns only its `agent.ts`, instructions, and narrowly
scoped local tools.

## Frontend direction

The Eveable frontend is a client of the existing Eve API; it is not a
replacement for `agent/` and it is not the app generated at
`/workspace/generated-app`.

The frontend uses Next.js, Clerk, Neon/Drizzle, Tailwind, and Radix primitives
in `apps/web`. Do not replace these as incidental cleanup. Browser API routes
must enforce active membership, ownership, same-origin writes, operation locks,
and idempotency before dispatching to Eve. Continuation tokens remain server-side.

The web application uses separate Vercel projects for web and Eve runtime.
Workflow jobs dispatch/reconcile sessions and run preview/publication operations.
Runtime events persist safe activity even without a browser connection.
Generated source belongs to immutable private Blob archives and sandboxes, not
repository source. Preview content uses an isolated wildcard origin and no
public sandbox ports. Do not move it under the builder origin.

Use `pnpm web:dev`, `pnpm web:lint`, `pnpm web:typecheck`, `pnpm web:test`,
`pnpm web:e2e`, and `pnpm web:build`. The root Eve dev commands retain their
cache-clearing behavior. `EVEABLE_ALLOW_LOCAL_TUI=true` enables explicit local
TUI/curl access, never production access. Root runtime dependencies include
shared-core externals because Eve discovers authored modules from a root cache.

## Frontend and styling rules

For new UI work:

## Frontend
- Follow the `frontend-art-direction` skill for visually significant work.
- Preserve the existing visual language unless redesign is explicitly requested.
- Avoid generic SaaS card-grid layouts.
- Use shadcn primitives as implementation tools, not as visual direction.

## Data, auth, storage, and secrets

- Eve owns workflow/session state. Local state is written to ignored `.eve` and
  `.workflow-data` directories.
- Neon stores memberships, project metadata, operation locks, session mappings, activity, versions, previews, and deployments. Apply checked-in Drizzle migrations with `pnpm db:migrate`.
- `agent/channels/eve.ts` requires signed operation-scoped application access.
  Authentication does not bypass project ownership. Local auth is opt-in and
  unavailable in production. Never restore placeholder or anonymous browser access.
- `env.sample` is the environment contract. Local secrets belong in
  `.env.local`, which must remain uncommitted.
- `AI_GATEWAY_API_KEY` enables model access. Refero, Unsplash, InsForge, and
  model overrides are optional. `VERCEL_TOKEN` is required to deploy generated apps.
- Never place provider keys, tokens, database URLs, private user data, or real
  credentials in generated files, browser-exposed variables, logs, fixtures,
  or committed env files.

## Deployment

There are three separate deployment concerns:

1. The Eveable runtime is built with `eve build`, started with `eve start`, and
   packaged by `.github/workflows/release.yml`.
2. The Next.js web app is deployed separately with Workflow support.
3. Generated customer apps are uploaded from immutable source by the web
   publishing service, verified as candidates, then explicitly promoted to
   production. `deploy_to_vercel` is a blocked explanatory tool: credentials
   must never enter generated-app sandboxes.

Production deployment is an explicit user decision. Never fabricate a URL,
silently promote a preview, or describe a deployment as complete before URL
verification succeeds.

## Change guardrails

Do not casually change:

- `agent/instructions.md` or `scripts/smoke.mjs`; together they define and
  enforce the product workflow.
- `agent/lib/schemas.ts`; schema changes affect handoffs and tool contracts.
- `agent/channels/eve.ts`; it is the public auth boundary.
- Sandbox path checks, output redaction, command allowlisting, or network policy.
- The disabled status of broad `bash` and file-writing tools.
- The pinned Eve/AI SDK versions, package-manager version, or lockfile.
- Deployment allowlists, secret filtering, preview defaults, or release workflows.
- Generated workspace location or the distinction between repository source
  and sandbox output.

For changes to behavior, environment variables, security boundaries, or
deployment, update the corresponding README, `env.sample`, CONTRIBUTING, or
SECURITY documentation in the same change.
