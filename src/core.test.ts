import { describe, expect, test } from "bun:test";
import { commentBody, countFiles, countLines, decide, parseFileThreshold, parseThresholds, withFileThreshold } from "./core.ts";

const defaults = parseThresholds("1000:comment\n3000:comment\n5000:fail\n");
const label = "elefante";

describe("parseThresholds", () => {
  test("reads lines and actions, skipping blank lines and spaces", () => {
    expect(parseThresholds(" 1000:comment \n\n5000:fail\n")).toEqual([
      { lines: 1000, action: "comment" },
      { lines: 5000, action: "fail" },
    ]);
  });

  for (const bad of ["1000", "many:comment", "1000:warn", "-5:fail", "1000:comment:fail"]) {
    test(`rejects ${bad}`, () => {
      expect(() => parseThresholds(bad)).toThrow(`Bad threshold: ${bad}`);
    });
  }
});

describe("parseFileThreshold", () => {
  test("reads a non-negative integer", () => {
    expect(parseFileThreshold("50")).toBe(50);
    expect(parseFileThreshold("0")).toBe(0);
  });

  for (const bad of ["-1", "1.5", "many", "50 files", "1e3", ""]) {
    test(`rejects "${bad}"`, () => {
      expect(() => parseFileThreshold(bad)).toThrow(`Bad file-threshold: ${bad}`);
    });
  }
});

describe("countFiles", () => {
  const files = [
    { filename: "src/a.ts", additions: 10, deletions: 5 },
    { filename: "data.lock", additions: 700, deletions: 20 },
    { filename: "dist/index.mjs", additions: 300, deletions: 100 },
    { filename: ".hidden/gen.ts", additions: 3, deletions: 0 },
  ];

  test("counts every file with no exclude", () => {
    expect(countFiles(files, [])).toBe(4);
  });

  test("leaves out files an exclude glob matches, in a dot directory too", () => {
    expect(countFiles(files, ["dist/**", "*.lock", "**/gen.ts"])).toBe(1);
  });
});

describe("withFileThreshold", () => {
  test("49 files leaves any decision as it was", () => {
    expect(withFileThreshold(decide(40, defaults, false), 49, 50)).toEqual({
      lines: 40,
      level: "none",
      threshold: null,
      icon: "",
      bypassed: false,
      conclusion: "success",
      checkName: "bite-the-diff 40 lines",
      failsJob: false,
      redFrom: null,
    });
  });

  test("50 files with the lines under every threshold: a neutral yellow comment", () => {
    expect(withFileThreshold(decide(40, defaults, false), 50, 50)).toEqual({
      lines: 40,
      level: "comment",
      threshold: null,
      icon: "🟡",
      bypassed: false,
      conclusion: "neutral",
      checkName: "bite-the-diff 🟡 50 files",
      failsJob: false,
      redFrom: null,
      filesOver: { files: 50, threshold: 50 },
    });
  });

  test("0 turns it off at any count", () => {
    expect(withFileThreshold(decide(40, defaults, false), 3001, 0)).toEqual(decide(40, defaults, false));
  });

  test("the bypass label does not touch a files-only decision", () => {
    const decision = withFileThreshold(decide(40, defaults, true), 63, 50);
    expect(decision.bypassed).toBe(false);
    expect(decision.failsJob).toBe(false);
    expect(decision.level).toBe("comment");
  });

  const combined = [
    { lines: 1240, label: false, name: "bite-the-diff 🟡 1240 lines, 63 files", level: "comment", conclusion: "neutral", failsJob: false },
    { lines: 3100, label: false, name: "bite-the-diff 🟠 3100 lines, 63 files", level: "comment", conclusion: "neutral", failsJob: false },
    { lines: 5200, label: false, name: "bite-the-diff 🟠 5200 lines, 63 files", level: "comment", conclusion: "neutral", failsJob: false },
    { lines: 5600, label: false, name: "bite-the-diff 🔴 5600 lines, 63 files", level: "fail", conclusion: "failure", failsJob: true },
    { lines: 5600, label: true, name: "bite-the-diff 🟠 5600 lines, 63 files", level: "fail", conclusion: "neutral", failsJob: false },
  ];
  for (const row of combined) {
    test(`${row.lines} lines, label ${row.label}: the lines decide, and the name gains the files`, () => {
      const decision = withFileThreshold(decide(row.lines, defaults, row.label), 63, 50);
      expect(decision.checkName).toBe(row.name);
      expect(decision.level).toBe(row.level as "comment");
      expect(decision.conclusion).toBe(row.conclusion as "neutral");
      expect(decision.failsJob).toBe(row.failsJob);
      expect(decision.filesOver).toEqual({ files: 63, threshold: 50 });
    });
  }
});

describe("countLines", () => {
  const files = [
    { filename: "src/a.ts", additions: 10, deletions: 5 },
    { filename: "data.lock", additions: 700, deletions: 20 },
    { filename: "dist/index.mjs", additions: 300, deletions: 100 },
    { filename: "gone.ts", additions: 0, deletions: 40 },
    { filename: ".hidden/gen.ts", additions: 3, deletions: 0 },
  ];

  test("sums additions and deletions, a removed file included", () => {
    expect(countLines(files, [])).toBe(1178);
  });

  test("leaves out files an exclude glob matches", () => {
    expect(countLines(files, ["dist/**", "*.lock"])).toBe(58);
  });

  test("a glob reaches a dot directory", () => {
    expect(countLines(files, ["**/gen.ts"])).toBe(1175);
  });
});

describe("built-in lock files", () => {
  const names = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "composer.lock",
    "Gemfile.lock",
    "gradle.lockfile",
    "buildscript-gradle.lockfile",
  ];

  for (const name of names) {
    test(`${name} is left out at the root and in any folder`, () => {
      const files = [
        { filename: name, additions: 700, deletions: 20 },
        { filename: `packages/.app/${name}`, additions: 300, deletions: 0 },
        { filename: "src/a.ts", additions: 10, deletions: 5 },
      ];
      expect(countLines(files, [])).toBe(15);
      expect(countFiles(files, [])).toBe(1);
    });
  }

  for (const name of ["package-lock.json.bak", "docs/yarn.lock.md", "src/lock.ts", "my-package-lock.json", "go.summary", "bun.lock/readme.md"]) {
    test(`${name} still counts`, () => {
      expect(countLines([{ filename: name, additions: 10, deletions: 5 }], [])).toBe(15);
    });
  }

  test("the exclude input adds to the list", () => {
    const files = [
      { filename: "bun.lock", additions: 700, deletions: 20 },
      { filename: "dist/index.mjs", additions: 300, deletions: 100 },
      { filename: "src/a.ts", additions: 10, deletions: 5 },
    ];
    expect(countLines(files, ["dist/**"])).toBe(15);
  });
});

describe("decide, each row of the outcomes table at its boundary", () => {
  const rows = [
    { lines: 999, level: "none", threshold: null, icon: "", conclusion: "success", name: "bite-the-diff 999 lines", red: false, redFrom: null },
    { lines: 1000, level: "comment", threshold: 1000, icon: "🟡", conclusion: "neutral", name: "bite-the-diff 🟡 1000 lines", red: false, redFrom: null },
    { lines: 2999, level: "comment", threshold: 1000, icon: "🟡", conclusion: "neutral", name: "bite-the-diff 🟡 2999 lines", red: false, redFrom: null },
    { lines: 3000, level: "comment", threshold: 3000, icon: "🟠", conclusion: "neutral", name: "bite-the-diff 🟠 3000 lines", red: false, redFrom: null },
    { lines: 4999, level: "comment", threshold: 3000, icon: "🟠", conclusion: "neutral", name: "bite-the-diff 🟠 4999 lines", red: false, redFrom: null },
    { lines: 5000, level: "comment", threshold: 5000, icon: "🟠", conclusion: "neutral", name: "bite-the-diff 🟠 5000 lines", red: false, redFrom: 5500 },
    { lines: 5499, level: "comment", threshold: 5000, icon: "🟠", conclusion: "neutral", name: "bite-the-diff 🟠 5499 lines", red: false, redFrom: 5500 },
    { lines: 5500, level: "fail", threshold: 5000, icon: "🔴", conclusion: "failure", name: "bite-the-diff 🔴 5500 lines", red: true, redFrom: null },
  ];

  for (const row of rows) {
    test(`${row.lines} lines`, () => {
      expect(decide(row.lines, defaults, false)).toEqual({
        lines: row.lines,
        level: row.level as "none",
        threshold: row.threshold,
        icon: row.icon,
        bypassed: false,
        conclusion: row.conclusion as "success",
        checkName: row.name,
        failsJob: row.red,
        redFrom: row.redFrom,
      });
    });
  }

  test("5500 lines with the bypass label is neutral and green", () => {
    expect(decide(5500, defaults, true)).toEqual({
      lines: 5500,
      level: "fail",
      threshold: 5000,
      icon: "🟠",
      bypassed: true,
      conclusion: "neutral",
      checkName: "bite-the-diff 🟠 5500 lines",
      failsJob: false,
      redFrom: null,
    });
  });

  test("the bypass label changes nothing inside the tolerance", () => {
    expect(decide(5499, defaults, true)).toEqual(decide(5499, defaults, false));
  });

  test("the bypass label changes nothing below a fail threshold", () => {
    const decision = decide(1240, defaults, true);
    expect(decision.bypassed).toBe(false);
    expect(decision.checkName).toBe("bite-the-diff 🟡 1240 lines");
  });
});

describe("decide with custom thresholds", () => {
  test("only the highest threshold reached applies", () => {
    const decision = decide(6000, parseThresholds("1000:fail\n5000:comment"), false);
    expect(decision.level).toBe("comment");
    expect(decision.threshold).toBe(5000);
    expect(decision.failsJob).toBe(false);
  });

  test("the order of the lines does not matter", () => {
    expect(decide(6000, parseThresholds("5000:comment\n1000:fail"), false).threshold).toBe(5000);
  });

  test("the lowest comment threshold gets the yellow icon, even above a fail threshold", () => {
    const custom = parseThresholds("100:fail\n500:comment\n900:comment");
    expect(decide(600, custom, false).checkName).toBe("bite-the-diff 🟡 600 lines");
    expect(decide(950, custom, false).checkName).toBe("bite-the-diff 🟠 950 lines");
  });

  test("a bypassed fail with no comment threshold at all is orange", () => {
    expect(decide(200, parseThresholds("100:fail"), true).checkName).toBe("bite-the-diff 🟠 200 lines");
  });

  test("a custom fail threshold has its tolerance, rounded up", () => {
    const custom = parseThresholds("1234:fail");
    expect(decide(1233, custom, false).level).toBe("none");
    expect(decide(1234, custom, false).level).toBe("comment");
    expect(decide(1357, custom, false).redFrom).toBe(1358);
    expect(decide(1358, custom, false).failsJob).toBe(true);
  });

  test("the tolerance has no floating-point error, where times 1.1 would give 3301", () => {
    const custom = parseThresholds("3000:fail");
    expect(decide(3299, custom, false).redFrom).toBe(3300);
    expect(decide(3300, custom, false).level).toBe("fail");
    expect(decide(3300, custom, false).failsJob).toBe(true);
  });

  test("the highest threshold reached applies while it sits in its tolerance", () => {
    const decision = decide(1120, parseThresholds("1000:fail\n1050:fail"), false);
    expect(decision.level).toBe("comment");
    expect(decision.threshold).toBe(1050);
    expect(decision.redFrom).toBe(1155);
    expect(decision.failsJob).toBe(false);
  });

  test("a comment threshold has no tolerance", () => {
    expect(decide(999, parseThresholds("1000:comment"), false).level).toBe("none");
    expect(decide(1000, parseThresholds("1000:comment"), false).level).toBe("comment");
  });

  test("no thresholds means no level", () => {
    expect(decide(100000, [], false).level).toBe("none");
  });
});

describe("commentBody", () => {
  const ways = (leaveWhole: string) =>
    [
      "<details>",
      "<summary>🐘 Ways to cut it into bites</summary>",
      "",
      "- **Stack:** land a small change and base the next PR on it: `git switch -c`, `gh pr create --base <parent branch>`. When the parent merges, retarget and rebase the child before deleting the parent's branch: deleting it first closes the child. For parts that depend on each other in sequence.",
      "- **By file group:** separate PRs for files that need different reviewers. For a change that cuts across areas.",
      "- **Horizontal:** shared code or stubs first, then what uses them. For layered code.",
      "- **Vertical:** smaller slices of the feature, each working end to end. For feature work.",
      "- **Refactoring apart:** refactoring in its own PR, before the behaviour change. For a PR that mixes the two.",
      `- **Leave it whole:** ${leaveWhole}. For whole-file deletions, generated code and automated refactoring, where a reviewer only checks intent.`,
      "</details>",
      "",
      "<sub>🐘 [bite-the-diff](https://github.com/drakulavich/bite-the-diff)</sub>",
      "",
    ].join("\n");
  const excludeOnly = "add the path to `exclude`";
  const excludeOrLabel = "add the path to `exclude` or add the label `elefante`";
  const body = (lines: number, hasLabel: boolean, cappedFiles: number | null = null) =>
    commentBody(decide(lines, defaults, hasLabel), { bypassLabel: label, cappedFiles });

  test("the lowest comment threshold", () => {
    expect(body(1501, false)).toBe(
      `<!-- bite-the-diff -->\n🟡 **1501 lines.** That's a lot of elephant for one bite (threshold: 1000).\n\n${ways(excludeOnly)}`,
    );
  });

  test("a higher comment threshold", () => {
    expect(body(3100, false)).toBe(`<!-- bite-the-diff -->\n🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).\n\n${ways(excludeOnly)}`);
  });

  for (const hasLabel of [false, true]) {
    test(`inside the tolerance, hasLabel ${hasLabel}: the label is not mentioned`, () => {
      expect(body(5200, hasLabel)).toBe(
        `<!-- bite-the-diff -->\n🟠 **5200 lines.** Almost too much elephant: red from 5500 (threshold: 5000).\n\n${ways(excludeOnly)}`,
      );
    });
  }

  test("a fail threshold without the label", () => {
    expect(body(5600, false)).toBe(
      `<!-- bite-the-diff -->\n🔴 **5600 lines.** Too much elephant: this check stays red (threshold: 5000).\n\nCan't be cut? Add the label \`elefante\`.\n\n${ways(excludeOrLabel)}`,
    );
  });

  test("a fail threshold with the label", () => {
    expect(body(5600, true)).toBe(`<!-- bite-the-diff -->\n🐘 **5600 lines.** The \`elefante\` label let this one through whole.\n\n${ways(excludeOrLabel)}`);
  });

  test("the file cap sentence sits between the headline and the block", () => {
    expect(body(3100, false, 3500)).toBe(
      `<!-- bite-the-diff -->\n🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).\n\nThis PR has 3500 changed files and the API lists 3000, so the count is the PR total and \`exclude\` was not applied.\n\n${ways(excludeOnly)}`,
    );
  });

  test("custom thresholds: the wording follows the icon and the action", () => {
    const custom = parseThresholds("100:fail\n500:comment\n900:comment");
    const text = (lines: number) => commentBody(decide(lines, custom, false), { bypassLabel: label, cappedFiles: null });
    expect(text(200)).toContain("🔴 **200 lines.** Too much elephant: this check stays red (threshold: 100).");
    expect(text(600)).toContain("🟡 **600 lines.** That's a lot of elephant for one bite (threshold: 500).");
    expect(text(950)).toContain("🟠 **950 lines.** Bigger than one bite should be (threshold: 900).");
  });
});

describe("commentBody with files", () => {
  const FOOT =
    "<details>\n<summary>🐘 Ways to cut it into bites</summary>\n\n- **Stack:** land a small change and base the next PR on it: `git switch -c`, `gh pr create --base <parent branch>`. When the parent merges, retarget and rebase the child before deleting the parent's branch: deleting it first closes the child. For parts that depend on each other in sequence.\n- **By file group:** separate PRs for files that need different reviewers. For a change that cuts across areas.\n- **Horizontal:** shared code or stubs first, then what uses them. For layered code.\n- **Vertical:** smaller slices of the feature, each working end to end. For feature work.\n- **Refactoring apart:** refactoring in its own PR, before the behaviour change. For a PR that mixes the two.\n";
  const LEAVE =
    "For whole-file deletions, generated code and automated refactoring, where a reviewer only checks intent.\n</details>\n\n<sub>🐘 [bite-the-diff](https://github.com/drakulavich/bite-the-diff)</sub>\n";
  const ways = `${FOOT}- **Leave it whole:** add the path to \`exclude\`. ${LEAVE}`;
  const waysWithLabel = `${FOOT}- **Leave it whole:** add the path to \`exclude\` or add the label \`elefante\`. ${LEAVE}`;
  const body = (lines: number, hasLabel: boolean, files: number, cappedFiles: number | null = null) =>
    commentBody(withFileThreshold(decide(lines, defaults, hasLabel), files, 50), { bypassLabel: label, cappedFiles });

  test("only files reached, with the label on the PR: the label is not mentioned", () => {
    expect(body(40, true, 63)).toBe(`<!-- bite-the-diff -->\n🟡 **63 files.** A lot of elephant to chew at once (threshold: 50).\n\n${ways}`);
  });

  test("only files reached over the listing cap", () => {
    expect(body(40, false, 3001, 3001)).toBe(
      `<!-- bite-the-diff -->\n🟡 **3001 files.** A lot of elephant to chew at once (threshold: 50).\n\nThis PR has 3001 changed files and the API lists 3000, so the count is the PR total and \`exclude\` was not applied.\n\n${ways}`,
    );
  });

  test("a soft line threshold reached too", () => {
    expect(body(3100, false, 63)).toBe(
      `<!-- bite-the-diff -->\n🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).\nAlso 63 files (threshold: 50).\n\n${ways}`,
    );
  });

  test("inside the tolerance too", () => {
    expect(body(5200, false, 63)).toBe(
      `<!-- bite-the-diff -->\n🟠 **5200 lines.** Almost too much elephant: red from 5500 (threshold: 5000).\nAlso 63 files (threshold: 50).\n\n${ways}`,
    );
  });

  test("a fail threshold too: the files line sits with the headline, before the label hint", () => {
    expect(body(5600, false, 63)).toBe(
      `<!-- bite-the-diff -->\n🔴 **5600 lines.** Too much elephant: this check stays red (threshold: 5000).\nAlso 63 files (threshold: 50).\n\nCan't be cut? Add the label \`elefante\`.\n\n${waysWithLabel}`,
    );
  });

  test("a bypassed fail threshold too", () => {
    expect(body(5600, true, 63)).toBe(
      `<!-- bite-the-diff -->\n🐘 **5600 lines.** The \`elefante\` label let this one through whole.\nAlso 63 files (threshold: 50).\n\n${waysWithLabel}`,
    );
  });

  test("files under the threshold: byte for byte the text without any file count", () => {
    expect(body(3100, false, 49)).toBe(`<!-- bite-the-diff -->\n🟠 **3100 lines.** Bigger than one bite should be (threshold: 3000).\n\n${ways}`);
  });
});

describe("one line, one file", () => {
  const headline = (lines: number, thresholds: string, files = 1, fileThreshold = 0, hasLabel = false) =>
    commentBody(withFileThreshold(decide(lines, parseThresholds(thresholds), hasLabel), files, fileThreshold), { bypassLabel: label, cappedFiles: null })
      .split("\n")
      .slice(1, 3);

  test("the check name in each state", () => {
    expect(decide(1, parseThresholds("2:comment"), false).checkName).toBe("bite-the-diff 1 line");
    expect(decide(1, parseThresholds("1:fail"), false).checkName).toBe("bite-the-diff 🟠 1 line");
    expect(decide(1, parseThresholds("1:comment"), false).checkName).toBe("bite-the-diff 🟡 1 line");
    expect(withFileThreshold(decide(5, parseThresholds("9:comment"), false), 1, 1).checkName).toBe("bite-the-diff 🟡 1 file");
    expect(withFileThreshold(decide(5, parseThresholds("5:comment"), false), 1, 1).checkName).toBe("bite-the-diff 🟡 5 lines, 1 file");
  });

  test("every headline with a line count", () => {
    expect(headline(1, "1:fail")[0]).toBe("🟠 **1 line.** Almost too much elephant: red from 2 (threshold: 1).");
    expect(headline(1, "0:fail")[0]).toBe("🔴 **1 line.** Too much elephant: this check stays red (threshold: 0).");
    expect(headline(1, "0:fail", 1, 0, true)[0]).toBe("🐘 **1 line.** The `elefante` label let this one through whole.");
    expect(headline(1, "1:comment")[0]).toBe("🟡 **1 line.** That's a lot of elephant for one bite (threshold: 1).");
    expect(headline(1, "0:comment\n1:comment")[0]).toBe("🟠 **1 line.** Bigger than one bite should be (threshold: 1).");
  });

  test("the file headline and the Also line", () => {
    expect(headline(5, "9:comment", 1, 1)[0]).toBe("🟡 **1 file.** A lot of elephant to chew at once (threshold: 1).");
    expect(headline(5, "5:comment", 1, 1)[1]).toBe("Also 1 file (threshold: 1).");
    expect(headline(5, "5:comment", 2, 1)[1]).toBe("Also 2 files (threshold: 1).");
  });
});
