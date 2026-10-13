import { describe, expect, it } from 'vitest';
import { checkPrograms, directInvocation, startedPrograms } from '../../../src/evidence/check-command.ts';

// ADR 0010: a usage error is the check's only when the check's own command invokes the tool directly. These are the
// shapes a check's command takes, and which of them is a direct invocation of one program.

describe('directInvocation: the program a check command runs itself', () => {
  it('reads an argv command: the program, as its file name, and its arguments', () => {
    expect(directInvocation(['dotnet', 'build', 'A.csproj', 'B.csproj'], false)).toEqual({ tool: 'dotnet', program: 'dotnet', args: ['build', 'A.csproj', 'B.csproj'] });
    expect(directInvocation(['/usr/local/share/dotnet/dotnet', 'test'], false)).toEqual({ tool: 'dotnet', program: '/usr/local/share/dotnet/dotnet', args: ['test'] });
    expect(directInvocation(['C:\\tools\\dotnet.exe', 'test'], false)?.tool).toBe('dotnet');
    expect(directInvocation(['./scripts/check.sh', '--fast'], false)).toEqual({ tool: 'check.sh', program: './scripts/check.sh', args: ['--fast'] });
    // An argv element is never split: "&&" here is an argument, not a chain.
    expect(directInvocation(['echo', '&&', 'npm', 'test'], false)).toEqual({ tool: 'echo', program: 'echo', args: ['&&', 'npm', 'test'] });
  });

  it('reads a shell command the same way, quotes, escapes and redirections included', () => {
    expect(directInvocation(['dotnet build "My App.csproj" 2>&1'], true)).toEqual({ tool: 'dotnet', program: 'dotnet', args: ['build', 'My App.csproj'] });
    expect(directInvocation(["npm run 'lint' > lint.out"], true)).toEqual({ tool: 'npm', program: 'npm', args: ['run', 'lint'] });
    expect(directInvocation(['pytest tests/test\\ new.py &>/dev/null'], true)).toEqual({ tool: 'pytest', program: 'pytest', args: ['tests/test new.py'] });
    expect(directInvocation(['cargo test # the whole workspace'], true)).toEqual({ tool: 'cargo', program: 'cargo', args: ['test'] });
    expect(directInvocation(['  go test ./...\n'], true)).toEqual({ tool: 'go', program: 'go', args: ['test', './...'] });
    expect(directInvocation(['/bin/sh', '-c', 'dotnett build'], false)).toEqual({ tool: 'dotnett', program: 'dotnett', args: ['build'] });
    expect(directInvocation(['bash', '-lc', 'npm run lint'], false)).toEqual({ tool: 'npm', program: 'npm', args: ['run', 'lint'] });
  });

  it('looks past a leading env assignment, env, and an npx-style runner to the program they run', () => {
    expect(directInvocation(['CI=1 NODE_ENV=test npm run lint'], true)).toEqual({ tool: 'npm', program: 'npm', args: ['run', 'lint'] });
    expect(directInvocation(['env', '-u', 'HOME', 'CI=1', 'dotnet', 'build'], false)).toEqual({ tool: 'dotnet', program: 'dotnet', args: ['build'] });
    expect(directInvocation(['npx', '--yes', 'jest', '--ci'], false)).toEqual({ tool: 'jest', program: 'jest', args: ['--ci'] });
    expect(directInvocation(['npx', '-p', 'typescript', 'tsc', '--noEmit'], false)).toEqual({ tool: 'tsc', program: 'tsc', args: ['--noEmit'] });
    expect(directInvocation(['pnpm', 'exec', 'vitest', 'run'], false)).toEqual({ tool: 'vitest', program: 'vitest', args: ['run'] });
    expect(directInvocation(['uv', 'run', '--with', 'pytest-cov', 'pytest', 'tests/test_new.py'], false)).toEqual({ tool: 'pytest', program: 'pytest', args: ['tests/test_new.py'] });
    expect(directInvocation(['poetry', 'run', 'pytest', '-q'], false)).toEqual({ tool: 'pytest', program: 'pytest', args: ['-q'] });
    expect(directInvocation(['python3', '-m', 'pytest', '--bogus'], false)).toEqual({ tool: 'pytest', program: 'pytest', args: ['--bogus'] });
    expect(directInvocation(['python3.12', '-X', 'dev', '-m', 'pytest'], false)).toEqual({ tool: 'pytest', program: 'pytest', args: [] });
  });

  it('is null for a chain, a pipeline, a background job, a subshell, a substitution or a second line', () => {
    for (const script of [
      'dotnet restore && npm test',
      'cd src && dotnet build A.csproj B.csproj',
      'npm run lint || true',
      'npm run lint; npm test',
      'dotnet test | tee test.log',
      'npm start &',
      '(cd app && npm test)',
      'npm run "$(cat script-name)"',
      'pytest `cat tests.txt`',
      'npm run lint\nnpm test',
      'cat <<EOF | sh\nnpm test\nEOF',
      'npm run "lint',
    ]) {
      expect(directInvocation([script], true), script).toBeNull();
      expect(directInvocation(['/bin/sh', '-c', script], false), script).toBeNull();
    }
  });

  it('is null for a command with no program, or a runner it cannot see past', () => {
    expect(directInvocation([], false)).toBeNull();
    expect(directInvocation([''], true)).toBeNull();
    expect(directInvocation(['CI=1'], true)).toBeNull();
    expect(directInvocation(['npx'], false)).toBeNull();
    expect(directInvocation(['npx', '-c', 'jest && tsc'], false)).toBeNull();
    expect(directInvocation(['env', '-S', 'npm test'], false)).toBeNull();
    expect(directInvocation(['python3', '-c', 'import sys'], false)).toEqual({ tool: 'python3', program: 'python3', args: ['-c', 'import sys'] });
  });
});

// 0.3.0 retest, verifier of the fix: the program a check's command starts is the one the sandbox refuses to start (exit
// 126) or hides (exit 127), and doctor and PREFLIGHT must agree on it. A chain, a pipeline or `exec` starts programs too,
// and a quoted path with a space is one program.
describe('startedPrograms: every program a check command starts', () => {
  const PY = '/home/acme/projects/shop-venv/bin/python';
  const SPACED = '/home/acme/my venvs/shop/bin/python';

  it('reads an argv command, after assignments, env and exec, and the script a shell it starts runs', () => {
    expect(startedPrograms([PY, '-m', 'pytest'], false)).toEqual([PY]);
    expect(startedPrograms([SPACED, '-m', 'pytest'], false)).toEqual([SPACED]);
    expect(startedPrograms(['env', '-u', 'HOME', 'CI=1', PY, '-m', 'pytest'], false)).toEqual([PY]);
    expect(startedPrograms(['pytest', '-q'], false)).toEqual(['pytest']);
    expect(startedPrograms(['/bin/sh', '-c', `exec ${PY} -m pytest`], false)).toEqual(['/bin/sh', PY]);
    expect(startedPrograms(['bash', '-lc', `cd tests && ${PY} -m pytest`], false)).toEqual(['bash', 'cd', PY]);
    expect(startedPrograms(['env', 'CI=1', 'sh', '-c', `"${SPACED}" -m pytest`], false)).toEqual(['sh', SPACED]);
  });

  it('reads each command of a shell script: a chain, a pipeline, a subshell, a substitution, exec and keywords', () => {
    expect(startedPrograms([`cd tests && ${PY} -m pytest`], true)).toEqual(['cd', PY]);
    expect(startedPrograms([`${PY} -m ruff check . && ${PY} -m pytest`], true)).toEqual([PY]);
    expect(startedPrograms([`exec ${PY} -m pytest`], true)).toEqual([PY]);
    expect(startedPrograms([`exec -a pytest ${PY} -m pytest`], true)).toEqual([PY]);
    expect(startedPrograms([`CI=1 "${SPACED}" -m pytest -q 2>&1 | tee log.txt`], true)).toEqual([SPACED, 'tee']);
    expect(startedPrograms([`'${SPACED}' -m pytest || true; echo done`], true)).toEqual([SPACED, 'true', 'echo']);
    expect(startedPrograms([`(cd app && npm test) & wait`], true)).toEqual(['cd', 'npm', 'wait']);
    expect(startedPrograms([`if [ -d tests ]; then ${PY} -m pytest; fi`], true)).toEqual(['[', PY]);
    expect(startedPrograms([`echo "$(${PY} -V)" && ${PY} -m pytest`], true)).toEqual(['echo', PY]);
    expect(startedPrograms([`npm run lint\n${PY} -m pytest`], true)).toEqual(['npm', PY]);
    expect(startedPrograms([`${PY} -m pytest -k 'a && b'`], true)).toEqual([PY]);
  });

  it('stops at a here-document and reads nothing of a script that does not parse, or of no command', () => {
    expect(startedPrograms([`cat <<EOF | sh\n${PY} -m pytest\nEOF`], true)).toEqual(['cat']);
    expect(startedPrograms([`${PY} -m pytest "unterminated`], true)).toEqual([]);
    expect(startedPrograms([], false)).toEqual([]);
    expect(startedPrograms([''], true)).toEqual([]);
    expect(startedPrograms(['CI=1'], true)).toEqual([]);
    expect(startedPrograms(['env', '-S', `${PY} -m pytest`], false)).toEqual([]);
  });
});

// Second review of the 0.3.0 retest fix: a shell a check's script starts with -c runs a script of its
// own, whose programs the check starts too, and a command substitution is part of the word it stands in, not the end of
// the command that holds it. A reading that cannot be certain (a substitution, a here-document, eval, shells nested past
// the bound) says so, so that doctor warns about what it finds there and never fails a valid command for it.
describe('checkPrograms: nested shells, substitutions and how certain the reading is', () => {
  const PY = '/home/acme/projects/shop/.venv/bin/python';
  const REPO = '/home/acme/projects/shop';

  it('reads the script of a shell the check script starts with -c, as it reads an argv one', () => {
    expect(startedPrograms([`sh -c "${PY} -m pytest"`], true)).toEqual(['sh', PY]);
    expect(startedPrograms([`cd tests && bash -lc '${PY} -m pytest'`], true)).toEqual(['cd', 'bash', PY]);
    expect(startedPrograms(['bash', '-c', `sh -c "exec ${PY} -m pytest"`], false)).toEqual(['bash', 'sh', PY]);
    expect(checkPrograms([`sh -c "${PY} -m pytest"`], true)).toEqual({ programs: ['sh', PY], uncertain: false });
    expect(directInvocation([`sh -c "${PY} -m pytest -q"`], true)).toEqual({ tool: 'pytest', program: 'pytest', args: ['-q'] });
  });

  it('reads shells nested past the bound as uncertain, and reads no further', () => {
    const deep = `sh -c "sh -c 'sh -c \\"sh -c ${PY}\\"'"`;
    const read = checkPrograms([deep], true);
    expect(read.uncertain).toBe(true);
    expect(read.programs).not.toContain(PY);
  });

  it('keeps the words of a command around a substitution: the substitution is part of a word, its own commands are read too', () => {
    expect(startedPrograms([`echo $(git rev-parse --short HEAD) ${REPO} && npm test`], true)).toEqual(['echo', 'git', 'npm']);
    expect(startedPrograms([`echo \`git rev-parse HEAD\` ${REPO} && npm test`], true)).toEqual(['echo', 'git', 'npm']);
    expect(startedPrograms([`VERSION=$(${PY} -V) npm test`], true)).toEqual(['npm', PY]);
    expect(startedPrograms([`echo "rev $(git rev-parse HEAD) in ${REPO}" && npm test`], true)).toEqual(['echo', 'git', 'npm']);
    expect(startedPrograms([`npm test -- --shard=$((1 + 1))/4 ${REPO}`], true)).toEqual(['npm']);
    expect(startedPrograms([`diff <(sort a) ${REPO}/b && npm test`], true)).toEqual(['diff', 'sort', 'npm']);
  });

  it('says a reading is uncertain for a substitution, a here-document or eval, and certain for a plain chain', () => {
    expect(checkPrograms([`cd tests && ${PY} -m pytest`], true).uncertain).toBe(false);
    expect(checkPrograms([`${PY} -m pytest -k 'a && b' 2>&1 | tee log.txt`], true).uncertain).toBe(false);
    expect(checkPrograms([`npm test -- --shard=$((1 + 1))/4`], true).uncertain).toBe(false);
    expect(checkPrograms([`echo $(git rev-parse HEAD) && npm test`], true).uncertain).toBe(true);
    expect(checkPrograms([`echo "$(git rev-parse HEAD)"`], true).uncertain).toBe(true);
    expect(checkPrograms([`${PY} -m pytest <<EOF\nx\nEOF`], true).uncertain).toBe(true);
    expect(checkPrograms(['eval "$CMD"'], true).uncertain).toBe(true);
    expect(checkPrograms(['/bin/sh', '-c', 'eval "$CMD"'], false).uncertain).toBe(true);
    expect(checkPrograms([PY, '-m', 'pytest'], false)).toEqual({ programs: [PY], uncertain: false });
  });
});

// Third review of the 0.3.0 retest fix: a wrapper a check starts its program through (`timeout 600 pytest`, nice, nohup,
// stdbuf, xargs, time, and the builtins command and builtin) starts that program too, so `timeout 600 pytest` hidden by
// srt was offered as a pre-existing failure. A shell given its script after `--`, another option or a long option runs
// that script, and `$((` that a subshell follows (`$((cd x && ./y) )`) is a command substitution, not arithmetic. A
// reading that meets what it does not follow (a case statement, a function, a [[ test, a parameter expansion, an array
// or another parenthesis that is no subshell) is uncertain, so that doctor never fails a valid command for it.
describe('checkPrograms: wrappers, shell options, and what a reading does not follow', () => {
  const PY = '/home/acme/projects/shop/.venv/bin/python';
  const REPO = '/home/acme/projects/shop';
  const PARENT = '/home/acme/projects';

  it('reads the program a wrapper starts, after the wrapper\'s options and operands, with the wrapper', () => {
    expect(startedPrograms(['timeout', '600', 'pytest', '-q'], false)).toEqual(['timeout', 'pytest']);
    expect(startedPrograms(['timeout', '-s', 'KILL', '--kill-after=5', '10m', PY, '-m', 'pytest'], false)).toEqual(['timeout', PY]);
    expect(startedPrograms(['gtimeout', '--preserve-status', '600', 'pytest'], false)).toEqual(['gtimeout', 'pytest']);
    expect(startedPrograms(['nice', '-n', '5', 'nohup', PY, '-m', 'pytest'], false)).toEqual(['nice', 'nohup', PY]);
    expect(startedPrograms(['stdbuf', '-o', 'L', '-eL', 'pytest'], false)).toEqual(['stdbuf', 'pytest']);
    expect(startedPrograms(['timeout 60 pytest'], true)).toEqual(['timeout', 'pytest']);
    expect(startedPrograms(['echo tests | xargs -n 1 -P 4 pytest -q'], true)).toEqual(['echo', 'xargs', 'pytest']);
    expect(startedPrograms(['command pytest -q'], true)).toEqual(['pytest']);
    expect(startedPrograms(['command -p pytest -q'], true)).toEqual(['pytest']);
    expect(startedPrograms(['builtin exec pytest'], true)).toEqual(['pytest']);
    expect(startedPrograms(['/usr/bin/time -v pytest'], true)).toEqual(['/usr/bin/time', 'pytest']);
    expect(startedPrograms(['time -p pytest'], true)).toEqual(['pytest']);
    expect(startedPrograms(['timeout', '60', 'sh', '-c', `${PY} -m pytest`], false)).toEqual(['timeout', 'sh', PY]);
    // What only prints a program's path, and an xargs with no command, start nothing after the wrapper.
    expect(startedPrograms(['command -v pytest || pip install pytest'], true)).toEqual(['pip']);
    expect(startedPrograms(['find . -name "*.py" | xargs'], true)).toEqual(['find', 'xargs']);
  });

  it('reads the script a shell runs after -c and its options, `--` or a long option', () => {
    expect(checkPrograms(['sh', '-c', '--', `${PY} -m pytest`], false)).toEqual({ programs: ['sh', PY], uncertain: false });
    expect(checkPrograms(['bash', '--norc', '--noprofile', '-c', `${PY} -m pytest`], false)).toEqual({ programs: ['bash', PY], uncertain: false });
    expect(checkPrograms(['bash', '--login', '-ec', `${PY} -m pytest`], false).programs).toEqual(['bash', PY]);
    expect(checkPrograms(['sh', '-c', '-e', `${PY} -m pytest`], false).programs).toEqual(['sh', PY]);
    expect(checkPrograms(['bash', '--rcfile', 'ci.rc', '-c', `${PY} -m pytest`], false).programs).toEqual(['bash', PY]);
    // A shell given a script file, not -c, runs a file of the repository.
    expect(checkPrograms(['bash', '--norc', 'scripts/test.sh'], false).programs).toEqual(['bash']);
    expect(checkPrograms(['sh', '--', 'scripts/test.sh'], false).programs).toEqual(['sh']);
  });

  it('reads `$((` that a subshell follows as a command substitution, and arithmetic as before', () => {
    expect(checkPrograms([`echo $((cd tests && ${PY} -m pytest) )`], true)).toEqual({ programs: ['echo', 'cd', PY], uncertain: true });
    expect(checkPrograms([`echo "$((cd tests && ${PY} -m pytest) )"`], true)).toEqual({ programs: ['echo', 'cd', PY], uncertain: true });
    expect(checkPrograms(['npm test -- --shard=$(( (1 + 1) * 2 ))/4'], true)).toEqual({ programs: ['npm'], uncertain: false });
  });

  it('says a reading is uncertain for a case statement, a function, a [[ test, a parameter expansion, an array or a parenthesis that is no subshell', () => {
    const unsure = [
      `case "$PWD" in */.orbit/*) ;; ${PARENT}/*) echo "run me from a checkout" >&2; exit 1;; esac; npm test`,
      `case "$PWD" in (${REPO}|${REPO}/*) exit 1;; esac; npm test`,
      `case "$PWD" in /tmp/*|${PARENT}/*) exit 1;; esac; npm test`,
      `legacy() { ${PY} -m pytest; }; npm test`,
      `legacy () { ${PY} -m pytest; }; npm test`,
      `function legacy { ${PY} -m pytest; }; npm test`,
      `[[ -z "$CI" || ${REPO} -ef . ]] && exit 1; npm test`,
      `[[ "$PWD" =~ ^(${REPO})(/|$) ]] && exit 1; npm test`,
      `[[ $PWD == @(/tmp/*|${REPO}*) ]] && exit 1; npm test`,
      `IGNORE=(${REPO}/vendor ${REPO}/build); npm test`,
      `echo \${LOG:-a|${REPO}/x} && npm test`,
    ];
    for (const script of unsure) expect(checkPrograms([script], true).uncertain, script).toBe(true);
    // A parameter expansion and an array are each one word, whatever they hold; a function's body is read.
    expect(startedPrograms([`echo \${LOG:-a|${REPO}/x} && npm test`], true)).toEqual(['echo', 'npm']);
    expect(startedPrograms([`IGNORE=(${REPO}/vendor ${REPO}/build); npm test`], true)).toEqual(['npm']);
    expect(startedPrograms([`legacy() { ${PY} -m pytest; }; npm test`], true)).toEqual(['legacy()', PY, 'npm']);
    expect(startedPrograms([`function legacy { ${PY} -m pytest; }; npm test`], true)).toEqual([PY, 'npm']);
    // A subshell, after a keyword too, is read for certain.
    expect(checkPrograms([`if (cd tests && ${PY} -m pytest); then echo ok; fi`], true)).toEqual({ programs: ['cd', PY, 'echo'], uncertain: false });
    expect(checkPrograms([`! (${PY} -m pytest)`], true)).toEqual({ programs: [PY], uncertain: false });
  });
});
