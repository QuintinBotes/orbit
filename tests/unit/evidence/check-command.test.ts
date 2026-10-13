import { describe, expect, it } from 'vitest';
import { directInvocation, startedPrograms } from '../../../src/evidence/check-command.ts';

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
