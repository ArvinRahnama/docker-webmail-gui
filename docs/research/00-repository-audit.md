# Phase 0 — Repository Audit

**Date:** 2026-08-15
**Auditor:** Lead architect (orchestrator)
**Verdict:** **Greenfield.** No prior code, history, configuration, CI, or license exists. Treat as a clean-slate project.

---

## 1. Local working copy

| Property            | Finding                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Path                | `D:\Work\Docker Webmail GUI\src`                                                         |
| Is a git repository | Yes                                                                                      |
| Tracked files       | **0**                                                                                    |
| Untracked files     | **0** — working tree contains only `.git/`                                               |
| Commits             | **0** — `git log` reports _"your current branch 'origin' does not have any commits yet"_ |
| Local branches      | **None materialised** (`git branch -a` is empty; `HEAD` is an unborn ref)                |
| `HEAD`              | `ref: refs/heads/origin`                                                                 |
| Objects in store    | 1 — `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (the empty-tree object; not a commit)     |
| `.git/FETCH_HEAD`   | Empty — a fetch was attempted but returned nothing                                       |

## 2. Remote

| Property                              | Finding                                                  |
| ------------------------------------- | -------------------------------------------------------- |
| Remote name                           | `origin`                                                 |
| Fetch/push URL                        | `https://github.com/ArvinRahnama/docker-webmail-gui.git` |
| `git ls-remote --heads --tags origin` | **Returned zero refs, exit 0**                           |

Exit code 0 with no output means the remote repository **exists and is reachable, but is completely empty** — no branches, no tags, no default branch, no initial commit. Therefore:

- No existing README, LICENSE, CI workflows, Docker configuration, dependency manifests, or issue/PR templates.
- No existing git history to preserve, no branch protection to work around, no prior architecture to remain compatible with.
- No prior release, so **no backward-compatibility obligation** and we are free to define v0.1.0 as the first tagged release.

## 3. Finding: the local branch is misnamed `origin`

`HEAD` points at `refs/heads/origin`, i.e. the local **branch** is named `origin`, which is also the name of the **remote**. This is almost certainly unintended and is actively harmful:

- `git push origin origin` is ambiguous to read and invites mistakes.
- Refspecs like `origin/main` vs `origin` become confusing.
- The project's stated default branch is `main`.

**Resolution (safe — there are no commits to rewrite):** repoint the unborn HEAD before the first commit.

```sh
git symbolic-ref HEAD refs/heads/main
```

This is a metadata-only change on an unborn branch. It cannot lose data because no data exists. Applied during Phase 8 (repository foundation) as part of the initial commit.

## 4. Development host capability audit

The machine this work is being performed on is a **Windows development workstation**, not the Linux server the product targets. This materially constrains what can be verified locally.

| Tool              | Status                    | Consequence                                                |
| ----------------- | ------------------------- | ---------------------------------------------------------- |
| Node.js           | **v24.19.0** ✅           | Backend + frontend build and unit tests run locally        |
| npm               | **11.17.0** ✅            | npm workspaces available (no pnpm needed)                  |
| Python            | 3.14.7 ✅                 | Available for tooling scripts if ever needed (not planned) |
| pnpm              | ❌ not installed          | Use npm workspaces                                         |
| Go                | ❌ not installed          | Reinforces choosing a non-Go backend                       |
| **Docker**        | ❌ **not installed**      | **Cannot run Docker integration tests locally**            |
| Docker Compose    | ❌ not installed          | Cannot bring up the stack locally                          |
| WSL               | ❌ not installed          | No Linux userland available locally                        |
| GitHub CLI (`gh`) | ❌ not installed          | Repo/PR automation must use `git` over HTTPS               |
| Host OS           | Windows 11 Pro 10.0.26200 | Target OS is Linux; path/permission/UID semantics differ   |

### 4.1 Consequences for the verification strategy

This is the single most important operational finding of Phase 0, because the project brief requires **evidence that every feature works** and forbids fake functionality.

1. **A first-class mock/development mode is mandatory, not optional.** The brief already requires it (§57), but the absence of Docker here promotes it to a critical path dependency: without it, no Docker-touching code can be exercised at all during development. It must be the _default_ in development so the host daemon is never touched by accident — which also happens to be the correct security posture.

2. **The Docker controller must be built against an interface, with two implementations** — a real Engine API client and a deterministic in-memory fake seeded with realistic fixtures. Same for the mail-server integration (real `docker exec` vs. a fake driven by captured fixture output). This is required for testability regardless of the host, so it costs nothing extra.

3. **Docker integration tests and end-to-end tests execute in CI on Linux runners**, where a real `docker-mailserver` container can be started. GitHub Actions `ubuntu-latest` provides a working Docker daemon. CI — not this workstation — is the authority on integration correctness.

4. **Fixtures must be captured from a real system, not invented.** Any fixture representing real output (`postqueue -j`, Rspamd `/stat`, `doveadm quota get`, Docker `/containers/json`) must be traceable to documented real output or captured in CI from a live container. Fabricated fixtures would silently reintroduce the fake-feature problem one layer down. Each fixture file carries a provenance header stating its source.

5. **Anything that cannot be verified in CI must be labelled as such** in the final functional audit, with an explicit manual verification procedure — rather than being claimed as working.

### 4.2 What the user may want to change

Installing Docker Desktop on this workstation would let the full stack run locally and would substantially shorten the feedback loop for Phases 9–13. It is not a blocker — CI covers it — but it is the highest-value environment improvement available. Flagged for the user's decision; work proceeds either way.

## 5. Inputs carried into Phase 1

- Greenfield: all six planning documents are authored from scratch.
- No license inherited → the licence decision in `LICENSE_AUDIT.md` is unconstrained by prior obligation.
- No dependency manifests inherited → the dependency set is chosen fresh and audited before adoption.
- Target deployment (Linux + Docker) differs from the development host (Windows, no Docker) → design for testability first.
