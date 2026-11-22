#!/usr/bin/env bash
set -euo pipefail
probe_list() { gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100$1" --jq '[.check_runs[] | select(.name | startswith("bite-the-diff ")) | "\(.id):\(.name)=\(.conclusion)"] | join(",")'; }
for i in $(seq 1 20); do
  printf 'probe %s want=%s latest=[%s] all=[%s] graphql=[%s]\n' "$(date -u +%T.%3N)" "$name" "$(probe_list '')" "$(probe_list '&filter=all')" \
    "$(gh pr checks "$PR" --json name --jq '[.[] | select(.name | startswith("bite-the-diff ")) | .name] | join(",")' || true)"
  sleep 0.5
done
name="$1" conclusion="$2" bucket="$3" text="${4-}"

if [ "$GITHUB_RUN_ATTEMPT" -gt 1 ]; then
  runs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100&filter=all" \
    --jq '.check_runs[] | select(.name | startswith("bite-the-diff ")) | .name + "=" + .conclusion' | sort -u)
else
  checks=$(gh pr checks "$PR") || true
  printf '%s\n' '--- gh pr checks' "$checks" '---'
  printf '%s\n' "$checks" | grep -F "$name"$'\t'"$bucket"$'\t'

  runs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/check-runs?per_page=100" \
    --jq '.check_runs[] | select(.name | startswith("bite-the-diff ")) | .name + "=" + .conclusion')
fi
printf 'check runs: %s\n' "$runs"
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
