import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * Project-level facts read straight from manifest files. Every fact carries
 * the file it came from, and nothing is guessed: a framework is listed only
 * if it is a declared dependency, a command only if a script/target defines
 * it. These files are re-read on every run (there are only a handful), so
 * edits to package.json or a Makefile are always reflected by `sync`.
 */

export interface StackItem {
  label: string;
  /** Manifest the fact was read from, e.g. `package.json`. */
  source: string;
}

export interface ProjectCommand {
  command: string;
  /** What the command runs, when the manifest says (a package.json script body). */
  runs?: string;
  /** Why this command applies, for toolchain commands not defined by the project itself. */
  note?: string;
  source: string;
}

export interface EntryPoint {
  name: string;
  target: string;
  source: string;
}

export interface ProjectFacts {
  name: string;
  description?: string;
  stack: StackItem[];
  commands: ProjectCommand[];
  entryPoints: EntryPoint[];
}

const JS_FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['react-native', 'React Native'],
  ['expo', 'Expo'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['solid-js', 'Solid'],
  ['astro', 'Astro'],
  ['@remix-run/react', 'Remix'],
  ['electron', 'Electron'],
  ['@capacitor/core', 'Capacitor'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['hono', 'Hono'],
  ['@nestjs/core', 'NestJS'],
  ['@trpc/server', 'tRPC'],
  ['graphql', 'GraphQL'],
  ['@prisma/client', 'Prisma'],
  ['prisma', 'Prisma'],
  ['drizzle-orm', 'Drizzle'],
  ['typeorm', 'TypeORM'],
  ['mongoose', 'Mongoose'],
  ['tailwindcss', 'Tailwind CSS'],
  ['vite', 'Vite'],
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['mocha', 'Mocha'],
  ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'],
  ['ai', 'Vercel AI SDK'],
  ['@anthropic-ai/sdk', 'Anthropic SDK'],
  ['openai', 'OpenAI SDK'],
  ['langchain', 'LangChain'],
  ['@langchain/core', 'LangChain'],
  ['@modelcontextprotocol/sdk', 'MCP SDK'],
  ['@tensorflow/tfjs', 'TensorFlow.js'],
  ['three', 'three.js'],
];

const PY_FRAMEWORKS: [string, string][] = [
  ['django', 'Django'],
  ['flask', 'Flask'],
  ['fastapi', 'FastAPI'],
  ['starlette', 'Starlette'],
  ['pydantic', 'Pydantic'],
  ['sqlalchemy', 'SQLAlchemy'],
  ['celery', 'Celery'],
  ['pytest', 'pytest'],
  ['numpy', 'NumPy'],
  ['pandas', 'pandas'],
  ['polars', 'Polars'],
  ['scikit-learn', 'scikit-learn'],
  ['torch', 'PyTorch'],
  ['tensorflow', 'TensorFlow'],
  ['jax', 'JAX'],
  ['keras', 'Keras'],
  ['transformers', 'Hugging Face Transformers'],
  ['langchain', 'LangChain'],
  ['llama-index', 'LlamaIndex'],
  ['openai', 'OpenAI SDK'],
  ['anthropic', 'Anthropic SDK'],
  ['mcp', 'MCP SDK'],
  ['streamlit', 'Streamlit'],
  ['gradio', 'Gradio'],
];

function readText(rootDir: string, rel: string): string | null {
  const file = path.join(rootDir, rel);
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

function add(items: StackItem[], label: string, source: string): void {
  if (!items.some((i) => i.label === label)) items.push({ label, source });
}

const LIFECYCLE_SCRIPTS = new Set(['prepare', 'prepublish', 'prepublishOnly', 'preinstall', 'install', 'postinstall', 'prepack', 'postpack']);

function detectJsPackageManager(rootDir: string, pkg: Record<string, unknown>): { name: string; source: string } {
  if (typeof pkg.packageManager === 'string') {
    const name = pkg.packageManager.split('@')[0];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return { name, source: 'package.json packageManager' };
  }
  const lockfiles: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, name] of lockfiles) {
    if (fs.existsSync(path.join(rootDir, file))) return { name, source: file };
  }
  return { name: 'npm', source: 'package.json' };
}

function scriptCommand(manager: string, script: string): string {
  if (manager === 'npm') return script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `${manager} ${script}`;
}

function detectNode(rootDir: string, facts: ProjectFacts): void {
  const text = readText(rootDir, 'package.json');
  if (text === null) return;
  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }

  if (typeof pkg.name === 'string' && pkg.name.trim()) facts.name = pkg.name.trim();
  if (typeof pkg.description === 'string' && pkg.description.trim()) facts.description = pkg.description.trim();

  const manager = detectJsPackageManager(rootDir, pkg);
  add(facts.stack, 'Node.js', 'package.json');
  add(facts.stack, manager.name, manager.source);
  if (pkg.workspaces) add(facts.stack, `${manager.name} workspaces (monorepo)`, 'package.json workspaces');

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  for (const [dep, label] of JS_FRAMEWORKS) {
    if (dep in deps) add(facts.stack, label, 'package.json');
  }

  const scripts: Record<string, unknown> = pkg.scripts ?? {};
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string' || LIFECYCLE_SCRIPTS.has(name)) continue;
    // `prebuild`/`postbuild` hooks run implicitly with their base script.
    const base = name.replace(/^(pre|post)/, '');
    if (base !== name && base in scripts) continue;
    facts.commands.push({ command: scriptCommand(manager.name, name), runs: body, source: 'package.json' });
  }

  if (typeof pkg.bin === 'string') facts.entryPoints.push({ name: facts.name, target: pkg.bin, source: 'package.json bin' });
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, target] of Object.entries(pkg.bin)) {
      if (typeof target === 'string') facts.entryPoints.push({ name, target, source: 'package.json bin' });
    }
  }
  if (typeof pkg.main === 'string') facts.entryPoints.push({ name: 'main', target: pkg.main, source: 'package.json main' });
}

function tomlSection(text: string, header: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

function hasPythonDependency(text: string, dep: string): boolean {
  const escaped = dep.replace(/[-_.]/g, '[-_.]');
  const withoutComments = text.replace(/#.*$/gm, '');
  return new RegExp(`(^|[\\s"'\\[,])${escaped}(\\[[^\\]]*\\])?\\s*([<>=~!;,"'\\]]|$)`, 'im').test(withoutComments);
}

function detectPython(rootDir: string, facts: ProjectFacts): void {
  const manifests = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg', 'Pipfile'];
  const found = manifests.map((m) => [m, readText(rootDir, m)] as const).filter(([, t]) => t !== null) as [string, string][];
  if (found.length === 0) return;

  add(facts.stack, 'Python', found[0][0]);
  const managers: [string, string][] = [
    ['uv.lock', 'uv'],
    ['poetry.lock', 'Poetry'],
    ['pdm.lock', 'PDM'],
    ['Pipfile.lock', 'Pipenv'],
  ];
  for (const [file, label] of managers) {
    if (fs.existsSync(path.join(rootDir, file))) add(facts.stack, label, file);
  }

  for (const [dep, label] of PY_FRAMEWORKS) {
    const hit = found.find(([, text]) => hasPythonDependency(text, dep));
    if (hit) add(facts.stack, label, hit[0]);
  }

  const pyproject = found.find(([name]) => name === 'pyproject.toml')?.[1];
  if (pyproject) {
    const project = tomlSection(pyproject, 'project') ?? tomlSection(pyproject, 'tool.poetry');
    const nameMatch = project?.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (nameMatch && !fs.existsSync(path.join(rootDir, 'package.json'))) facts.name = nameMatch[1];

    for (const header of ['project.scripts', 'tool.poetry.scripts']) {
      const section = tomlSection(pyproject, header);
      if (!section) continue;
      for (const m of section.matchAll(/^\s*["']?([\w.-]+)["']?\s*=\s*["']([^"']+)["']/gm)) {
        facts.entryPoints.push({ name: m[1], target: m[2], source: `pyproject.toml [${header}]` });
      }
    }
  }
}

function detectMobileAndOther(rootDir: string, facts: ProjectFacts): void {
  const pubspec = readText(rootDir, 'pubspec.yaml');
  if (pubspec !== null) {
    try {
      const doc = (yaml.load(pubspec) ?? {}) as Record<string, any>;
      if (typeof doc.name === 'string' && !fs.existsSync(path.join(rootDir, 'package.json'))) facts.name = doc.name;
      const deps = { ...(doc.dependencies ?? {}), ...(doc.dev_dependencies ?? {}) };
      add(facts.stack, 'flutter' in deps ? 'Flutter' : 'Dart', 'pubspec.yaml');
      for (const [dep, label] of [
        ['flutter_riverpod', 'Riverpod'],
        ['provider', 'Provider'],
        ['flutter_bloc', 'Bloc'],
        ['firebase_core', 'Firebase'],
        ['go_router', 'go_router'],
      ]) {
        if (dep in deps) add(facts.stack, label, 'pubspec.yaml');
      }
    } catch {
      add(facts.stack, 'Dart', 'pubspec.yaml');
    }
  }

  for (const gradle of ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts', 'android/app/build.gradle', 'android/app/build.gradle.kts']) {
    const text = readText(rootDir, gradle);
    if (text === null) continue;
    add(facts.stack, 'Gradle', gradle);
    if (/com\.android\.(application|library)/.test(text)) add(facts.stack, 'Android', gradle);
    if (/compose\s*(=|\()\s*true|androidx\.compose/.test(text)) add(facts.stack, 'Jetpack Compose', gradle);
  }

  if (readText(rootDir, 'Package.swift') !== null) add(facts.stack, 'Swift Package Manager', 'Package.swift');
  if (readText(rootDir, 'Podfile') !== null || readText(rootDir, 'ios/Podfile') !== null) add(facts.stack, 'CocoaPods', 'Podfile');
  for (const dir of ['.', 'ios', 'macos']) {
    try {
      const entry = fs.readdirSync(path.join(rootDir, dir)).find((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
      if (entry) add(facts.stack, 'Xcode project', dir === '.' ? entry : `${dir}/${entry}`);
    } catch {
      // directory absent
    }
  }

  const goMod = readText(rootDir, 'go.mod');
  if (goMod !== null) add(facts.stack, 'Go modules', 'go.mod');
  if (readText(rootDir, 'Cargo.toml') !== null) add(facts.stack, 'Rust (Cargo)', 'Cargo.toml');
  const gemfile = readText(rootDir, 'Gemfile');
  if (gemfile !== null) {
    add(facts.stack, 'Ruby (Bundler)', 'Gemfile');
    if (/gem\s+["']rails["']/.test(gemfile)) add(facts.stack, 'Rails', 'Gemfile');
  }
  const composer = readText(rootDir, 'composer.json');
  if (composer !== null) {
    add(facts.stack, 'PHP (Composer)', 'composer.json');
    if (composer.includes('laravel/framework')) add(facts.stack, 'Laravel', 'composer.json');
  }
  try {
    const dotnet = fs.readdirSync(rootDir).find((e) => e.endsWith('.sln') || e.endsWith('.csproj'));
    if (dotnet) add(facts.stack, '.NET', dotnet);
  } catch {
    // unreadable root
  }
  if (readText(rootDir, 'Dockerfile') !== null) add(facts.stack, 'Docker', 'Dockerfile');
  for (const compose of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']) {
    if (readText(rootDir, compose) !== null) add(facts.stack, 'Docker Compose', compose);
  }
}

function detectMakeTargets(rootDir: string, facts: ProjectFacts): void {
  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    const text = readText(rootDir, file);
    if (text === null) continue;
    const targets = new Set<string>();
    for (const m of text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?![:=])/gm)) {
      if (!m[1].startsWith('.') && !m[1].includes('%')) targets.add(m[1]);
    }
    for (const target of targets) facts.commands.push({ command: `make ${target}`, source: file });
    return;
  }
}

/**
 * Standard toolchain commands — only when the project defines no scripts or
 * make targets of its own (those always win), and only for toolchains whose
 * manifest is present. Each carries the manifest that justifies it.
 */
function addToolchainCommands(rootDir: string, facts: ProjectFacts): void {
  if (facts.commands.length > 0) return;
  const has = (label: string) => facts.stack.some((s) => s.label === label);
  const exists = (rel: string) => fs.existsSync(path.join(rootDir, rel));
  const add = (command: string, tool: string, source: string) => facts.commands.push({ command, note: `standard ${tool} command`, source });

  const pubspec = readText(rootDir, 'pubspec.yaml');
  if (has('Flutter')) {
    add('flutter pub get', 'Flutter', 'pubspec.yaml');
    if (pubspec?.includes('flutter_test:')) add('flutter test', 'Flutter', 'pubspec.yaml');
    add('flutter run', 'Flutter', 'pubspec.yaml');
  } else if (has('Dart')) {
    add('dart pub get', 'Dart', 'pubspec.yaml');
    if (/^\s+test:/m.test(pubspec ?? '')) add('dart test', 'Dart', 'pubspec.yaml');
  }
  if (exists('gradlew')) {
    add('./gradlew build', 'Gradle', 'gradlew');
    add('./gradlew test', 'Gradle', 'gradlew');
  }
  if (exists('go.mod')) {
    add('go build ./...', 'Go', 'go.mod');
    add('go test ./...', 'Go', 'go.mod');
  }
  if (exists('Cargo.toml')) {
    add('cargo build', 'Cargo', 'Cargo.toml');
    add('cargo test', 'Cargo', 'Cargo.toml');
  }
  if (has('pytest')) {
    const runner = has('uv') ? 'uv run ' : has('Poetry') ? 'poetry run ' : '';
    add(`${runner}pytest`, 'pytest', facts.stack.find((s) => s.label === 'pytest')!.source);
  }
}

export function detectProjectFacts(rootDir: string): ProjectFacts {
  const facts: ProjectFacts = {
    name: path.basename(path.resolve(rootDir)),
    stack: [],
    commands: [],
    entryPoints: [],
  };
  detectPython(rootDir, facts);
  detectMobileAndOther(rootDir, facts);
  // Node last so package.json's name wins over pyproject/pubspec when both exist.
  detectNode(rootDir, facts);
  detectMakeTargets(rootDir, facts);
  addToolchainCommands(rootDir, facts);
  return facts;
}
