# Security Policy

## Supported versions

This project is in early development: security fixes land on `main` and are released as patch versions. Only the latest published release is supported.

## Reporting a vulnerability

**Do not open a public issue.** Use [private vulnerability reporting](https://github.com/tonyputi/pi-github-app-auth/security/advisories/new) — reports reach only the maintainer, and GitHub supports discussing, fixing, and publishing a coordinated advisory.

Include what you can: reproduction steps, affected behavior, and the extension and Pi versions. The output of `/github-app-auth status` is safe to share — it is designed to contain no secrets.

Expect an acknowledgment within a few days. Disclosure is coordinated through a GitHub Security Advisory once a fix is released, with credit in the advisory unless you prefer to remain anonymous.

## Scope

This extension handles a GitHub App private key and deliberately keeps agent credentials isolated from personal ones. In scope:

- leaking the private key, the credential file, or installation tokens to other processes, logs, or disk
- bypasses of the isolation guards (credential-helper reset, SSH guard, `insteadOf` countersinks, environment stripping)
- anything that lets agent commands silently use *personal* credentials, or personal shells pick up *agent* credentials

Out of scope, consistent with [Pi's own security model](https://github.com/earendil-works/pi/blob/main/SECURITY.md):

- attacks that already require running code as your user on your machine
- agent misbehavior driven by prompt injection from repository content
