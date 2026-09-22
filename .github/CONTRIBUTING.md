# Contributing

Thanks for taking a look! This is a small, security-focused Pi extension — the bar is intentionally high on correctness and low on ceremony.

## Development setup

```bash
npm install   # installs the Pi peer dep (devDependency, tests only)
npm test      # plain-assert self-checks, no framework, no network
```

No build step: the extension ships as a single `index.ts` (type-stripped by Node 22.18+). Keep it that way — one file is the auditability feature.

## Pull requests

- Small diffs. If a change needs a wall of prose to explain, split it.
- Pure logic (`ssh config` parsing, `insteadOf` countersinks, env assembly) gets tests in `test.ts`.
- `npm test` must pass; update the README if user-visible behavior changes.
- Never add runtime npm dependencies — Node built-ins and the Pi extension API only.

## Security issues

This extension handles a GitHub App private key. **Do not open a public issue for security problems** — use [private vulnerability reporting](https://github.com/tonyputi/pi-github-app-auth/security/advisories/new) instead.

## License

By contributing you agree that your contributions are licensed under the MIT License.
