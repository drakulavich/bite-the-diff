#!/usr/bin/env bash
set -euo pipefail
name="$1" conclusion="$2" bucket="$3" text="${4-}"

read_runs() {
  if [ "$GITHUB_RUN_ATTEMPT" -gt 1 ]; then
    runs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100&filter=all" \
      --jq '.check_runs[] | select(.name | startswith("bite-the-diff ")) | .name + "=" + .conclusion' | sort -u)
  else
    checks=$(gh pr checks "$PR") || true
    runs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100" \
      --jq '.check_runs[] | select(.name | startswith("bite-the-diff ")) | .name + "=" + .conclusion')
  fi
}

# The REST check-runs list can return a check run's previous name for a few seconds after the action's PATCH.
settled() {
  [ "$runs" = "$name=$conclusion" ] &&
    { [ "$GITHUB_RUN_ATTEMPT" -gt 1 ] || printf '%s\n' "$checks" | grep -qF "$name"$'\t'"$bucket"$'\t'; }
}

read_runs
until settled || [ "$SECONDS" -ge 30 ]; do
  sleep 2
  read_runs
done

if [ "$GITHUB_RUN_ATTEMPT" -le 1 ]; then
  printf '%s\n' '--- gh pr checks' "$checks" '---'
  printf '%s\n' "$checks" | grep -F "$name"$'\t'"$bucket"$'\t'
fi
printf 'check runs after %ss: %s\n' "$SECONDS" "$runs"
test "$runs" = "$name=$conclusion"

bodies=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR/comments?per_page=100" \
  --jq '.[] | select(.body | contains("<!-- bite-the-diff -->")) | .id')
printf 'marker comments: %s\n' "$bodies"
if [ -z "$text" ]; then
  test -z "$bodies"
  exit 0
fi
test "$(printf '%s\n' "$bodies" | wc -l)" -eq 1
gh api "repos/$GITHUB_REPOSITORY/issues/comments/$bodies" --jq .body | grep -F "$text"
