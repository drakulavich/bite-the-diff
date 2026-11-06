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
    { lines: 999, level: "none", threshold: null, icon: "", conclusion: "success", name: "bite-the-diff 999 lines", red: false },
    { lines: 1000, level: "comment", threshold: 1000, icon: "🟡", conclusion: "neutral", name: "bite-the-diff 🟡 1000 lines", red: false },
    { lines: 2999, level: "comment", threshold: 1000, icon: "🟡", conclusion: "neutral", name: "bite-the-diff 🟡 2999 lines", red: false },
    { lines: 3000, level: "comment", threshold: 3000, icon: "🟠", conclusion: "neutral", name: "bite-the-diff 🟠 3000 lines", red: false },
    { lines: 4999, level: "comment", threshold: 3000, icon: "🟠", conclusion: "neutral", name: "bite-the-diff 🟠 4999 lines", red: false },
    { lines: 5000, level: "fail", threshold: 5000, icon: "🔴", conclusion: "failure", name: "bite-the-diff 🔴 5000 lines", red: true },
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
      });
    });
  }

  test("5000 lines with the bypass label is neutral and green", () => {
    expect(decide(5000, defaults, true)).toEqual({
      lines: 5000,
      level: "fail",
      threshold: 5000,
      icon: "🟠",
      bypassed: true,
      conclusion: "neutral",
      checkName: "bite-the-diff 🟠 5000 lines",
      failsJob: false,
    });
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

  test("no thresholds means no level", () => {
    expect(decide(100000, [], false).level).toBe("none");
  });
});

describe("commentBody", () => {
  const soft = commentBody(decide(1240, defaults, false), { bypassLabel: label, cappedFiles: null });
  const failed = commentBody(decide(5200, defaults, false), { bypassLabel: label, cappedFiles: null });
  const bypassed = commentBody(decide(5200, defaults, true), { bypassLabel: label, cappedFiles: null });

  test("starts with the hidden marker", () => {
    expect(soft.startsWith("<!-- bite-the-diff -->\n")).toBe(true);
  });

  test("gives the icon, the count and the threshold", () => {
    expect(soft).toContain("🟡 This PR changes 1240 lines, past the threshold of 1000.");
  });

  for (const option of ["Stack", "By file group", "Horizontal", "Vertical", "Refactoring apart", "Leave it whole"]) {
    test(`names the option ${option}`, () => {
      expect(soft).toContain(`| ${option} |`);
    });
  }

  test("the stack option has the commands", () => {
    expect(soft).toContain("`git switch -c`");
    expect(soft).toContain("`gh pr create --base <parent branch>`");
  });

  test("the bypass label is named only once a fail threshold is reached", () => {
    expect(soft).not.toContain(label);
    expect(failed).toContain(
      `🔴 This PR changes 5200 lines, past the failing threshold of 5000, so this check fails. To let it pass, add the label \`${label}\`.`,
    );
    expect(failed).toContain(`Exclude the path with \`exclude\` or add the label \`${label}\``);
  });

  test("says the label let it pass", () => {
    expect(bypassed).toContain(`🟠 This PR changes 5200 lines, past the failing threshold of 5000. The label \`${label}\` let it pass.`);
    expect(bypassed).not.toContain("so this check fails");
  });

  test("says when the count skipped exclude because of the file cap", () => {
    const capped = commentBody(decide(5200, defaults, false), { bypassLabel: label, cappedFiles: 3500 });
    expect(capped).toContain("This PR has 3500 changed files and the API lists 3000, so the count is the PR total and `exclude` was not applied.");
    expect(soft).not.toContain("the API lists");
  });
});

test("underThresholdsBody keeps the marker and gives the new count", () => {
  expect(underThresholdsBody(40)).toBe("<!-- bite-the-diff -->\nThis PR now changes 40 lines, under the thresholds.\n");
});
