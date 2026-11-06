import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeGitHub, HEAD_SHA } from "./fake-github.ts";

const MARKER = "<!-- bite-the-diff -->";
const LABEL = "elefante";

let github: FakeGitHub;
beforeEach(() => {
  github = new FakeGitHub();
});
afterEach(() => github.stop());

const sized = (lines: number) => [{ filename: "src/a.ts", additions: lines, deletions: 0 }];
const posts = () => github.requests.filter((r) => r.startsWith("POST"));
const patches = () => github.requests.filter((r) => r.startsWith("PATCH"));
const deletes = () => github.requests.filter((r) => r.startsWith("DELETE"));

describe("the count", () => {
  test("sums every file over several pages, deletions included, into the lines output", async () => {
    github.files = Array.from({ length: 250 }, (_, i) => ({ filename: `f${i}.ts`, additions: 3, deletions: 1 }));
    const result = await github.runAction();
    expect(result.output).toBe("lines=1000\nlevel=comment\nfiles=250\n");
    expect(github.requests).toContain(`GET /pulls/42/files?per_page=100&page=3`);
  });

  test("exclude from the input leaves paths out", async () => {
    github.files = [
      { filename: "dist/index.mjs", additions: 6000, deletions: 0 },
      { filename: "src/a.ts", additions: 40, deletions: 2 },
    ];
    const result = await github.runAction({ inputs: { exclude: " dist/**\n\n*.lock\n" } });
    expect(result.output).toBe("lines=42\nlevel=none\nfiles=1\n");
    expect(result.exitCode).toBe(0);
  });

  test("over 3000 files, the count is the event totals, without exclude, and the comment says so", async () => {
    const result = await github.runAction({
      prFields: { changed_files: 3001, additions: 4400, deletions: 1200 },
      inputs: { exclude: "**" },
      labels: [LABEL],
    });
    expect(result.output).toBe("lines=5600\nlevel=fail\nfiles=3001\n");
    expect(github.requests.some((r) => r.includes("/files"))).toBe(false);
    expect(github.comments[0]!.body).toContain("This PR has 3001 changed files and the API lists 3000");
  });

  test("at exactly 3000 files, it still lists them", async () => {
    github.files = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }));
    const result = await github.runAction({ prFields: { additions: 9999, deletions: 0 } });
    expect(result.output).toBe("lines=3000\nlevel=comment\nfiles=3000\n");
  });
});

describe("the outcomes table at each boundary, on a PR with nothing from this action yet", () => {
  const rows = [
    { lines: 999, level: "none", comment: null, check: null, exitCode: 0 },
    {
      lines: 1000,
      level: "comment",
      comment: "🟡 **1000 lines.** That's a lot of elephant for one bite (threshold: 1000).",
      check: ["bite-the-diff 🟡 1000 lines", "neutral"],
      exitCode: 0,
    },
    {
      lines: 2999,
      level: "comment",
      comment: "🟡 **2999 lines.** That's a lot of elephant for one bite (threshold: 1000).",
      check: ["bite-the-diff 🟡 2999 lines", "neutral"],
      exitCode: 0,
    },
    {
      lines: 3000,
      level: "comment",
      comment: "🟠 **3000 lines.** Bigger than one bite should be (threshold: 3000).",
      check: ["bite-the-diff 🟠 3000 lines", "neutral"],
      exitCode: 0,
    },
    {
      lines: 4999,
      level: "comment",
      comment: "🟠 **4999 lines.** Bigger than one bite should be (threshold: 3000).",
      check: ["bite-the-diff 🟠 4999 lines", "neutral"],
      exitCode: 0,
    },
    {
      lines: 5000,
      level: "comment",
      comment: "🟠 **5000 lines.** Almost too much elephant: red from 5500 (threshold: 5000).",
      check: ["bite-the-diff 🟠 5000 lines", "neutral"],
      exitCode: 0,
    },
    {
      lines: 5499,
      level: "comment",
      comment: "🟠 **5499 lines.** Almost too much elephant: red from 5500 (threshold: 5000).",
      check: ["bite-the-diff 🟠 5499 lines", "neutral"],
      exitCode: 0,
    },
    {
      lines: 5500,
      level: "fail",
      comment: `🔴 **5500 lines.** Too much elephant: this check stays red (threshold: 5000).\n\nCan't be cut? Add the label \`${LABEL}\`.`,
      check: ["bite-the-diff 🔴 5500 lines", "failure"],
      exitCode: 1,
    },
  ];

  for (const row of rows) {
    test(`${row.lines} lines`, async () => {
      github.files = sized(row.lines);
      const result = await github.runAction();
      expect(result.exitCode).toBe(row.exitCode);
      expect(result.output).toBe(`lines=${row.lines}\nlevel=${row.level}\nfiles=1\n`);
      expect(result.summary).toBe(`bite-the-diff: ${row.lines} lines, level ${row.level}.\n`);
      if (row.comment) {
        expect(github.comments).toHaveLength(1);
        expect(github.comments[0]!.body).toContain(row.comment);
      } else {
        expect(github.comments).toEqual([]);
      }
      expect(github.checkRuns.map((run) => [run.name, run.conclusion])).toEqual(row.check ? [row.check] : []);
    });
  }

  test("a failure writes ::error with the count", async () => {
    github.files = sized(5600);
    const result = await github.runAction();
    expect(result.stdout).toContain("::error::This PR changes 5600 lines, past the failing threshold of 5000.");
  });

  test("5500 with the bypass label: comment says so, check is neutral orange, job green", async () => {
    github.files = sized(5500);
    const result = await github.runAction({ labels: [LABEL] });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("lines=5500\nlevel=fail\nfiles=1\n");
    expect(github.comments[0]!.body).toContain(`🐘 **5500 lines.** The \`${LABEL}\` label let this one through whole.`);
    expect(github.checkRuns.map((run) => [run.name, run.conclusion])).toEqual([["bite-the-diff 🟠 5500 lines", "neutral"]]);
  });

  test("some other label does not bypass", async () => {
    github.files = sized(5500);
    const result = await github.runAction({ labels: ["docs"] });
    expect(result.exitCode).toBe(1);
  });

  test("the bypass-label input names the label", async () => {
    github.files = sized(5500);
    const result = await github.runAction({ labels: ["big-ok"], inputs: { "bypass-label": "big-ok" } });
    expect(result.exitCode).toBe(0);
    expect(github.comments[0]!.body).toContain("The `big-ok` label let this one through whole.");
  });

  test("inside the tolerance the bypass label has no effect and is not mentioned", async () => {
    github.files = sized(5200);
    const result = await github.runAction({ labels: [LABEL] });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("lines=5200\nlevel=comment\nfiles=1\n");
    expect(github.comments[0]!.body).toContain("🟠 **5200 lines.** Almost too much elephant: red from 5500 (threshold: 5000).");
    expect(github.comments[0]!.body).not.toContain(LABEL);
    expect(github.checkRuns.map((run) => [run.name, run.conclusion])).toEqual([["bite-the-diff 🟠 5200 lines", "neutral"]]);
  });

  test("a custom fail threshold goes red only past its tolerance", async () => {
    github.files = sized(1357);
    const inside = await github.runAction({ inputs: { thresholds: "1234:fail" } });
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toBe("lines=1357\nlevel=comment\nfiles=1\n");
    expect(github.comments[0]!.body).toContain("🟠 **1357 lines.** Almost too much elephant: red from 1358 (threshold: 1234).");
    github.files = sized(1358);
    const past = await github.runAction({ inputs: { thresholds: "1234:fail" } });
    expect(past.exitCode).toBe(1);
    expect(past.output).toContain("lines=1358\nlevel=fail\n");
  });

  test("the thresholds input applies", async () => {
    github.files = sized(6);
    const result = await github.runAction({ inputs: { thresholds: "5:fail" } });
    expect(result.output).toBe("lines=6\nlevel=fail\nfiles=1\n");
    expect(result.exitCode).toBe(1);
  });
});

describe("dropping under the thresholds", () => {
  test("the marker comment is deleted, another comment stays, and an existing check run turns success", async () => {
    github.comments = [{ id: 7, body: "looks big" }];
    github.files = sized(5600);
    await github.runAction();
    const { id } = github.comments[1]!;
    github.files = sized(40);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(deletes()).toEqual([`DELETE /issues/comments/${id}`]);
    expect(github.comments).toEqual([{ id: 7, body: "looks big" }]);
    expect(patches().filter((r) => r.includes("/issues/"))).toEqual([]);
    expect(github.checkRuns.map((run) => [run.name, run.conclusion])).toEqual([["bite-the-diff 40 lines", "success"]]);
    expect(github.checkOutputs.at(-1)).toEqual({ title: "40 lines", summary: "Threshold reached: none." });
  });

  test("no marker comment: nothing is deleted or written", async () => {
    github.comments = [{ id: 7, body: "looks big" }];
    github.files = sized(40);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(github.requests).toEqual([
      "GET /pulls/42/files?per_page=100&page=1",
      "GET /issues/42/comments?per_page=100&page=1",
      `GET /commits/${HEAD_SHA}/check-runs?per_page=100&page=1`,
    ]);
    expect(github.comments).toEqual([{ id: 7, body: "looks big" }]);
  });

  test("a comment someone else already removed: a 404 on the delete is done, with no warning", async () => {
    github.comments = [{ id: 500, body: `${MARKER}\nold` }];
    github.deletedElsewhere.add(500);
    github.checkRuns = [{ id: 7, name: "bite-the-diff 🟡 1240 lines", conclusion: "neutral", head_sha: HEAD_SHA }];
    github.files = sized(40);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(deletes()).toEqual(["DELETE /issues/comments/500"]);
    expect(github.checkRuns).toEqual([{ id: 7, name: "bite-the-diff 40 lines", conclusion: "success", head_sha: HEAD_SHA }]);
  });

  test("a 403 on the delete warns, keeps the summary, and the check run still turns success", async () => {
    github.comments = [{ id: 500, body: `${MARKER}\nold` }];
    github.checkRuns = [{ id: 7, name: "bite-the-diff 🟡 1240 lines", conclusion: "neutral", head_sha: HEAD_SHA }];
    github.forbid.add("comments");
    github.files = sized(40);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("::warning::bite-the-diff could not write the comment: the token got a 403. This PR changes 40 lines.\n");
    expect(result.summary).toBe("bite-the-diff: 40 lines, level none.\n");
    expect(github.comments).toEqual([{ id: 500, body: `${MARKER}\nold` }]);
    expect(github.checkRuns).toEqual([{ id: 7, name: "bite-the-diff 40 lines", conclusion: "success", head_sha: HEAD_SHA }]);
  });

  test("any other error on the delete fails the run with its status", async () => {
    github.comments = [{ id: 500, body: `${MARKER}\nold` }];
    github.failWith = { route: "DELETE /issues/comments", status: 500 };
    github.files = sized(40);
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("::error::GitHub API DELETE /issues/comments/500: 500\n");
    expect(result.summary).toBe("bite-the-diff: 40 lines, level none.\n");
  });

  test("rising again after the delete creates a new comment", async () => {
    github.files = sized(1240);
    await github.runAction();
    const first = github.comments[0]!.id;
    github.files = sized(40);
    await github.runAction();
    expect(github.comments).toEqual([]);
    github.files = sized(1300);
    await github.runAction();
    expect(posts().filter((r) => r === "POST /issues/42/comments")).toHaveLength(2);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.id).not.toBe(first);
    expect(github.comments[0]!.body).toContain("🟡 **1300 lines.** That's a lot of elephant for one bite (threshold: 1000).");
  });

  test("a check run with no comment still turns success, and no comment appears", async () => {
    github.files = sized(40);
    github.checkRuns = [{ id: 7, name: "bite-the-diff 🟡 1240 lines", conclusion: "neutral", head_sha: HEAD_SHA }];
    await github.runAction();
    expect(github.comments).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(github.checkRuns).toEqual([{ id: 7, name: "bite-the-diff 40 lines", conclusion: "success", head_sha: HEAD_SHA }]);
  });
});

describe("one line, one file", () => {
  const WAYS_START = "\n\n<details>";

  test("under the thresholds: the summary and the check run say 1 line", async () => {
    github.checkRuns = [{ id: 7, name: "bite-the-diff 🟡 1240 lines", conclusion: "neutral", head_sha: HEAD_SHA }];
    github.files = sized(1);
    const result = await github.runAction();
    expect(result.summary).toBe("bite-the-diff: 1 line, level none.\n");
    expect(github.checkRuns[0]!.name).toBe("bite-the-diff 1 line");
    expect(github.checkOutputs).toEqual([{ title: "1 line", summary: "Threshold reached: none." }]);
  });

  test("both reached: the headline, the Also line, the check run and the summary", async () => {
    github.files = sized(1);
    const result = await github.runAction({ inputs: { thresholds: "1:comment", "file-threshold": "1" } });
    expect(result.summary).toBe("bite-the-diff: 1 line, 1 file, level comment.\n");
    expect(
      github.comments[0]!.body.startsWith(
        `${MARKER}\n🟡 **1 line.** That's a lot of elephant for one bite (threshold: 1).\nAlso 1 file (threshold: 1).${WAYS_START}`,
      ),
    ).toBe(true);
    expect(github.checkRuns[0]!.name).toBe("bite-the-diff 🟡 1 line, 1 file");
    expect(github.checkOutputs).toEqual([{ title: "1 line, 1 file", summary: "Threshold reached: 1. File threshold reached: 1." }]);
  });

  test("only the file threshold reached: the headline and the check run say 1 file", async () => {
    github.files = sized(5);
    const result = await github.runAction({ inputs: { "file-threshold": "1" } });
    expect(result.summary).toBe("bite-the-diff: 5 lines, 1 file, level comment.\n");
    expect(github.comments[0]!.body.startsWith(`${MARKER}\n🟡 **1 file.** A lot of elephant to chew at once (threshold: 1).${WAYS_START}`)).toBe(true);
    expect(github.checkRuns[0]!.name).toBe("bite-the-diff 🟡 1 file");
  });

  test("2 lines and 2 files stay plural", async () => {
    github.files = [
      { filename: "src/a.ts", additions: 1, deletions: 0 },
      { filename: "src/b.ts", additions: 1, deletions: 0 },
    ];
    const result = await github.runAction({ inputs: { thresholds: "2:comment", "file-threshold": "2" } });
    expect(result.summary).toBe("bite-the-diff: 2 lines, 2 files, level comment.\n");
    expect(
      github.comments[0]!.body.startsWith(
        `${MARKER}\n🟡 **2 lines.** That's a lot of elephant for one bite (threshold: 2).\nAlso 2 files (threshold: 2).${WAYS_START}`,
      ),
    ).toBe(true);
    expect(github.checkRuns[0]!.name).toBe("bite-the-diff 🟡 2 lines, 2 files");
  });

  test("the warning and the error say 1 line", async () => {
    github.forbid.add("comments");
    github.forbid.add("check-runs");
    github.files = sized(1);
    const result = await github.runAction({ inputs: { thresholds: "0:fail" } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::warning::bite-the-diff could not write the comment: the token got a 403. This PR changes 1 line.");
    expect(result.stdout).toContain("::error::This PR changes 1 line, past the failing threshold of 0.");
  });
});

describe("a person's comment that contains the marker", () => {
  const quoted = { id: 7, body: `Why does the action leave ${MARKER} in its text?` };

  test("over a threshold: it stays untouched and a new comment is created", async () => {
    github.comments = [quoted];
    github.files = sized(1240);
    await github.runAction();
    expect(github.comments[0]).toEqual({ id: 7, body: `Why does the action leave ${MARKER} in its text?` });
    expect(github.comments).toHaveLength(2);
    expect(github.comments[1]!.body).toContain("🟡 **1240 lines.**");
    expect(patches()).toEqual([]);
    expect(posts()).toContain("POST /issues/42/comments");
  });

  test("under the thresholds: it is not deleted", async () => {
    github.comments = [quoted];
    github.files = sized(40);
    await github.runAction();
    expect(deletes()).toEqual([]);
    expect(github.comments).toEqual([{ id: 7, body: `Why does the action leave ${MARKER} in its text?` }]);
  });
});

describe("at most one comment", () => {
  test("a marker comment past the first page is updated, not duplicated", async () => {
    github.comments = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, body: `chat ${i}` }));
    github.comments.push({ id: 500, body: `${MARKER}\nold` });
    github.files = sized(1240);
    await github.runAction();
    expect(github.comments).toHaveLength(131);
    expect(github.comments.at(-1)!.body).toContain("🟡 **1240 lines.**");
    expect(github.comments[0]!.body).toBe("chat 0");
    expect(github.requests).toContain("GET /issues/42/comments?per_page=100&page=2");
    expect(posts()).toEqual(["POST /check-runs"]);
  });

  test("a second run updates the comment with the new count", async () => {
    github.files = sized(1240);
    await github.runAction();
    github.files = sized(3100);
    await github.runAction();
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain("🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).");
    expect(github.comments[0]!.body.startsWith(MARKER)).toBe(true);
  });
});

describe("at most one check run per commit", () => {
  test("a repeated run updates its check run instead of adding one", async () => {
    github.files = sized(1240);
    await github.runAction();
    const { id } = github.checkRuns[0]!;
    await github.runAction();
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]!.id).toBe(id);
    expect(posts().filter((r) => r === "POST /check-runs")).toHaveLength(1);
    expect(patches()).toContain(`PATCH /check-runs/${id}`);
  });

  test("removing the bypass label turns the same check run from neutral to failure", async () => {
    github.files = sized(5600);
    await github.runAction({ labels: [LABEL] });
    const { id, conclusion } = github.checkRuns[0]!;
    expect(conclusion).toBe("neutral");
    const result = await github.runAction({ labels: [] });
    expect(result.exitCode).toBe(1);
    expect(github.checkRuns).toEqual([{ id, name: "bite-the-diff 🔴 5600 lines", conclusion: "failure", head_sha: HEAD_SHA }]);
  });

  test("uses the head sha of the event, not GITHUB_SHA", async () => {
    github.files = sized(1240);
    await github.runAction();
    expect(github.requests).toContain(`GET /commits/${HEAD_SHA}/check-runs?per_page=100&page=1`);
    expect(github.checkRuns[0]!.head_sha).toBe(HEAD_SHA);
  });

  test("another job's check run is left alone, even one named bite-the-diff", async () => {
    github.checkRuns = [
      { id: 1, name: "bite-the-diff", conclusion: "success", head_sha: HEAD_SHA },
      { id: 2, name: "ci", conclusion: "success", head_sha: HEAD_SHA },
    ];
    github.files = sized(1240);
    await github.runAction();
    expect(github.checkRuns.map((run) => run.name)).toEqual(["bite-the-diff", "ci", "bite-the-diff 🟡 1240 lines"]);
  });

  test("its check run is found past the first page", async () => {
    github.checkRuns = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `job ${i}`, conclusion: "success", head_sha: HEAD_SHA }));
    github.checkRuns.push({ id: 900, name: "bite-the-diff 🟡 1240 lines", conclusion: "neutral", head_sha: HEAD_SHA });
    github.files = sized(3100);
    await github.runAction();
    expect(github.checkRuns).toHaveLength(121);
    expect(github.checkRuns.at(-1)!.name).toBe("bite-the-diff 🟠 3100 lines");
  });
});

describe("API failures", () => {
  test("a 403 on the comment warns, still writes the check run, and the job stays green", async () => {
    github.forbid.add("comments");
    github.files = sized(1240);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::bite-the-diff could not write the comment: the token got a 403. This PR changes 1240 lines.");
    expect(result.summary).toContain("1240 lines");
    expect(github.checkRuns).toHaveLength(1);
  });

  test("a 403 on the check run warns and the job stays green", async () => {
    github.forbid.add("check-runs");
    github.files = sized(1240);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::bite-the-diff could not write the check run: the token got a 403. This PR changes 1240 lines.");
    expect(github.comments).toHaveLength(1);
  });

  test("a read-only token at a fail threshold still fails the job", async () => {
    github.forbid.add("comments");
    github.forbid.add("check-runs");
    github.files = sized(5600);
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error::This PR changes 5600 lines");
    expect(result.summary).toContain("5600 lines");
  });

  test("any other error on the comment fails the run with its status", async () => {
    github.failWith = { route: "POST /issues", status: 500 };
    github.files = sized(1240);
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error::GitHub API POST /issues/42/comments: 500");
    expect(result.summary).toContain("1240 lines");
  });

  test("a 403 on listing the files fails the run", async () => {
    github.failWith = { route: "GET /pulls", status: 403 };
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error::GitHub API GET /pulls/42/files?per_page=100&page=1: 403");
  });
});

describe("file-threshold", () => {
  const WAYS = [
    "<details>",
    "<summary>🐘 Ways to cut it into bites</summary>",
    "",
    "- **Stack:** land a small change and base the next PR on it: `git switch -c`, `gh pr create --base <parent branch>`. When the parent merges, retarget and rebase the child before deleting the parent's branch: deleting it first closes the child. For parts that depend on each other in sequence.",
    "- **By file group:** separate PRs for files that need different reviewers. For a change that cuts across areas.",
    "- **Horizontal:** shared code or stubs first, then what uses them. For layered code.",
    "- **Vertical:** smaller slices of the feature, each working end to end. For feature work.",
    "- **Refactoring apart:** refactoring in its own PR, before the behaviour change. For a PR that mixes the two.",
    "- **Leave it whole:** add the path to `exclude`. For whole-file deletions, generated code and automated refactoring, where a reviewer only checks intent.",
    "</details>",
    "",
    "<sub>🐘 [bite-the-diff](https://github.com/drakulavich/bite-the-diff)</sub>",
    "",
  ].join("\n");
  const generated = Array.from({ length: 10 }, (_, i) => ({ filename: `dist/g${i}.mjs`, additions: 1, deletions: 0 }));
  const spread = (files: number, lines: number) =>
    Array.from({ length: files }, (_, i) => ({ filename: `src/f${i}.ts`, additions: i === 0 ? lines - files + 1 : 1, deletions: 0 }));
  const checks = () => github.checkRuns.map((run) => [run.name, run.conclusion]);

  test("49 files counted after exclude: nothing is written, though 59 changed", async () => {
    github.files = [...spread(49, 49), ...generated];
    const result = await github.runAction({ inputs: { exclude: "dist/**" } });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("lines=49\nlevel=none\nfiles=49\n");
    expect(result.summary).toBe("bite-the-diff: 49 lines, level none.\n");
    expect(github.comments).toEqual([]);
    expect(github.checkRuns).toEqual([]);
  });

  test("50 files counted after exclude: only files reached", async () => {
    github.files = [...spread(50, 50), ...generated];
    const result = await github.runAction({ inputs: { exclude: "dist/**" } });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("lines=50\nlevel=comment\nfiles=50\n");
    expect(result.summary).toBe("bite-the-diff: 50 lines, 50 files, level comment.\n");
    expect(github.comments.map((c) => c.body)).toEqual([`${MARKER}\n🟡 **50 files.** A lot of elephant to chew at once (threshold: 50).\n\n${WAYS}`]);
    expect(checks()).toEqual([["bite-the-diff 🟡 50 files", "neutral"]]);
    expect(github.checkOutputs).toEqual([{ title: "50 lines, 50 files", summary: "Threshold reached: none. File threshold reached: 50." }]);
  });

  test("the input sets the threshold", async () => {
    github.files = spread(2, 2);
    expect((await github.runAction({ inputs: { "file-threshold": "3" } })).output).toBe("lines=2\nlevel=none\nfiles=2\n");
    github.files = spread(3, 3);
    await github.runAction({ inputs: { "file-threshold": "3" } });
    expect(checks()).toEqual([["bite-the-diff 🟡 3 files", "neutral"]]);
    expect(github.comments[0]!.body).toContain("🟡 **3 files.** A lot of elephant to chew at once (threshold: 3).");
  });

  test("0 turns it off, and the output still counts", async () => {
    github.files = spread(63, 63);
    const result = await github.runAction({ inputs: { "file-threshold": "0" } });
    expect(result.output).toBe("lines=63\nlevel=none\nfiles=63\n");
    expect(github.comments).toEqual([]);
    expect(github.checkRuns).toEqual([]);
  });

  for (const bad of ["-1", "1.5", "many", "50 files", "1e3", ""]) {
    test(`rejects "${bad}" before any API call`, async () => {
      github.files = spread(63, 63);
      const result = await github.runAction({ inputs: { "file-threshold": bad } });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(`::error::Bad file-threshold: ${bad}`);
      expect(result.output).toBe("");
      expect(github.requests).toEqual([]);
    });
  }

  test("the bypass label has no effect when only files are reached", async () => {
    github.files = spread(63, 63);
    const result = await github.runAction({ labels: [LABEL] });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("lines=63\nlevel=comment\nfiles=63\n");
    expect(github.comments.map((c) => c.body)).toEqual([`${MARKER}\n🟡 **63 files.** A lot of elephant to chew at once (threshold: 50).\n\n${WAYS}`]);
    expect(checks()).toEqual([["bite-the-diff 🟡 63 files", "neutral"]]);
  });

  describe("a line threshold reached too: the lines state decides, and the name and comment gain the files", () => {
    const rows = [
      {
        lines: 1240,
        labels: [],
        level: "comment",
        exitCode: 0,
        check: ["bite-the-diff 🟡 1240 lines, 63 files", "neutral"],
        comment: "🟡 **1240 lines.** That's a lot of elephant for one bite (threshold: 1000).\nAlso 63 files (threshold: 50).\n\n<details>",
        title: "Threshold reached: 1000. File threshold reached: 50.",
      },
      {
        lines: 3100,
        labels: [],
        level: "comment",
        exitCode: 0,
        check: ["bite-the-diff 🟠 3100 lines, 63 files", "neutral"],
        comment: "🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).\nAlso 63 files (threshold: 50).\n\n<details>",
        title: "Threshold reached: 3000. File threshold reached: 50.",
      },
      {
        lines: 5200,
        labels: [],
        level: "comment",
        exitCode: 0,
        check: ["bite-the-diff 🟠 5200 lines, 63 files", "neutral"],
        comment: "🟠 **5200 lines.** Almost too much elephant: red from 5500 (threshold: 5000).\nAlso 63 files (threshold: 50).\n\n<details>",
        title: "Threshold reached: 5000. File threshold reached: 50.",
      },
      {
        lines: 5600,
        labels: [],
        level: "fail",
        exitCode: 1,
        check: ["bite-the-diff 🔴 5600 lines, 63 files", "failure"],
        comment: `🔴 **5600 lines.** Too much elephant: this check stays red (threshold: 5000).\nAlso 63 files (threshold: 50).\n\nCan't be cut? Add the label \`${LABEL}\`.\n\n<details>`,
        title: "Threshold reached: 5000. File threshold reached: 50.",
      },
      {
        lines: 5600,
        labels: [LABEL],
        level: "fail",
        exitCode: 0,
        check: ["bite-the-diff 🟠 5600 lines, 63 files", "neutral"],
        comment: `🐘 **5600 lines.** The \`${LABEL}\` label let this one through whole.\nAlso 63 files (threshold: 50).\n\n<details>`,
        title: "Threshold reached: 5000. File threshold reached: 50.",
      },
    ];

    for (const row of rows) {
      test(`${row.lines} lines, labels [${row.labels}]`, async () => {
        github.files = spread(63, row.lines);
        const result = await github.runAction({ labels: row.labels });
        expect(result.exitCode).toBe(row.exitCode);
        expect(result.output).toBe(`lines=${row.lines}\nlevel=${row.level}\nfiles=63\n`);
        expect(result.summary).toBe(`bite-the-diff: ${row.lines} lines, 63 files, level ${row.level}.\n`);
        expect(checks()).toEqual([row.check]);
        expect(github.checkOutputs).toEqual([{ title: `${row.lines} lines, 63 files`, summary: row.title }]);
        expect(github.comments).toHaveLength(1);
        expect(github.comments[0]!.body.startsWith(`${MARKER}\n${row.comment}`)).toBe(true);
      });
    }
  });

  test("over the listing cap, only files reached: the event's changed_files, and the comment says so", async () => {
    const result = await github.runAction({ prFields: { changed_files: 3001, additions: 30, deletions: 10 }, inputs: { exclude: "**" } });
    expect(result.output).toBe("lines=40\nlevel=comment\nfiles=3001\n");
    expect(github.requests.some((r) => r.includes("/files"))).toBe(false);
    expect(checks()).toEqual([["bite-the-diff 🟡 3001 files", "neutral"]]);
    expect(github.comments[0]!.body).toBe(
      `${MARKER}\n🟡 **3001 files.** A lot of elephant to chew at once (threshold: 50).\n\nThis PR has 3001 changed files and the API lists 3000, so the count is the PR total and \`exclude\` was not applied.\n\n${WAYS}`,
    );
  });

  test("over the listing cap, with a line threshold reached too", async () => {
    const result = await github.runAction({ prFields: { changed_files: 3001, additions: 3000, deletions: 100 } });
    expect(result.output).toBe("lines=3100\nlevel=comment\nfiles=3001\n");
    expect(checks()).toEqual([["bite-the-diff 🟠 3100 lines, 3001 files", "neutral"]]);
    expect(github.comments[0]!.body).toBe(
      `${MARKER}\n🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).\nAlso 3001 files (threshold: 50).\n\nThis PR has 3001 changed files and the API lists 3000, so the count is the PR total and \`exclude\` was not applied.\n\n${WAYS}`,
    );
  });

  test("files under the threshold: today's text, byte for byte", async () => {
    github.files = spread(49, 1240);
    const result = await github.runAction();
    expect(result.summary).toBe("bite-the-diff: 1240 lines, level comment.\n");
    expect(github.comments.map((c) => c.body)).toEqual([`${MARKER}\n🟡 **1240 lines.** That's a lot of elephant for one bite (threshold: 1000).\n\n${WAYS}`]);
    expect(checks()).toEqual([["bite-the-diff 🟡 1240 lines", "neutral"]]);
    expect(github.checkOutputs).toEqual([{ title: "1240 lines", summary: "Threshold reached: 1000." }]);
  });

  test("below both: the comment is deleted, and the same check run turns success", async () => {
    github.files = spread(63, 63);
    await github.runAction();
    const { id } = github.checkRuns[0]!;
    github.files = spread(4, 40);
    const result = await github.runAction();
    expect(result.output).toBe("lines=40\nlevel=none\nfiles=4\n");
    expect(github.comments).toEqual([]);
    expect(github.checkRuns).toEqual([{ id, name: "bite-the-diff 40 lines", conclusion: "success", head_sha: HEAD_SHA }]);
  });

  test("one check run per commit through every name: files, lines and files, files again", async () => {
    github.files = spread(63, 63);
    await github.runAction();
    const { id } = github.checkRuns[0]!;
    github.files = spread(63, 3100);
    await github.runAction();
    expect(github.checkRuns).toEqual([{ id, name: "bite-the-diff 🟠 3100 lines, 63 files", conclusion: "neutral", head_sha: HEAD_SHA }]);
    github.files = spread(63, 63);
    await github.runAction();
    expect(github.checkRuns).toEqual([{ id, name: "bite-the-diff 🟡 63 files", conclusion: "neutral", head_sha: HEAD_SHA }]);
    expect(github.comments).toHaveLength(1);
  });

  test("a 403 names the files when they were reached", async () => {
    github.forbid.add("comments");
    github.files = spread(63, 63);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::warning::bite-the-diff could not write the comment: the token got a 403. This PR changes 63 lines, 63 files.");
  });
});

describe("bad configuration", () => {
  test("an event without a pull request fails the run", async () => {
    const result = await github.runAction({ eventFile: { action: "push" } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error::bite-the-diff runs on pull_request events");
  });

  test("a bad threshold line fails the run", async () => {
    const result = await github.runAction({ inputs: { thresholds: "lots:comment" } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error::Bad threshold: lots:comment");
  });
});

test("the token from the input is sent", async () => {
  await github.runAction({ inputs: { token: "secret-123" } });
  expect(github.authorizations).toContain("Bearer secret-123");
});

type ActionInput = { default: string };
type ActionYml = {
  runs: unknown;
  inputs: { thresholds: ActionInput; "file-threshold": ActionInput; "bypass-label": ActionInput; token: ActionInput; exclude: ActionInput };
  outputs: object;
};

test("action.yml declares what the spec says", async () => {
  const action = Bun.YAML.parse(await Bun.file("action.yml").text()) as ActionYml;
  expect(action.runs).toEqual({ using: "node24", main: "dist/index.mjs" });
  expect(action.inputs.thresholds.default).toBe("1000:comment\n3000:comment\n5000:fail\n");
  expect(action.inputs["file-threshold"].default).toBe("50");
  expect(action.inputs["bypass-label"].default).toBe(LABEL);
  expect(action.inputs.token.default).toBe(`\${{ github.token }}`);
  expect(action.inputs.exclude.default).toBe("");
  expect(Object.keys(action.outputs)).toEqual(["lines", "level", "files"]);
});
