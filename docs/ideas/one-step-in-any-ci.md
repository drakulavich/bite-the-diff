# bite-the-diff: one step in any CI

## Problem Statement

How might we make a PR size check that a repo adds with one line, with no settings and no separate file, while the advice still reaches both the person and the agent?

## Recommended Direction

The README's main way becomes one step in a workflow with `pull_request`. Known lock files are excluded by default, so `exclude` is needed only for a repo's own paths.

The action works with whatever permissions it gets. With write access it posts the comment and the check run. Without it, it writes the job summary and a warning, and both say which line to add. The bypass label takes effect on a re-run, because labels are read through `GET /pulls/{n}` and the check run of the attempt before is found with `filter=all`.

A separate workflow file with label events stays as the fallback, for a repo that wants the label to act without a re-run.

## Key Assumptions to Validate

- [x] With no `permissions` and a read-only token, the step counts and reports: temporary PR.
- [x] A re-run after a new label sees it: temporary PR.
- [x] Without `concurrency`, quick pushes do not create two comments: temporary PRs, 0 of 25 rounds.
- [x] The built-in list does not break the thresholds: recounted over real merged PRs.

## MVP Scope

In: the built-in list, a hint in the summary and the warning on a 403, labels from the API, a request timeout and retries, a README section. Released as v1.1.0, because the count changes.

Out: new inputs, a change to the check's name.

## Not Doing (and Why)

- A stable check name and a step that never fails: it breaks v1, so it is for v2.
- A bypass through a line in a commit message: the author would approve themselves.
- A composite action on `gh` and `jq`: threshold and glob logic is harder to test in shell.
- A GitHub App: its own hosting for a size check.
- `pull_request_target`: blocked by default in public repositories from 2026-12-02.

## Open Questions

- Whether the built-in list can be turned off. Current answer: no, until someone asks.
