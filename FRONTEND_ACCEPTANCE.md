# Frontend delivery and acceptance

The implementation is in this checkout. Hosted acceptance is **pending**, and
production rollout has not been performed. Do not treat locally passing tests
as proof that the configured providers work together.

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
| Dependencies | Frozen lockfile install; Eve 0.11.4 and AI SDK 7.0.0-beta.178 retained |

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
production; the pinned Eve/AI SDK versions were not changed.

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

No live model, sandbox, Blob, or publishing calls were used for the reported
checks. Actual billed provider usage has not been measured.

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
