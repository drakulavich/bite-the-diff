#!/usr/bin/env bash
# usage: self-test-assert.sh <check name> <conclusion> <gh pr checks bucket> <text in the comment>
set -euo pipefail
name="$1" conclusion="$2" bucket="$3" text="$4"

# gh pr checks exits 8 while this job is still running.
checks=$(gh pr checks "$PR") || true
printf '%s\n' '--- gh pr checks' "$checks" '---'
printf '%s\n' "$checks" | grep -F "$name"$'\t'"$bucket"$'\t'

runs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100" \
  --jq '.check_runs[] | select(.name | startswith("bite-the-diff ")) | .name + "=" + .conclusion')
printf 'check runs: %s\n' "$runs"
test "$runs" = "$name=$conclusion"

bodies=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/comments?per_page=100" \
  --jq '.[] | select(.body | contains("<!-- bite-the-diff -->")) | .id')
printf 'marker comments: %s\n' "$bodies"
test "$(printf '%s\n' "$bodies" | wc -l)" -eq 1
gh api "repos/$GITHUB_REPOSITORY/issues/comments/$bodies" --jq .body | grep -F "$text"
