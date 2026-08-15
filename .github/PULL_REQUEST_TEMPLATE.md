## Summary

<!-- What does this PR do, and why? -->

## Linked issue

<!-- "Closes #123", "Relates to #123", or "N/A" -->

## Type of change

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `chore` — tooling, dependencies, config
- [ ] `test` — tests only
- [ ] `refactor` — no behavior change

## Testing performed

<!--
What did you run, and how? Include the actual commands (e.g. `npm run check`,
`npm run test`). If this touches the broker or the Docker driver, note that
real-Docker integration coverage runs in CI on Linux — you don't need a local
Docker daemon to have tested this adequately.
-->

## Security checklist

Go through every item. If one doesn't apply to this change, say why rather
than leaving it unchecked with no explanation.

- [ ] No `sh -c` or shell string interpolation was introduced — all commands are argv arrays.
- [ ] No client-supplied path or container spec reaches the filesystem or the Docker API.
- [ ] No secret (password, private key, token, broker shared secret, session token) is logged, returned in an API response, or bundled into the frontend.
- [ ] Every new mutation is recorded in the audit log.
- [ ] Any new destructive operation is structurally gated (tiered confirmation, verified-backup requirement, allowlist) — not just warned about in the UI.
- [ ] No UI control ships without a real backing operation (see `FEATURE_MATRIX.md`).
- [ ] Any new or changed test fixture was captured from a real source, not invented.

## Notes for reviewers

<!-- Anything worth flagging: follow-ups, known limitations, alternatives considered. -->
