# Contributing

`main` is protected: **changes land only through pull requests**. Direct pushes are rejected.

## Workflow

1. Create a branch from an up-to-date `main`:
   ```bash
   git checkout main && git pull
   git checkout -b feat/short-description
   ```
2. Commit locally, then push the branch:
   ```bash
   git push -u origin HEAD
   ```
3. Open a PR and merge it (squash, merge commit, or rebase are all allowed):
   ```bash
   gh pr create --title "…" --body "…"
   gh pr merge --squash
   ```

Force-pushes and deleting `main` are blocked. Approvals are not required (solo-friendly), but every change still goes through a PR for reviewable history.
## Releasing / versioning

Ship Marketplace + Open VSX updates from protected `main` via GitHub Actions:

1. Open a PR that bumps `version` in `package.json` (semver: patch for fixes, minor for features) along with your changes.
2. Merge the PR (direct pushes to `main` are blocked).
3. The **Publish Extension** workflow runs when `package.json` changes on `main`:
   - Builds the VSIX, publishes to Visual Studio Marketplace and Open VSX
   - Skips if that exact version is already on the Marketplace
   - Creates git tag `vX.Y.Z` after a successful publish
4. Manual re-run: **Actions → Publish Extension → Run workflow**
5. Never commit PATs — store them as repo Actions secrets `VSCE_PAT` and `OVSX_PAT`
