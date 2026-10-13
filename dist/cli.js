#!/usr/bin/env node
/**
 * Deprecated CLI entry — the setup moved inside Pi. Kept so existing installs,
 * docs and muscle memory get pointed to the new flow; scheduled for removal
 * in 1.0.0.
 */
console.log([
    "pi-github-app-auth: the setup CLI moved inside Pi.",
    "",
    "  1. Start pi",
    "  2. Run  /github-app-auth setup",
    "",
    "The wizard creates the GitHub App (pre-filled manifest form), installs it",
    "and stores the credentials in <agent-dir>/pi-github-app-auth.json (0600).",
    "",
    "Docs: https://github.com/tonyputi/pi-github-app-auth#setup",
].join("\n"));
export {};
