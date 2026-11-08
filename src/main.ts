import { appendFileSync, readFileSync } from "node:fs";
import {
  CHECK_PREFIX,
  commentBody,
  countFiles,
  countLines,
  type Decision,
  decide,
  MARKER,
  MAX_LISTED_FILES,
  type PrFile,
  parseFileThreshold,
  parseThresholds,
  plural,
  withFileThreshold,
} from "./core.ts";

type PullRequest = {
  number: number;
  changed_files: number;
  additions: number;
  deletions: number;
  labels: { name: string }[];
  head: { sha: string };
};

class ApiError extends Error {
  readonly transient: boolean;

  constructor(
    readonly status: number | null,
    route: string,
    detail: unknown = status,
  ) {
    super(`GitHub API ${route}: ${detail}`);
    this.transient = status === null || status === 429 || status >= 500;
  }
}

const TIMEOUT_MS = 30_000;
const RETRIES = 2;
const deadline = AbortSignal.timeout(120_000);

const input = (name: string) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
const repoUrl = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}`;

async function attempt<T>(method: string, path: string, body: unknown): Promise<T> {
  const route = `${method} ${path}`;
  let res: Response;
  try {
    res = await fetch(`${repoUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${input("token")}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), deadline]),
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  } catch (error) {
    throw new ApiError(null, route, deadline.aborted ? "the 2-minute limit was reached" : error instanceof Error ? error.message : error);
  }
  throw new ApiError(res.status, route);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let retry = 1; ; retry++) {
    try {
      return await attempt<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof ApiError && error.transient) || retry > RETRIES || deadline.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, retry * 1000));
    }
  }
}

async function* pages<T>(path: string, items: (page: T[] & { check_runs: T[] }) => T[] = (page) => page, query = "") {
  for (let page = 1; ; page++) {
    const batch = items(await api("GET", `${path}?per_page=100&page=${page}${query}`));
    yield* batch;
    if (batch.length < 100) return;
  }
}

async function findFirst<T>(all: AsyncIterable<T>, wanted: (item: T) => boolean): Promise<T | undefined> {
  for await (const item of all) if (wanted(item)) return item;
  return undefined;
}

const size = ({ lines, filesOver }: Decision) => (filesOver ? `${plural(lines, "line")}, ${plural(filesOver.files, "file")}` : plural(lines, "line"));

async function deleteComment(id: number) {
  try {
    await api("DELETE", `/issues/comments/${id}`);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

async function updateComment(pr: PullRequest, decision: Decision, capped: boolean) {
  const existing = await findFirst(pages<{ id: number; body: string }>(`/issues/${pr.number}/comments`), (comment) => comment.body.startsWith(MARKER));
  if (decision.level === "none") {
    if (existing) await deleteComment(existing.id);
    return;
  }
  const body = commentBody(decision, {
    bypassLabel: input("bypass-label"),
    cappedFiles: capped ? pr.changed_files : null,
  });
  if (existing) await api("PATCH", `/issues/comments/${existing.id}`, { body });
  else await api("POST", `/issues/${pr.number}/comments`, { body });
}

async function updateCheckRun(pr: PullRequest, decision: Decision) {
  // Without filter=all a re-run misses the check runs of earlier attempts, and GitHub restores one, red if it was red, when the re-run ends.
  const listed = await Array.fromAsync(pages<{ id: number; name: string }>(`/commits/${pr.head.sha}/check-runs`, (page) => page.check_runs, "&filter=all"));
  const existing = listed.filter((run) => run.name.startsWith(CHECK_PREFIX));
  const fields = {
    name: decision.checkName,
    status: "completed",
    conclusion: decision.conclusion,
    output: {
      title: size(decision),
      summary: `Threshold reached: ${decision.threshold ?? "none"}.${decision.filesOver ? ` File threshold reached: ${decision.filesOver.threshold}.` : ""}`,
    },
  };
  for (const run of existing) await api("PATCH", `/check-runs/${run.id}`, fields);
  if (existing.length === 0 && decision.level !== "none") await api("POST", "/check-runs", { ...fields, head_sha: pr.head.sha });
}

const report = (line: string) => appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `${line}\n`);

async function warnOnWriteFailure(what: string, permission: string, changed: string, write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 403 && !error.transient)) throw error;
    const reason = error.status === 403 ? `the token got a 403. Add \`${permission}\` to the job's permissions.` : `${error.message}.`;
    const problem = `bite-the-diff could not write the ${what}: ${reason}`;
    console.log(`::warning::${problem} This PR changes ${changed}.`);
    report(problem);
  }
}

async function readPull(number: number) {
  const pr = await api<PullRequest>("GET", `/pulls/${number}`);
  const capped = pr.changed_files > MAX_LISTED_FILES;
  return { pr, capped, listed: capped ? null : await Array.fromAsync(pages<PrFile>(`/pulls/${pr.number}/files`)) };
}

async function run() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  if (!event.pull_request) throw new Error("bite-the-diff runs on pull_request events");

  const thresholds = parseThresholds(input("thresholds"));
  const fileThreshold = parseFileThreshold(input("file-threshold"));
  const exclude = input("exclude")
    .split("\n")
    .map((glob) => glob.trim())
    .filter(Boolean);
  let pull: Awaited<ReturnType<typeof readPull>>;
  try {
    pull = await readPull(event.pull_request.number);
  } catch (error) {
    if (!(error instanceof ApiError && error.transient)) throw error;
    const problem = `bite-the-diff could not read the PR: ${error.message}. No count this run.`;
    console.log(`::warning::${problem}`);
    report(problem);
    return;
  }
  const { pr, capped, listed } = pull;
  const lines = listed ? countLines(listed, exclude) : pr.additions + pr.deletions;
  const files = listed ? countFiles(listed, exclude) : pr.changed_files;
  const decision = withFileThreshold(
    decide(
      lines,
      thresholds,
      pr.labels.some((label) => label.name === input("bypass-label")),
    ),
    files,
    fileThreshold,
  );

  appendFileSync(process.env.GITHUB_OUTPUT!, `lines=${lines}\nlevel=${decision.level}\nfiles=${files}\n`);
  report(`bite-the-diff: ${size(decision)}, level ${decision.level}.`);

  await warnOnWriteFailure("comment", "pull-requests: write", size(decision), () => updateComment(pr, decision, capped));
  await warnOnWriteFailure("check run", "checks: write", size(decision), () => updateCheckRun(pr, decision));

  if (decision.failsJob) {
    console.log(`::error::This PR changes ${plural(lines, "line")}, past the failing threshold of ${decision.threshold}.`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.log(`::error::${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
