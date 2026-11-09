# Spec: the self-test runs on a one-file source change

Tracking issue: [#26](https://github.com/drakulavich/bite-the-diff/issues/26).

## Objective

The `pr-size` job in `.github/workflows/ci.yml` decides whether `self-test` and `self-test-read-only` run. It leaves `dist/` out and asks for at least 2 changed lines in at least 2 files. The self-test steps leave `dist/` out the same way (`exclude: dist/**`). A PR that changes one source file, such as `src/core.ts`, together with its rebuilt `dist/index.mjs` counts as one file, so it skips both self-tests. Only `check` and `dist` run on a PR that changes the action's code.

Measured over the 19 merged PRs: 9 touched `src/`, `dist/` or `action.yml`, and none of them had a single non-`dist/` file. The gap has not let a bug through yet. It opens the first time someone fixes one line in `src/`.

Who gains: whoever merges a one-line fix to the action, who today gets green CI without the action ever running against a real PR.

## Design

`dist/` counts everywhere in CI. The `pr-size` gate counts every changed file and its lines, and the self-test steps drop `exclude: dist/**`, so the gate and the steps count the same thing. A source change always comes with its rebuilt `dist/index.mjs` (the `dist` job fails otherwise), so it is at least 2 files and, for a changed line, at least 2 lines (one added, one deleted). Every assertion then has the plural names and the 2 lines it needs, and none of them changes.

The `files-only` step compares the action's `files` output with `gh pr diff "$PR" --name-only | grep -vc '^dist/'`. That becomes `gh pr diff "$PR" --name-only | grep -c .`, which prints a bare number on any runner.

`exclude` stays covered by its unit tests (`exclude` appears on 15 lines of `src/core.test.ts` and 15 of `src/main.test.ts`). It loses its run against a real PR in CI.

Rejected:
- Rewrite the assertions for 1 file and 1 line (singular names, a `1:fail` that stays inside its 10% tolerance). It means more branches in `self-test-assert.sh` for a case that a counted `dist/` removes.
- Have the job add a throwaway second file. It needs a push to the PR branch from CI.
- Gate on paths (`src/`, `dist/`, `action.yml`). A one-line `action.yml` change is still one file and 2 lines, and the plural assertions fail on it.

## Commands

```
Check:  bun run check
Build:  bun run build
CI:     gh run watch <id> --exit-status
```

## Testing

CI is the test. Two throwaway PRs on branches of this repository, closed after their runs:
- one changes one line in `src/core.ts` and commits the rebuilt `dist/index.mjs`;
- one changes one line in `README.md`.

## Boundaries

- Always: the gate and the self-test steps count the same files.
- Ask first: any change to `self-test-assert.sh` or to the action's own code.
- Never: merge a throwaway PR.

## Out of scope

The action leaves well-known lock files out of its count, and the gate does not. A PR that changes `package.json` and `bun.lock` would pass the gate as 2 files and reach the self-test with 1 counted file. No such PR exists in this repository yet (no Dependabot PR so far); it gets its own issue.

## Definition of Done

- [ ] `grep -c 'exclude: dist/\*\*' .github/workflows/ci.yml` prints `0` (today `8`).
- [ ] The `pr-size` jq no longer selects on `dist/` (today line 46 does).
- [ ] On the `src/core.ts` throwaway PR, `self-test` and `self-test-read-only` run and pass: CI run linked in the PR.
- [ ] On the `README.md` throwaway PR, `pr-size` sets `big-enough=false`, both self-tests are skipped and the run is green: CI run linked in the PR.
- [ ] On the implementation PR itself, both self-tests run and pass.
