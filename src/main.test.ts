import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeGitHub, HEAD_SHA } from './fake-github.ts';

const MARKER = '<!-- bite-the-diff -->';
const LABEL = 'bite-the-diff/skip';

let github: FakeGitHub;
beforeEach(() => {
  github = new FakeGitHub();
});
afterEach(() => github.stop());

const sized = (lines: number) => [{ filename: 'src/a.ts', additions: lines, deletions: 0 }];
const posts = () => github.requests.filter((r) => r.startsWith('POST'));
const patches = () => github.requests.filter((r) => r.startsWith('PATCH'));

describe('the count', () => {
  test('sums every file over several pages, deletions included, into the lines output', async () => {
    github.files = Array.from({ length: 250 }, (_, i) => ({ filename: `f${i}.ts`, additions: 3, deletions: 1 }));
    const result = await github.runAction();
    expect(result.output).toBe('lines=1000\nlevel=comment\n');
    expect(github.requests).toContain(`GET /pulls/42/files?per_page=100&page=3`);
  });

  test('exclude from the input leaves paths out', async () => {
    github.files = [
      { filename: 'dist/index.mjs', additions: 6000, deletions: 0 },
      { filename: 'src/a.ts', additions: 40, deletions: 2 },
    ];
    const result = await github.runAction({ inputs: { exclude: ' dist/**\n\n*.lock\n' } });
    expect(result.output).toBe('lines=42\nlevel=none\n');
    expect(result.exitCode).toBe(0);
  });

  test('over 3000 files, the count is the event totals, without exclude, and the comment says so', async () => {
    const result = await github.runAction({
      prFields: { changed_files: 3001, additions: 4000, deletions: 1200 },
      inputs: { exclude: '**' },
      labels: [LABEL],
    });
    expect(result.output).toBe('lines=5200\nlevel=fail\n');
    expect(github.requests.some((r) => r.includes('/files'))).toBe(false);
    expect(github.comments[0]!.body).toContain('This PR has 3001 changed files and the API lists 3000');
  });

  test('at exactly 3000 files, it still lists them', async () => {
    github.files = Array.from({ length: 3000 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }));
    const result = await github.runAction({ prFields: { additions: 9999, deletions: 0 } });
    expect(result.output).toBe('lines=3000\nlevel=comment\n');
  });
});

describe('the outcomes table at each boundary, on a PR with nothing from this action yet', () => {
  const rows = [
    { lines: 999, level: 'none', comment: null, check: null, exitCode: 0 },
    { lines: 1000, level: 'comment', comment: '🟡 This PR changes 1000 lines, past the threshold of 1000.', check: ['bite-the-diff 🟡 1000 lines', 'neutral'], exitCode: 0 },
    { lines: 2999, level: 'comment', comment: '🟡 This PR changes 2999 lines, past the threshold of 1000.', check: ['bite-the-diff 🟡 2999 lines', 'neutral'], exitCode: 0 },
    { lines: 3000, level: 'comment', comment: '🟠 This PR changes 3000 lines, past the threshold of 3000.', check: ['bite-the-diff 🟠 3000 lines', 'neutral'], exitCode: 0 },
    { lines: 4999, level: 'comment', comment: '🟠 This PR changes 4999 lines, past the threshold of 3000.', check: ['bite-the-diff 🟠 4999 lines', 'neutral'], exitCode: 0 },
    { lines: 5000, level: 'fail', comment: `🔴 This PR changes 5000 lines, past the failing threshold of 5000, so this check fails. To let it pass, add the label \`${LABEL}\`.`, check: ['bite-the-diff 🔴 5000 lines', 'failure'], exitCode: 1 },
  ];

  for (const row of rows) {
    test(`${row.lines} lines`, async () => {
      github.files = sized(row.lines);
      const result = await github.runAction();
      expect(result.exitCode).toBe(row.exitCode);
      expect(result.output).toBe(`lines=${row.lines}\nlevel=${row.level}\n`);
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

  test('a failure writes ::error with the count', async () => {
    github.files = sized(5200);
    const result = await github.runAction();
    expect(result.stdout).toContain('::error::This PR changes 5200 lines, past the failing threshold of 5000.');
  });

  test('5000 with the bypass label: comment says so, check is neutral orange, job green', async () => {
    github.files = sized(5000);
    const result = await github.runAction({ labels: [LABEL] });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('lines=5000\nlevel=fail\n');
    expect(github.comments[0]!.body).toContain(`The label \`${LABEL}\` let it pass.`);
    expect(github.checkRuns.map((run) => [run.name, run.conclusion])).toEqual([['bite-the-diff 🟠 5000 lines', 'neutral']]);
  });

  test('some other label does not bypass', async () => {
    github.files = sized(5000);
    const result = await github.runAction({ labels: ['docs'] });
    expect(result.exitCode).toBe(1);
  });

  test('the bypass-label input names the label', async () => {
    github.files = sized(5000);
    const result = await github.runAction({ labels: ['big-ok'], inputs: { 'bypass-label': 'big-ok' } });
    expect(result.exitCode).toBe(0);
    expect(github.comments[0]!.body).toContain('The label `big-ok` let it pass.');
  });

  test('the thresholds input applies', async () => {
    github.files = sized(6);
    const result = await github.runAction({ inputs: { thresholds: '5:fail' } });
    expect(result.output).toBe('lines=6\nlevel=fail\n');
    expect(result.exitCode).toBe(1);
  });
});

describe('dropping under the thresholds', () => {
  test('an existing comment says so, and an existing check run turns success', async () => {
    github.files = sized(5200);
    await github.runAction();
    github.files = sized(40);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(github.comments.map((c) => c.body)).toEqual([`${MARKER}\nThis PR now changes 40 lines, under the thresholds.\n`]);
    expect(github.checkRuns.map((run) => [run.name, run.conclusion])).toEqual([['bite-the-diff 40 lines', 'success']]);
  });

  test('a check run with no comment still turns success, and no comment appears', async () => {
    github.files = sized(40);
    github.checkRuns = [{ id: 7, name: 'bite-the-diff 🟡 1240 lines', conclusion: 'neutral', head_sha: HEAD_SHA }];
    await github.runAction();
    expect(github.comments).toEqual([]);
    expect(github.checkRuns).toEqual([{ id: 7, name: 'bite-the-diff 40 lines', conclusion: 'success', head_sha: HEAD_SHA }]);
  });
});

describe('at most one comment', () => {
  test('a marker comment past the first page is updated, not duplicated', async () => {
    github.comments = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, body: `chat ${i}` }));
    github.comments.push({ id: 500, body: `${MARKER}\nold` });
    github.files = sized(1240);
    await github.runAction();
    expect(github.comments).toHaveLength(131);
    expect(github.comments.at(-1)!.body).toContain('This PR changes 1240 lines');
    expect(github.comments[0]!.body).toBe('chat 0');
    expect(github.requests).toContain('GET /issues/42/comments?per_page=100&page=2');
    expect(posts()).toEqual(['POST /check-runs']);
  });

  test('a second run updates the comment with the new count', async () => {
    github.files = sized(1240);
    await github.runAction();
    github.files = sized(3100);
    await github.runAction();
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain('🟠 This PR changes 3100 lines, past the threshold of 3000.');
    expect(github.comments[0]!.body.startsWith(MARKER)).toBe(true);
  });
});

describe('at most one check run per commit', () => {
  test('a repeated run updates its check run instead of adding one', async () => {
    github.files = sized(1240);
    await github.runAction();
    const { id } = github.checkRuns[0]!;
    await github.runAction();
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]!.id).toBe(id);
    expect(posts().filter((r) => r === 'POST /check-runs')).toHaveLength(1);
    expect(patches()).toContain(`PATCH /check-runs/${id}`);
  });

  test('removing the bypass label turns the same check run from neutral to failure', async () => {
    github.files = sized(5200);
    await github.runAction({ labels: [LABEL] });
    const { id, conclusion } = github.checkRuns[0]!;
    expect(conclusion).toBe('neutral');
    const result = await github.runAction({ labels: [] });
    expect(result.exitCode).toBe(1);
    expect(github.checkRuns).toEqual([{ id, name: 'bite-the-diff 🔴 5200 lines', conclusion: 'failure', head_sha: HEAD_SHA }]);
  });

  test('uses the head sha of the event, not GITHUB_SHA', async () => {
    github.files = sized(1240);
    await github.runAction();
    expect(github.requests).toContain(`GET /commits/${HEAD_SHA}/check-runs?per_page=100&page=1`);
    expect(github.checkRuns[0]!.head_sha).toBe(HEAD_SHA);
  });

  test("another job's check run is left alone, even one named bite-the-diff", async () => {
    github.checkRuns = [
      { id: 1, name: 'bite-the-diff', conclusion: 'success', head_sha: HEAD_SHA },
      { id: 2, name: 'ci', conclusion: 'success', head_sha: HEAD_SHA },
    ];
    github.files = sized(1240);
    await github.runAction();
    expect(github.checkRuns.map((run) => run.name)).toEqual(['bite-the-diff', 'ci', 'bite-the-diff 🟡 1240 lines']);
  });

  test('its check run is found past the first page', async () => {
    github.checkRuns = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, name: `job ${i}`, conclusion: 'success', head_sha: HEAD_SHA }));
    github.checkRuns.push({ id: 900, name: 'bite-the-diff 🟡 1240 lines', conclusion: 'neutral', head_sha: HEAD_SHA });
    github.files = sized(3100);
    await github.runAction();
    expect(github.checkRuns).toHaveLength(121);
    expect(github.checkRuns.at(-1)!.name).toBe('bite-the-diff 🟠 3100 lines');
  });
});

describe('API failures', () => {
  test('a 403 on the comment warns, still writes the check run, and the job stays green', async () => {
    github.forbid.add('comments');
    github.files = sized(1240);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('::warning::bite-the-diff could not write the comment: the token got a 403. This PR changes 1240 lines.');
    expect(result.summary).toContain('1240 lines');
    expect(github.checkRuns).toHaveLength(1);
  });

  test('a 403 on the check run warns and the job stays green', async () => {
    github.forbid.add('check-runs');
    github.files = sized(1240);
    const result = await github.runAction();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('::warning::bite-the-diff could not write the check run: the token got a 403. This PR changes 1240 lines.');
    expect(github.comments).toHaveLength(1);
  });

  test('a read-only token at a fail threshold still fails the job', async () => {
    github.forbid.add('comments');
    github.forbid.add('check-runs');
    github.files = sized(5200);
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error::This PR changes 5200 lines');
    expect(result.summary).toContain('5200 lines');
  });

  test('any other error on the comment fails the run with its status', async () => {
    github.failWith = { route: 'POST /issues', status: 500 };
    github.files = sized(1240);
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error::GitHub API POST /issues/42/comments: 500');
    expect(result.summary).toContain('1240 lines');
  });

  test('a 403 on listing the files fails the run', async () => {
    github.failWith = { route: 'GET /pulls', status: 403 };
    const result = await github.runAction();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error::GitHub API GET /pulls/42/files?per_page=100&page=1: 403');
  });
});

describe('bad configuration', () => {
  test('an event without a pull request fails the run', async () => {
    const result = await github.runAction({ eventFile: { action: 'push' } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error::bite-the-diff runs on pull_request events');
  });

  test('a bad threshold line fails the run', async () => {
    const result = await github.runAction({ inputs: { thresholds: 'lots:comment' } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error::Bad threshold: lots:comment');
  });
});

test('the token from the input is sent', async () => {
  await github.runAction({ inputs: { token: 'secret-123' } });
  expect(github.authorizations).toContain('Bearer secret-123');
});

test('action.yml declares what the spec says', async () => {
  const action = Bun.YAML.parse(await Bun.file('action.yml').text()) as any;
  expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.mjs' });
  expect(action.inputs.thresholds.default).toBe('1000:comment\n3000:comment\n5000:fail\n');
  expect(action.inputs['bypass-label'].default).toBe(LABEL);
  expect(action.inputs.token.default).toBe('${{ github.token }}');
  expect(action.inputs.exclude.default).toBe('');
  expect(Object.keys(action.outputs)).toEqual(['lines', 'level']);
});
