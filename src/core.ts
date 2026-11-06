import picomatch from "picomatch";

export const MARKER = "<!-- bite-the-diff -->";
export const CHECK_PREFIX = "bite-the-diff ";
export const MAX_LISTED_FILES = 3000;
const FOOTER = "<sub>🐘 [bite-the-diff](https://github.com/drakulavich/bite-the-diff)</sub>";

export type PrFile = { filename: string; additions: number; deletions: number };
type Action = "comment" | "fail";
export type Threshold = { lines: number; action: Action };

export type Decision = {
  lines: number;
  level: "none" | Action;
  threshold: number | null;
  icon: string;
  bypassed: boolean;
  conclusion: "success" | "neutral" | "failure";
  checkName: string;
  failsJob: boolean;
};

export function parseThresholds(text: string): Threshold[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+):(comment|fail)$/.exec(line);
      if (!match) throw new Error(`Bad threshold: ${line}`);
      return { lines: Number(match[1]), action: match[2] as Action };
    });
}

export function countLines(files: PrFile[], exclude: string[]): number {
  const excluded = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
  return files.filter((file) => !excluded(file.filename)).reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

export function decide(lines: number, thresholds: Threshold[], hasBypassLabel: boolean): Decision {
  const reached = thresholds.filter((t) => lines >= t.lines).reduce<Threshold | null>((high, t) => (!high || t.lines > high.lines ? t : high), null);

  if (!reached) {
    return {
      lines,
      level: "none",
      threshold: null,
      icon: "",
      bypassed: false,
      conclusion: "success",
      checkName: `${CHECK_PREFIX}${lines} lines`,
      failsJob: false,
    };
  }

  const bypassed = reached.action === "fail" && hasBypassLabel;
  const failsJob = reached.action === "fail" && !hasBypassLabel;
  const lowestComment = Math.min(...thresholds.filter((t) => t.action === "comment").map((t) => t.lines));
  const icon = failsJob ? "🔴" : reached.lines === lowestComment ? "🟡" : "🟠";

  return {
    lines,
    level: reached.action,
    threshold: reached.lines,
    icon,
    bypassed,
    conclusion: failsJob ? "failure" : "neutral",
    checkName: `${CHECK_PREFIX}${icon} ${lines} lines`,
    failsJob,
  };
}

export function commentBody(decision: Decision, { bypassLabel, cappedFiles }: { bypassLabel: string; cappedFiles: number | null }): string {
  const { lines, threshold, icon, level, bypassed } = decision;
  const reachedFail = level === "fail";
  const count = `**${lines} lines.**`;

  const headline = bypassed
    ? [`🐘 ${count} The \`${bypassLabel}\` label let this one through whole.`]
    : reachedFail
      ? [`${icon} ${count} Too much elephant: this check stays red (threshold: ${threshold}).`, "", `Can't be cut? Add the label \`${bypassLabel}\`.`]
      : icon === "🟡"
        ? [`${icon} ${count} That's a lot of elephant for one bite (threshold: ${threshold}).`]
        : [`${icon} ${count} Bigger than one bite should be (threshold: ${threshold}).`];

  const capped =
    cappedFiles === null
      ? []
      : [`This PR has ${cappedFiles} changed files and the API lists ${MAX_LISTED_FILES}, so the count is the PR total and \`exclude\` was not applied.`, ""];

  const leaveWhole = reachedFail ? `add the path to \`exclude\` or add the label \`${bypassLabel}\`` : "add the path to `exclude`";

  return [
    MARKER,
    ...headline,
    "",
    ...capped,
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
    FOOTER,
    "",
  ].join("\n");
}

export function underThresholdsBody(lines: number): string {
  return `${MARKER}\n✅ **${lines} lines.** Bite-sized again.\n\n${FOOTER}\n`;
}
