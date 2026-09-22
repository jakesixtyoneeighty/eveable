# Security Policy

Eveable generates, validates, previews, and deploys applications with AI assistance. Treat it as a system that can execute generated code in a sandbox and perform external deployment side effects.

## Supported Versions

Security fixes target the latest `main` branch and the latest tagged release.

| Version | Supported |
| --- | --- |
| `1.x` | Yes |
| `<1.0.0` | No |

## Reporting A Vulnerability

Please report security issues privately. Do not open a public issue with exploit details, secrets, private logs, or live tokens.

Send a private report to the repository owner with:

- affected commit or release
- vulnerability summary
- reproduction steps
- impact
- suggested fix, if known
- redacted logs or traces

If GitHub private vulnerability reporting is enabled for this repository, use that channel.

## Security Boundaries

Eveable's main security boundaries are:

- generated files are constrained to `/workspace/generated-app`
- generated file paths must be safe relative paths
- broad shell and file tools are disabled by default
- validation commands must be finite
- preview commands are separated from validation commands
- source files are read back from the sandbox before security review
- real secrets must not be written into generated files
- publication requires the trusted web release service and version-bound authorization
- Vercel deployment URLs must be verified before final success

## Secret Handling

Never commit:

- `.env.local`
- provider API keys
- Vercel tokens
- InsForge keys
- database URLs
- user data
- generated app credentials

Runtime secrets may be read by trusted Eveable server tools. They are never forwarded as generated-app deployment environment variables. They must not be copied into generated source files, browser-exposed `NEXT_PUBLIC_*` variables, or generated `.env.local` files.

## Generated Code Review

The `security_review` subagent checks generated apps after sandbox validation and before Vercel deployment. It should look for:

- hardcoded secrets
- unsafe browser environment variables
- exposed server credentials
- risky fetch/proxy behavior
- dangerous dependencies or scripts
- auth bypasses in generated server routes

Security review is not a substitute for human review before production use.

## Deployment Risk

`deploy_to_vercel` is now an explanatory blocked tool. The web publishing service holds `VERCEL_TOKEN` and requires a recorded version-bound user confirmation.

Recommended controls:

- use a Vercel token scoped to a dedicated project or team
- avoid production deployment unless explicitly requested
- keep preview protection enabled where appropriate
- review generated apps before using real data
- rotate tokens after suspected exposure

## Dependency Security

Run:

```bash
pnpm run audit
```

CI runs a critical production dependency audit. Contributors should also watch upstream security advisories for Eve, AI SDK, Vercel CLI, Next.js, and generated app dependencies.

## Authenticated workspace

Clerk authenticates identity; active `members` rows authorize use. Each project
has one owner. All source, export, session, preview, version, and deployment
requests enforce that owner. Web writes require the configured `APP_ORIGIN`.
No user-supplied session token or upstream URL is accepted by the web API.

Eve HTTP access uses short-lived signed requests scoped to an owner, project,
operation, route, and session. Local TUI access requires an explicit development
flag and is disabled in production. Unrestricted Vercel OIDC is not an alternate
path around project ownership. Keep signing keys out of browsers and sandboxes.

Generated source is treated as untrusted executable code. Immutable archives
exclude environment files, provider credentials, dependencies, build caches,
and symlinks escaping the generated workspace. Integrity hashes are verified on
read. Neon projections exclude hidden reasoning and raw tool payloads.

The preview gateway runs on an isolated wildcard origin with short-lived,
HttpOnly credentials. Membership is checked on every request. Preview sandboxes
expose no public ports; the gateway uses authenticated Sandbox SDK commands to
fetch loopback HTTP responses. Builder cookies, authorization headers, generated
Set-Cookie headers, and platform credentials are not forwarded. Responses and
request bodies are bounded. Iframes cannot navigate the top-level builder.

Publishing is authorized for an exact immutable version/hash. Platform Vercel
credentials remain in the web service. Source files are uploaded through the
Vercel API, never by a privileged CLI running beside generated code. Generated
projects must not inherit platform/shared secrets or OIDC access. Review team
integration defaults before enabling managed publishing.

Rate limits control admission counts, not total model or sandbox cost. Configure
provider spend controls independently. Workflow execution continues after the
browser closes. A failed or uncertain promotion requires provider-side
reconciliation; do not infer that a recorded old URL proves promotion did not
happen. Production rollout and hosted acceptance are separate from local tests.
