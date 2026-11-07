import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recorded from "./fixtures/recorded.json";

export type FileSpec = { filename: string; additions: number; deletions: number };

const PR_NUMBER = 42;
export const HEAD_SHA = "aaaa1111";

type CheckOutput = { title: string; summary: string };
type WriteBody = { body: string; name: string; conclusion: string; head_sha: string; output: CheckOutput };

const PRELOAD = `
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  console.error("timeout " + ms);
  return realTimeout(Number(process.env.FAKE_TIMEOUT_MS));
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...rest) => {
  console.error("sleep " + ms);
  return realSetTimeout(callback, 0, ...rest);
};
`;

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function page<T>(items: T[], url: URL): T[] {
  const perPage = Number(url.searchParams.get("per_page"));
  const number = Number(url.searchParams.get("page"));
  return items.slice((number - 1) * perPage, number * perPage);
}

export class FakeGitHub {
  files: FileSpec[] = [];
  comments: { id: number; body: string }[] = [];
  checkRuns: { id: number; name: string; conclusion: string; head_sha: string }[] = [];
  checkOutputs: CheckOutput[] = [];
  requests: string[] = [];
  authorizations: (string | null)[] = [];
  forbid = new Set<"comments" | "check-runs">();
  earlierAttempt = new Set<number>();
  deletedElsewhere = new Set<number>();
  failWith: { route: string; status: number; times?: number } | null = null;
  hang: string | null = null;
  private nextId = 1000;
  private pull: { head: { sha: string } } & Record<string, unknown> = recorded.pull;
  private server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });

  stop() {
    this.server.stop(true);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname.replace("/repos/owner/repo", "")}`;
    this.requests.push(`${route}${url.search}`);
    this.authorizations.push(req.headers.get("authorization"));
    const body = (req.method === "GET" || req.method === "DELETE" ? null : await req.json()) as WriteBody;

    if (this.hang && route.startsWith(this.hang)) return new Promise<Response>(() => {});
    if (this.failWith && route.startsWith(this.failWith.route) && this.failWith.times !== 0) {
      if (this.failWith.times) this.failWith.times--;
      return jsonResponse(this.failWith.status, { message: "fake failure" });
    }
    if (route.includes("/comments") && req.method !== "GET" && this.forbid.has("comments"))
      return jsonResponse(403, req.method === "DELETE" ? recorded.deleteForbidden : recorded.commentForbidden);
    if (route.includes("/check-runs") && req.method !== "GET" && this.forbid.has("check-runs")) return jsonResponse(403, recorded.checkForbidden);

    if (route === `GET /pulls/${PR_NUMBER}`) return jsonResponse(200, this.pull);
    if (route === `GET /pulls/${PR_NUMBER}/files`) {
      const items = page(this.files, url).map((file) => ({ ...recorded.files[0], ...file, changes: file.additions + file.deletions }));
      return jsonResponse(200, items);
    }
    if (route === `GET /issues/${PR_NUMBER}/comments`) {
      return jsonResponse(
        200,
        page(this.comments, url).map((comment) => ({ ...recorded.comments[0], ...comment })),
      );
    }
    if (route === `POST /issues/${PR_NUMBER}/comments`) {
      const comment = { id: this.nextId++, body: body.body };
      this.comments.push(comment);
      return jsonResponse(201, { ...recorded.comments[0], ...comment });
    }
    const commentMatch = /^PATCH \/issues\/comments\/(\d+)$/.exec(route);
    if (commentMatch) {
      const comment = this.comments.find((c) => c.id === Number(commentMatch[1]))!;
      comment.body = body.body;
      return jsonResponse(200, { ...recorded.comments[0], ...comment });
    }
    const deleteMatch = /^DELETE \/issues\/comments\/(\d+)$/.exec(route);
    if (deleteMatch) {
      const id = Number(deleteMatch[1]);
      if (this.deletedElsewhere.has(id)) return jsonResponse(404, recorded.deleteGone);
      this.comments = this.comments.filter((c) => c.id !== id);
      return new Response(null, { status: recorded.deleteComment.status });
    }
    if (route === `GET /commits/${this.pull.head.sha}/check-runs`) {
      const listed = url.searchParams.get("filter") === "all" ? this.checkRuns : this.checkRuns.filter((run) => !this.earlierAttempt.has(run.id));
      const runs = page(listed, url).map((run) => ({ ...recorded.checkRun, ...run }));
      return jsonResponse(200, { total_count: listed.length, check_runs: runs });
    }
    if (route === "POST /check-runs") {
      const run = { id: this.nextId++, name: body.name, conclusion: body.conclusion, head_sha: body.head_sha };
      this.checkOutputs.push(body.output);
      this.checkRuns.push(run);
      return jsonResponse(201, { ...recorded.checkRun, ...run });
    }
    const checkMatch = /^PATCH \/check-runs\/(\d+)$/.exec(route);
    if (checkMatch) {
      const run = this.checkRuns.find((r) => r.id === Number(checkMatch[1]))!;
      run.name = body.name;
      run.conclusion = body.conclusion;
      this.checkOutputs.push(body.output);
      return jsonResponse(200, { ...recorded.checkRun, ...run });
    }
    return jsonResponse(404, { message: `fake has no route ${route}` });
  }

  async runAction(
    options: {
      prFields?: Record<string, unknown>;
      labels?: string[];
      inputs?: Record<string, string>;
      eventFile?: unknown;
      eventPr?: Record<string, unknown>;
      apiUrl?: string;
    } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "bite-the-diff-"));
    const paths = { event: join(dir, "event.json"), output: join(dir, "output"), summary: join(dir, "summary"), preload: join(dir, "preload.js") };
    const labels = options.labels ?? [];
    this.pull = {
      ...recorded.pull,
      number: PR_NUMBER,
      head: { ...recorded.pull.head, sha: HEAD_SHA },
      changed_files: this.files.length,
      labels: labels.map((name) => ({ ...recorded.pull.labels[0], name })),
      ...options.prFields,
    };
    const pullRequest = { ...recorded.event.pull_request, number: PR_NUMBER, ...options.eventPr };
    writeFileSync(paths.event, JSON.stringify(options.eventFile ?? { ...recorded.event, pull_request: pullRequest }));
    writeFileSync(paths.output, "");
    writeFileSync(paths.summary, "");
    writeFileSync(paths.preload, PRELOAD);

    const inputs = {
      thresholds: "1000:comment\n3000:comment\n5000:fail\n",
      "file-threshold": "50",
      exclude: "",
      "bypass-label": "elefante",
      token: "fake-token",
      ...options.inputs,
    };
    const proc = Bun.spawn(["bun", "--preload", paths.preload, "src/main.ts"], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: options.apiUrl ?? this.server.url.origin,
        FAKE_TIMEOUT_MS: this.hang ? "50" : "30000",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_SHA: "merge-commit-sha",
        GITHUB_EVENT_PATH: paths.event,
        GITHUB_OUTPUT: paths.output,
        GITHUB_STEP_SUMMARY: paths.summary,
        ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return {
      exitCode,
      stdout,
      stderr,
      output: readFileSync(paths.output, "utf8"),
      summary: readFileSync(paths.summary, "utf8"),
    };
  }
}
