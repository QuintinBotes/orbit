// Fail-before evidence (ADR 0014, issue #65): the policy side. `verification.fail_before` is a person's setting, frozen in
// the snapshot like allow_flaky_pass, and `orbit run --fail-before` can only raise it. The probe tree takes the
// candidate's test-owned paths over the base tree: a test file by ADR 0011, and the files only a test build reads under
// ADR 0011's layouts. Everything else, production code, build files, manifests and lockfiles, stays the base's.
import { describe, expect, it } from 'vitest';
import { defaultConfig, failBeforePolicy, parseConfig, raiseFailBefore, validateConfig } from '../../../src/policy/config.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { isTestOwnedPath, NO_LAYOUT, type TestLayout } from '../../../src/policy/test-files.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}

const owned = (paths: string[], layout: TestLayout = NO_LAYOUT) => {
  for (const p of paths) expect(isTestOwnedPath(p, layout), p).toBe(true);
};
const notOwned = (paths: string[], layout: TestLayout = NO_LAYOUT) => {
  for (const p of paths) expect(isTestOwnedPath(p, layout), p).toBe(false);
};

describe('isTestOwnedPath: what the probe tree takes from the candidate', () => {
  it('owns every test file isTestPath recognises', () => {
    owned(['tests/mul.test.mjs', 'src/a.test.ts', 'pkg/test_e.py', 'cmd/g_test.go', 'src/test/java/com/acme/CalculatorTest.java', 'spec/models/user_spec.rb', 'tests/Unit/CalculatorTest.php', 'Tests/AcmeTests/CalculatorTests.swift', 'test/acme/calculator_test.exs', 'test/calculator_test.dart', 'tests/test_parser.c']);
  });

  it('owns the files only a test build reads: test directories, Go testdata, JVM test source sets and their resources', () => {
    owned([
      'tests/fixtures/data.json',
      'tests/README.md',
      'tests/helpers/builders.mjs',
      '__tests__/fixtures/user.json',
      'spec/spec_helper.rb',
      'spec/support/factories.rb',
      'test/test_helper.rb',
      'tests/TestCase.php',
      'test/support/fixtures.ex',
      'test/helpers.dart',
      'integration_test/driver.dart',
      'pkg/parser/testdata/input.txt',
      'src/test/resources/expected.json',
      'src/integrationTest/resources/fixtures/Sample.kt',
      'Tests/AcmeTests/Resources/data.json',
      'AcmeAppTests/Fixtures/sample.json',
      'tests/CMakeLists.txt',
    ]);
  });

  it('leaves production code, build files, runner configuration, manifests and lockfiles to the base', () => {
    notOwned([
      'apps/calc.mjs',
      'src/lib.rs',
      'src/main/java/com/acme/LoadTest.java',
      'src/main/java/org/acme/test/TestContext.java',
      'src/main/resources/application.yml',
      'Sources/Acme/Tests/Fixture.swift',
      'Sources/AcmeTests/Calculator.swift',
      'package.json',
      'package-lock.json',
      'Cargo.toml',
      'go.mod',
      'build.gradle.kts',
      'vitest.config.ts',
      'jest.config.js',
      'pytest.ini',
      'src/testFixtures/java/com/acme/Builders.java',
      'testing.md',
      'contest.py',
    ]);
  });

  it('a test only by its content (a Rust #[test] added to src/) is not test-owned: the probe cannot take it without its production code', () => {
    const crate: TestLayout = { dotnetProjects: new Map(), cargoManifests: new Map([['', true]]) };
    notOwned(['src/lib.rs', 'src/math.rs'], crate);
    owned(['tests/mul.rs', 'tests/common/mod.rs'], crate);
  });

  it('.NET: a test project owns its folder and its project file; a production project owns neither', () => {
    const repo: TestLayout = { dotnetProjects: new Map([['src/Acme', false], ['tests/Acme.Tests', true], ['Acme.UnitTests', true]]), cargoManifests: new Map() };
    owned(['tests/Acme.Tests/CalculatorTests.cs', 'tests/Acme.Tests/Acme.Tests.csproj', 'tests/Acme.Tests/xunit.runner.json', 'Acme.UnitTests/appsettings.json', 'Acme.UnitTests/Acme.UnitTests.csproj', 'Acme.UnitTests/Support/Builders.cs'], repo);
    notOwned(['src/Acme/Acme.csproj', 'src/Acme/Calculator.cs', 'src/Acme/appsettings.json', 'src/Acme/CalculatorTests.cs'], repo);
  });
});

describe('verification.fail_before: a person sets it, the snapshot freezes it', () => {
  it('defaults to advisory with a 900 second probe bound', () => {
    const c = defaultConfig('autonomous');
    expect(c.verification).toEqual({ allow_flaky_pass: false, fail_before: 'advisory', fail_before_timeout_seconds: 900 });
    expect(failBeforePolicy(c)).toEqual({ mode: 'advisory', timeoutSeconds: 900 });
    const parsed = parseConfig('version: 1\nmode: autonomous\n');
    expect(failBeforePolicy(parsed)).toEqual({ mode: 'advisory', timeoutSeconds: 900 });
  });

  it('accepts off, advisory and required, and a bound of its own', () => {
    for (const mode of ['off', 'advisory', 'required'] as const) {
      const c = parseConfig(`version: 1\nmode: autonomous\nverification:\n  fail_before: ${mode}\n  fail_before_timeout_seconds: 300\n`);
      expect(failBeforePolicy(c)).toEqual({ mode, timeoutSeconds: 300 });
    }
  });

  it('refuses an unknown mode and a bound out of range', () => {
    expect(problems(() => validateConfig({ version: 1, mode: 'autonomous', verification: { fail_before: 'strict' } })).join('\n')).toMatch(/verification\.fail_before/);
    expect(problems(() => validateConfig({ version: 1, mode: 'autonomous', verification: { fail_before_timeout_seconds: 0 } })).join('\n')).toMatch(/verification\.fail_before_timeout_seconds/);
  });

  it('reads a snapshot written before the key existed as off: the run keeps the rule it started with', () => {
    const old = { verification: { allow_flaky_pass: false } } as unknown as Pick<OrbitConfig, 'verification'>;
    expect(failBeforePolicy(old)).toEqual({ mode: 'off', timeoutSeconds: 900 });
  });
});

describe('orbit run --fail-before raises the policy, never lowers it', () => {
  const withMode = (mode: 'off' | 'advisory' | 'required'): OrbitConfig => parseConfig(`version: 1\nmode: autonomous\nverification:\n  fail_before: ${mode}\n`);

  it('raises off to advisory or required, and advisory to required', () => {
    expect(raiseFailBefore(withMode('off'), 'advisory')?.verification.fail_before).toBe('advisory');
    expect(raiseFailBefore(withMode('off'), 'required')?.verification.fail_before).toBe('required');
    expect(raiseFailBefore(withMode('advisory'), 'required')?.verification.fail_before).toBe('required');
  });

  it('keeps the same mode, and refuses a lower one (an agent can type a command line)', () => {
    expect(raiseFailBefore(withMode('advisory'), 'advisory')?.verification.fail_before).toBe('advisory');
    expect(raiseFailBefore(withMode('required'), 'advisory')).toBeNull();
    expect(raiseFailBefore(withMode('required'), 'off')).toBeNull();
    expect(raiseFailBefore(withMode('advisory'), 'off')).toBeNull();
  });

  it('changes nothing else, and leaves the policy it was given untouched', () => {
    const before = withMode('off');
    const raised = raiseFailBefore(before, 'required')!;
    expect(before.verification.fail_before).toBe('off');
    expect({ ...raised, verification: { ...raised.verification, fail_before: 'off' } }).toEqual(before);
    expect(Object.isFrozen(raised)).toBe(true);
  });
});
