import { appendFileSync, readFileSync } from 'node:fs';
import {
  CHECK_PREFIX,
  MARKER,
  MAX_LISTED_FILES,
  commentBody,
  countLines,
  decide,
  parseThresholds,
  underThresholdsBody,
  type Decision,
  type PrFile,
} from './core.ts';

type PullRequest = {
  number: number;
  changed_files: number;
  additions: number;
  deletions: number;
  labels: { name: string }[];
  head: { sha: string };
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    route: string,
  ) {
    super(`GitHub API ${route}: ${status}`);
  }
}

const input = (name: string) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const repoUrl = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}`;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${repoUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${input('token')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, `${method} ${path}`);
  return (await res.json()) as T;
}

async function* pages<T>(path: string, items: (page: any) => T[] = (page) => page) {
  for (let page = 1; ; page++) {
    const batch = items(await api('GET', `${path}?per_page=100&page=${page}`));
    yield* batch;
    if (batch.length < 100) return;
  }
}

async function findFirst<T>(all: AsyncIterable<T>, wanted: (item: T) => boolean): Promise<T | undefined> {
  for await (const item of all) if (wanted(item)) return item;
  return undefined;
}

async function updateComment(pr: PullRequest, decision: Decision, capped: boolean) {
  const existing = await findFirst(
    pages<{ id: number; body: string }>(`/issues/${pr.number}/comments`),
    (comment) => comment.body.includes(MARKER),
  );
  const body =
    decision.level === 'none'
      ? underThresholdsBody(decision.lines)
      : commentBody(decision, {
          bypassLabel: input('bypass-label'),
          cappedFiles: capped ? pr.changed_files : null,
        });
  if (existing) await api('PATCH', `/issues/comments/${existing.id}`, { body });
  else if (decision.level !== 'none') await api('POST', `/issues/${pr.number}/comments`, { body });
}

async function updateCheckRun(pr: PullRequest, decision: Decision) {
  const existing = await findFirst(
    pages<{ id: number; name: string }>(`/commits/${pr.head.sha}/check-runs`, (page) => page.check_runs),
    (run) => run.name.startsWith(CHECK_PREFIX),
  );
  const fields = {
    name: decision.checkName,
    status: 'completed',
    conclusion: decision.conclusion,
    output: { title: `${decision.lines} lines`, summary: `Threshold reached: ${decision.threshold ?? 'none'}.` },
  };
  if (existing) await api('PATCH', `/check-runs/${existing.id}`, fields);
  else if (decision.level !== 'none') await api('POST', '/check-runs', { ...fields, head_sha: pr.head.sha });
}

async function warnOn403(what: string, lines: number, write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 403)) throw error;
    console.log(`::warning::bite-the-diff could not write the ${what}: the token got a 403. This PR changes ${lines} lines.`);
  }
}

async function run() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const pr: PullRequest | undefined = event.pull_request;
  if (!pr) throw new Error('bite-the-diff runs on pull_request events');

  const thresholds = parseThresholds(input('thresholds'));
  const exclude = input('exclude').split('\n').map((glob) => glob.trim()).filter(Boolean);
  const capped = pr.changed_files > MAX_LISTED_FILES;
  const lines = capped
    ? pr.additions + pr.deletions
    : countLines(await Array.fromAsync(pages<PrFile>(`/pulls/${pr.number}/files`)), exclude);
  const decision = decide(lines, thresholds, pr.labels.some((label) => label.name === input('bypass-label')));

  appendFileSync(process.env.GITHUB_OUTPUT!, `lines=${lines}\nlevel=${decision.level}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `bite-the-diff: ${lines} lines, level ${decision.level}.\n`);

  await warnOn403('comment', lines, () => updateComment(pr, decision, capped));
  await warnOn403('check run', lines, () => updateCheckRun(pr, decision));

  if (decision.failsJob) {
    console.log(`::error::This PR changes ${lines} lines, past the failing threshold of ${decision.threshold}.`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.log(`::error::${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
