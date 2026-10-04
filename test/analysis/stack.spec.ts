import { describe, expect, it } from 'vitest';
import { detectProjectFacts } from '../../src/analysis/stack';
import { tempDir, writeFiles } from '../helpers';

function factsFor(files: Record<string, string>) {
  const root = tempDir();
  writeFiles(root, files);
  return detectProjectFacts(root);
}

describe('detectProjectFacts — Node', () => {
  it('lists scripts with the package manager from the lockfile, skipping lifecycle and pre/post hooks', () => {
    const facts = factsFor({
      'package.json': JSON.stringify({
        name: 'web',
        scripts: { build: 'vite build', prebuild: 'rm -rf dist', test: 'vitest', prepare: 'husky', postinstall: 'x' },
        dependencies: { react: '1', next: '1' },
        devDependencies: { vitest: '1', '@playwright/test': '1' },
      }),
      'pnpm-lock.yaml': '',
    });
    expect(facts.name).toBe('web');
    expect(facts.commands.map((c) => c.command)).toEqual(['pnpm build', 'pnpm test']);
    expect(facts.stack.map((s) => s.label)).toEqual(['Node.js', 'pnpm', 'Next.js', 'React', 'Vitest', 'Playwright']);
  });

  it('uses `npm test` / `npm run x` forms and prefers the packageManager field', () => {
    expect(factsFor({ 'package.json': JSON.stringify({ scripts: { test: 'x', lint: 'y' } }) }).commands.map((c) => c.command)).toEqual([
      'npm test',
      'npm run lint',
    ]);
    expect(
      factsFor({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0', scripts: { dev: 'x' } }), 'package-lock.json': '{}' }).commands[0]
        .command,
    ).toBe('yarn dev');
  });

  it('records bin/main entry points', () => {
    const facts = factsFor({ 'package.json': JSON.stringify({ name: 'cli', bin: { cli: 'dist/cli.js' }, main: 'dist/index.js' }) });
    expect(facts.entryPoints.map((e) => `${e.name}→${e.target}`)).toEqual(['cli→dist/cli.js', 'main→dist/index.js']);
  });

  it('survives a malformed package.json', () => {
    expect(() => factsFor({ 'package.json': '{ not json' })).not.toThrow();
  });
});

describe('detectProjectFacts — Python / AI', () => {
  it('detects frameworks only from declared dependencies (not from comments or substrings)', () => {
    const facts = factsFor({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = [\n  "fastapi>=0.1",\n  "torch==2.0",\n  "langchain-core",\n]\n# we might use django later\n',
      'poetry.lock': '',
    });
    const labels = facts.stack.map((s) => s.label);
    expect(labels).toContain('FastAPI');
    expect(labels).toContain('PyTorch');
    expect(labels).toContain('Poetry');
    expect(labels).not.toContain('Django');
    expect(labels).not.toContain('LangChain'); // `langchain-core` is not `langchain`
    expect(facts.name).toBe('svc');
  });

  it('reads requirements.txt and adds a pytest command only when no explicit commands exist', () => {
    expect(factsFor({ 'requirements.txt': 'pytest==8\nnumpy\n' }).commands.map((c) => c.command)).toEqual(['pytest']);
    expect(factsFor({ 'requirements.txt': 'pytest\n', 'uv.lock': '' }).commands.map((c) => c.command)).toEqual(['uv run pytest']);
    expect(
      factsFor({ 'requirements.txt': 'pytest\n', Makefile: 'test:\n\tpytest\n' }).commands.map((c) => c.command),
    ).toEqual(['make test']);
  });

  it('records [project.scripts] entry points', () => {
    const facts = factsFor({ 'pyproject.toml': '[project]\nname = "a"\n\n[project.scripts]\nagent = "agent.cli:main"\n' });
    expect(facts.entryPoints).toEqual([{ name: 'agent', target: 'agent.cli:main', source: 'pyproject.toml [project.scripts]' }]);
  });
});

describe('detectProjectFacts — mobile and other ecosystems', () => {
  it('detects Flutter + Android + iOS and emits standard Flutter commands', () => {
    const root = tempDir();
    writeFiles(root, {
      'pubspec.yaml': 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_bloc: ^8.0.0\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
      'android/app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { buildFeatures { compose = true } }\n',
      'ios/Podfile': '',
      'ios/Runner.xcodeproj/project.pbxproj': '',
    });
    const facts = detectProjectFacts(root);
    expect(facts.name).toBe('shop');
    expect(facts.stack.map((s) => s.label)).toEqual(['Flutter', 'Bloc', 'Gradle', 'Android', 'Jetpack Compose', 'CocoaPods', 'Xcode project']);
    expect(facts.commands.map((c) => c.command)).toEqual(['flutter pub get', 'flutter test', 'flutter run']);
    expect(facts.commands[0].note).toBe('standard Flutter command');
  });

  it('detects Go, Rust, Docker, and Makefile targets (excluding special and pattern targets)', () => {
    const facts = factsFor({
      'go.mod': 'module x\n',
      Dockerfile: 'FROM x',
      Makefile: '.PHONY: build\nbuild:\n\tgo build\n%.o: %.c\n\tcc\nVAR := 1\ntest: build\n\tgo test\n',
    });
    expect(facts.stack.map((s) => s.label)).toEqual(['Go modules', 'Docker']);
    expect(facts.commands.map((c) => c.command)).toEqual(['make build', 'make test']);
  });

  it('falls back to the directory name with no manifests at all', () => {
    const root = tempDir();
    const facts = detectProjectFacts(root);
    expect(facts.stack).toEqual([]);
    expect(facts.commands).toEqual([]);
    expect(facts.name.length).toBeGreaterThan(0);
  });
});
