<h1 align="center">bite-the-diff</h1>

<p align="center">
  <a href="https://github.com/drakulavich/bite-the-diff/actions/workflows/ci.yml"><img src="https://github.com/drakulavich/bite-the-diff/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node%2024-339933?logo=nodedotjs&logoColor=white" alt="Runtime: Node 24"></a>
</p>

<p align="center"><b>🐘 bite-the-diff tells your agent when a PR is too big to review, and how to cut it into bites.</b> This GitHub Action counts a PR's changed lines and files against its base. Over a threshold it posts one comment that says so and lists the ways to split the PR, so an agent or a person reading the PR needs nothing else installed.</p>

- **One comment**: updated in place on every run, with the ways to split the PR in a collapsed list
- **A soft status at 1000 and 3000 lines**: a `neutral` check run, and the job stays green
- **A red check from 5500 lines**: the `5000:fail` threshold plus its 10% tolerance
- **A comment on many files**: from 50 files, and it never fails the job
- **Stacks count per layer**: a stacked PR's base is its parent, so each layer counts only its own diff
- **`elefante` for the diff that cannot be cut**: with this label on the PR, a failed threshold passes

A PR of 5600 lines gets a red check run named `bite-the-diff 🔴 5600 lines` and this comment:

> 🔴 **5600 lines.** Too much elephant: this check stays red (threshold: 5000).
>
> Can't be cut? Add the label `elefante`.
>
> <details>
> <summary>🐘 Ways to cut it into bites</summary>
>
> - **Stack:** land a small change and base the next PR on it: `git switch -c`, `gh pr create --base <parent branch>`; rebase a child once its parent merges. For parts that depend on each other in sequence.
> - **By file group:** separate PRs for files that need different reviewers. For a change that cuts across areas.
> - **Horizontal:** shared code or stubs first, then what uses them. For layered code.
> - **Vertical:** smaller slices of the feature, each working end to end. For feature work.
> - **Refactoring apart:** refactoring in its own PR, before the behaviour change. For a PR that mixes the two.
> - **Leave it whole:** add the path to `exclude` or add the label `elefante`. For whole-file deletions, generated code and automated refactoring, where a reviewer only checks intent.
> </details>
>
> <sub>🐘 [bite-the-diff](https://github.com/drakulavich/bite-the-diff)</sub>

## Quick Start

Add one workflow file:

```yaml
# .github/workflows/bite-the-diff.yml
name: bite-the-diff
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]
concurrency:
  group: bite-the-diff-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  pull-requests: write
  checks: write
jobs:
  bite-the-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: drakulavich/bite-the-diff@v1
```

The action works from the API alone, so the job needs no checkout. `labeled` and `unlabeled` are in `types` so the check follows the bypass label. The `concurrency` block stops two runs racing to create the comment.

To make the limit binding, require the job (`bite-the-diff` in the workflow above), which fails only past a `fail` threshold's tolerance. The check run's name changes with the size, so it cannot be a required check.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `thresholds` | `1000:comment`, `3000:comment`, `5000:fail`, one per line | Lines and action per threshold. A `fail` threshold has a 10% tolerance: `5000:fail` goes red from 5500 |
| `file-threshold` | `50` | Files that get a comment, counted after `exclude`. It never fails the job and the bypass label has no effect on it. `0` turns it off |
| `exclude` | empty | Globs of paths left out of the count, one per line |
| `bypass-label` | `elefante` | A failed threshold passes when the PR has this label |
| `token` | `${{ github.token }}` | Needs `pull-requests: write` and `checks: write` |

Only the highest threshold reached applies: with `1000:fail` and `5000:comment`, 6000 lines only comment. The lowest `comment` threshold gets 🟡, every other soft status 🟠, and a `fail` without the label 🔴.

From a `fail` threshold up to 10% above it, rounded up, the PR is treated as `comment`: 🟠, a `neutral` check, a green job, and the bypass label has no effect. `comment` thresholds have no tolerance.

## Outputs

| Output | Meaning |
|---|---|
| `lines` | Changed lines counted |
| `level` | The action of the threshold reached: `none`, `comment` or `fail`. A bypassed PR still reports `fail`, a PR inside a `fail` threshold's tolerance `comment`. A PR that reached only the file threshold reports `comment` |
| `files` | Changed files counted |

## Outcomes

With the default thresholds:

| Lines | Comment | Check run | Job |
|---|---|---|---|
| under 1000, no comment yet | none | none; an existing one becomes `success`, `bite-the-diff 40 lines` | green |
| under 1000, a comment exists | updated: now under the thresholds | as above | green |
| 1000 to 2999 | created or updated | `neutral`, `bite-the-diff 🟡 1240 lines` | green |
| 3000 to 4999 | created or updated | `neutral`, `bite-the-diff 🟠 3100 lines` | green |
| 5000 to 5499 | created or updated, says where red starts | `neutral`, `bite-the-diff 🟠 5200 lines` | green |
| 5500 or more | created or updated, names the bypass label | `failure`, `bite-the-diff 🔴 5600 lines` | red |
| 5500 or more, with the bypass label | created or updated, says the label let it pass | `neutral`, `bite-the-diff 🟠 5600 lines` | green |

The default file threshold adds to that table:

| Files | Lines | Comment | Check run | Job |
|---|---|---|---|---|
| under 50 | any | as above, nothing about files | as above, nothing about files | as above |
| 50 or more | under 1000 | created or updated: `🟡 **63 files.** A lot of elephant to chew at once (threshold: 50).` | `neutral`, `bite-the-diff 🟡 63 files` | green |
| 50 or more | 1000 or more | as above for the lines, plus the line `Also 63 files (threshold: 50).` | as above for the lines, with the files in the name: `bite-the-diff 🟠 3100 lines, 63 files` | as above for the lines |

A PR has at most one comment from this action and a commit at most one check run. Later runs update them. Deleted lines count, and so does a removed file.

## Permissions

The job needs `pull-requests: write` for the comment and `checks: write` for the check run. If the token gets a 403 on either write, the action logs a warning and carries on, and a PR past a `fail` threshold's tolerance still fails its job.

## Limits

- **Forks**: PRs from forks are not supported. Their token is read-only, so there is no comment, and a fork PR over a `fail` threshold still fails its job, which can block a required check.
- **3000 files**: `GET /pulls/{n}/files` lists at most 3000 files. Above that, the line and file counts are the PR's totals from the event, without `exclude`, and the comment says so.

## Why it exists

You eat an elephant one bite at a time. Of 329 PRs on the author's machine, PRs of 500 to 999 lines averaged 4.5 review rounds, against 1.5 for PRs under 500. That is one person's measure, and the default thresholds start higher, at 1000 lines. Set `thresholds` lower if your reviews slow down sooner.

## Contributing

```sh
bun install
bun run check   # typecheck, lint and tests
bun run build   # writes dist/index.mjs
```

`dist/index.mjs` is committed, and CI rebuilds it and fails if it is not fresh. CI also runs the action on its own PR and checks the check run and the comment it leaves.

The code in `src/` runs on the runner's Node, so it uses only `node:*`, web APIs and bundled packages. `tsconfig.json` makes `Bun.*` in `src/` a type error.

## License

Made with 🐘 under [MIT License](LICENSE).
