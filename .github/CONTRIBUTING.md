# Contributing

Thanks for taking a look! This is a small, security-focused Pi extension — the bar is intentionally high on correctness and low on ceremony.

## Development setup

```bash
npm install   # installs the Pi peer dep (devDependency, tests only)
npm test      # plain-assert self-checks, no framework or external network
```

No build step: Pi loads the TypeScript sources directly. Keep runtime code in `index.ts` (agent authentication) and `setup.ts` (configuration and setup wizard), without extra layers.

## Pull requests

- Small diffs. If a change needs a wall of prose to explain, split it.
- Pure logic (`ssh config` parsing, `insteadOf` countersinks, env assembly) gets tests in `test.ts`.
- `npm test` must pass; update the README if user-visible behavior changes.
- Runtime dependencies stay at one: `@octokit/auth-app` (GitHub-maintained, owns JWTs + token cache). Everything else is Node built-ins and the Pi extension API — no new runtime deps without a security review.
- Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles (used as commit messages when squash-merging): `fix:` patches, `feat:` bumps minor, `feat!:`/`BREAKING CHANGE:` bumps major. `docs:`, `chore:`, `test:` and friends release nothing.

## Dependabot auto-merge

After the caller is merged to `main`, successful `CI` pull-request runs let the
shared workflow opt current, non-draft Dependabot PRs to `main` into native squash
auto-merge. All update types are eligible; titles are not rewritten. Required
checks and human CODEOWNER approval still gate merging; no approval or bypass is
provided by the workflow.

Before merging the caller, verify that native auto-merge and squash are enabled,
required checks and human CODEOWNER review are enforced with stale approvals
dismissed, and the App has no bypass. The caller needs the Actions variable
`GH_APP_ID` and secret `GH_APP_PRIVATE_KEY`, with the App installed on this repository
and granted Contents and Pull requests write permissions. Repository settings are
managed separately through Terraform.

The caller does not run from an unmerged PR. Live acceptance needs a future actual
Dependabot PR and human review. To opt out, remove the caller and cancel its active
runs; disable auto-merge separately on already queued PRs.

## Releases

The Release workflow runs semantic-release after a merge to `main`. It publishes
npm packages, versioned Git tags and GitHub Releases without pushing release commits
to the protected branch. The npm plugin sets the published package version in the CI
workspace; the source `package.json` version can therefore lag behind npm.
Use [GitHub Releases](https://github.com/tonyputi/pi-github-app-auth/releases) for current
release notes. The existing `CHANGELOG.md` is retained as historical release notes.

## Security issues

This extension handles a GitHub App private key. **Do not open a public issue for security problems** — use [private vulnerability reporting](https://github.com/tonyputi/pi-github-app-auth/security/advisories/new) instead.

## License

By contributing you agree that your contributions are licensed under the MIT License.
