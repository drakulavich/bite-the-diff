# bite-the-diff

A GitHub Action for PRs that are too big to review. It counts a PR's changed lines against its base. Over a threshold, it posts one comment that says so and lists the ways to split the PR, so an agent or a person reading the PR needs nothing else installed. At the failing threshold, the job goes red.

## Usage

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

## What it does

With the default thresholds:

| Lines | Comment | Check run | Job |
|---|---|---|---|
| under 1000, no comment yet | none | none; an existing one becomes `success`, `bite-the-diff 40 lines` | green |
| under 1000, a comment exists | updated: now under the thresholds | as above | green |
| 1000 to 2999 | created or updated | `neutral`, `bite-the-diff 🟡 1240 lines` | green |
| 3000 to 4999 | created or updated | `neutral`, `bite-the-diff 🟠 3100 lines` | green |
| 5000 or more | created or updated, names the bypass label | `failure`, `bite-the-diff 🔴 5200 lines` | red |
| 5000 or more, with the bypass label | created or updated, says the label let it pass | `neutral`, `bite-the-diff 🟠 5200 lines` | green |

A PR has at most one comment from this action and a commit at most one check run. Later runs update them. Deleted lines count, and so does a removed file. A stacked PR's base is its parent, so each layer counts only its own diff.

To make the limit binding, require the job (`bite-the-diff` in the workflow above), which fails only at a `fail` threshold. The check run's name changes with the size, so it cannot be a required check.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `thresholds` | `1000:comment`, `3000:comment`, `5000:fail`, one per line | Lines and action per threshold |
| `exclude` | empty | Globs of paths left out of the count, one per line |
| `bypass-label` | `elefante` | A failed threshold passes when the PR has this label |
| `token` | `${{ github.token }}` | Needs `pull-requests: write` and `checks: write` |

Only the highest threshold reached applies: with `1000:fail` and `5000:comment`, 6000 lines only comment. The lowest `comment` threshold gets 🟡, every other soft status 🟠, and a `fail` without the label 🔴.

`GET /pulls/{n}/files` lists at most 3000 files. Above that, the count is the PR's total from the event, without `exclude`, and the comment says so.

## Outputs

| Output | Meaning |
|---|---|
| `lines` | Changed lines counted |
| `level` | The action of the threshold reached: `none`, `comment` or `fail`. A bypassed PR still reports `fail` |

## Limits

PRs from forks are not supported: their token is read-only, so there is no comment, and a fork PR over a `fail` threshold still fails its job, which can block a required check.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build   # dist/index.mjs is committed, and CI checks it is fresh
```

The code in `src/` runs on the runner's Node, so it uses only `node:*`, web APIs and bundled packages. `tsconfig.json` makes `Bun.*` in `src/` a type error.

## License

MIT
