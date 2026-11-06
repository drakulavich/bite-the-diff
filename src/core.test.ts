import { describe, expect, test } from "bun:test";
import { commentBody, countLines, decide, parseThresholds, underThresholdsBody } from "./core.ts";

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

describe("countLines", () => {
  const files = [
    { filename: "src/a.ts", additions: 10, deletions: 5 },
    { filename: "bun.lock", additions: 700, deletions: 20 },
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
      "- **Stack:** land a small change and base the next PR on it: `git switch -c`, `gh pr create --base <parent branch>`; rebase a child once its parent merges. For parts that depend on each other in sequence.",
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

test("underThresholdsBody keeps the marker and gives the new count", () => {
  expect(underThresholdsBody(40)).toBe(
    "<!-- bite-the-diff -->\n✅ **40 lines.** Bite-sized again.\n\n<sub>🐘 [bite-the-diff](https://github.com/drakulavich/bite-the-diff)</sub>\n",
  );
});
