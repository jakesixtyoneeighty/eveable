# Frontend delivery and acceptance

The implementation is in this checkout. The web and agent runtime are deployed,
and authenticated chat has passed a hosted smoke check. Full hosted acceptance
is **pending**. Do not treat deployment or locally passing tests as proof that
generated builds, previews, restoration, or publishing work end to end.

## Implemented surfaces

- Separate Next.js workspace with project home, resizable chat/preview, mobile
  tabs, exact approval choices, source inspection, exports, version history,
  restoration confirmation, and version-specific publishing confirmation.
- Clerk identity plus active Postgres membership, ownership checks, operator
  membership commands, same-origin writes, and short-lived scoped runtime auth.
- Durable session mapping and safe event projection, reconnect cursors,
  idempotent operation admission, concurrency controls, and daily limits.
- Source-aware edits, immutable private source archives, independent validation
  before version capture, and preview-ready completion without deployment.
- Vercel Sandbox preview adapter, isolated authenticated gateway, expiry and
  restart, and trusted server-side deployment/promotion with recovery handling.

## Verified locally

| Gate | Evidence |
| --- | --- |
| Runtime CI | Audit at the repository's critical threshold, strict typecheck, Eve build, and smoke contracts |
| Web CI | ESLint, core/web typechecks, 36 unit tests, Next.js production build |
| Database integration | 15 tests against disposable PostgreSQL with real migrations and queries; Blob, Sandbox, deployment responses, and Clerk identity are mocked |
| Browser | Six Chromium desktop/mobile tests using the actual components with fixture APIs; screenshots inspected |
| Local production server | Setup screen returns 200; unconfigured protected API denies access; direct gateway path on builder host returns 404 |
| Dependencies | Frozen lockfile install; Eve 0.18.0 and stable AI SDK 7.0.0 pinned for Vercel compatibility |

Integration coverage includes membership/revocation/ownership, concurrent and
repeated submissions, quota admission, durable approval replay, exact Eve
continuation behavior, direct runtime scopes, source privacy, failed edit
retention, preview assets and credentials, candidate-before-promotion ordering,
and uncertain-release reconciliation. Unit tests cover source preservation and
approval-gated writes in addition to projection, paths, tokens, and operation
contracts. This is not exhaustive adversarial or hosted acceptance.

The critical audit passes. Eight noncritical advisories remain (three high,
four moderate, one low). The newly introduced Drizzle dependency was updated
to its security patch. The remaining upstream dependencies need review before
production; the Eve/AI SDK version upgrade is described below.

## Vercel deployment compatibility

The frontend deployment from `apps/web` previously compiled successfully but
Vercel rejected its output because it traced `eve@0.11.4`. Both application
manifests now pin Eve `0.18.0`; stable AI SDK `7.0.0` satisfies its peer contract.
The smoke check prevents an older or mismatched Eve installation.

A source deployment using the configured production environment, with custom
domain promotion skipped, reached **Ready**:
`dpl_CeYnEDCg3ti58FHpee5wSUFLGtR7`. Using the authenticated Vercel CLI to pass
Deployment Protection, the landing page returned 200 and displayed sign-in;
`/api/projects` rejected an anonymous application caller with 401.
This proves the hosted version rejection is resolved. It does not establish
Clerk sign-in, database migrations/membership, a live agent session, embedded
preview, or generated-app publishing. The custom domain has not been promoted
to this candidate. No runtime project was deployed as part of that initial check.

## Hosted agent connection — September 22, 2026

At the owner's request, the separate `eveable-runtime` Vercel project was created
with the Eve preset, Node 24, repository-root build, hosted Workflow output,
OIDC enabled, and production runtime credentials. Its stable origin is
`https://eveable-runtime.vercel.app`; deployment
`dpl_G4b9JgFTTDGnqUuowXY2K9i4CUdy` reached Ready. Standard Deployment Protection
guards generated deployment/preview URLs; the stable production API enforces
Eveable's signed, project-scoped authorization.

The web project's production `EVE_RUNTIME_ORIGIN` was updated and the existing
web source redeployed as `dpl_8NvwweFFniuqFXYhbW9Wc5hrPzei`. Its aliases include
`https://build.sixtyoneeighty.dev` and the isolated preview wildcard.

Verified against hosted services:

- Runtime health returned 200/ready; anonymous dispatch returned 401.
- Invalid tokens, signed requests without an owned project, cross-user streams,
  unprovisioned-user streams, and mismatched session paths returned 403.
- Through the owner's signed-in Chrome session, a chat-only connection check
  created a project, dispatched through the web Workflow, ran the intent and
  conversation subagents, and displayed an assistant reply.
- The operation was recorded as completed, its active project lock cleared,
  and the session remained waiting for input. Neon held 14 safe activity rows
  and a replay cursor of 29. Reloading the browser preserved the conversation.
- The test project remains in the owner's history as
  `Deployment connection check: say hello in one short`.

Actual provider usage: the check used real Vercel Workflow and AI Gateway calls
to `openai/gpt-5.4-mini`. Agent Runs reported root usage of 26,080 input tokens,
178 output tokens, and 14,848 cached input tokens; subagent usage is reported
separately by the provider. Billed cost was not measured. Runtime logs contained
AI SDK `propertyNames` schema compatibility warnings, with successful HTTP
responses and a completed chat operation. No generated build, preview, Blob
archive, or customer-app release was exercised by this check.

Runtime CI was rerun and passed. The runtime was deployed from the local working
tree; the earlier SDK/package/documentation changes still need to be committed
before relying on Git-based deployments. The Clerk application remains a
restricted development instance; this is not a production Clerk cutover.

## Hosted gates still required

Configure staging Clerk (verified email, restricted sign-up), Neon, private
Blob, the two Vercel projects, Sandbox access, signing keys, and an isolated
wildcard HTTPS preview domain. Provision application membership separately.

1. Run real anonymous, uninvited, revoked, and second-user access checks across
   every endpoint, direct runtime routes, and all preview assets.
2. Exercise approval, revision, Stop, stale approvals, concurrent tabs, reload,
   network interruption, and a closed browser while a real Eve run finishes.
3. Build, edit, and restore real generated source; verify unrelated files,
   immutable history, export contents, and failed validation/security gates.
4. Complete the hosted preview adapter test: HTML, JS/CSS/assets, navigation,
   iframe isolation, browser cookie support, direct-access denial, expiry, and
   restart. Until this passes, embedded preview is not accepted as delivered.
5. In a disposable generated-app project, explicitly authorize publishing and
   verify candidate build, exact version/hash, stable production destination,
   duplicate requests, failure, rollback, and operator reconciliation.
6. Confirm production service settings, operational limits, accessibility,
   and provider spending controls before requesting a separate rollout.

`pnpm web:e2e:live` supplies the basic real build/approval/preview journey when
`E2E_BASE_URL`, `E2E_STORAGE_STATE`, and `E2E_LIVE_BUILD=true` are set. Publishing
in that test additionally requires `E2E_ALLOW_PUBLISH=true`. The broader matrix
above still needs authenticated hosted acceptance; one happy-path test is not
that entire matrix.

The local and mocked checks above used no live providers. The hosted chat check
did use live models and Workflow, as reported separately above. Full generated
build, sandbox/preview, Blob artifact, and publishing acceptance remains pending.

## Adapter boundaries

Preview sandboxes expose **zero public ports**. A trusted gateway uses the
public Sandbox SDK to request loopback HTTP, so direct upstream URLs cannot
bypass ownership. This intentionally differs from exposing a sandbox port.
The initial bridge supports HTTP, not WebSockets/HMR, with bounded response
sizes and a 20-minute maximum sandbox lifetime. Browser reachability and
partitioned-cookie behavior require the hosted gate above.

An uncertain promotion is never reported as a known failure or a verified
success. The service attempts compensation to the previous recorded release;
if verification remains uncertain it blocks further publication, preserves
saved source, and allows edits. `pnpm release:reconcile <operation-id>` verifies
the actual provider target and updates the release record without deploying.
