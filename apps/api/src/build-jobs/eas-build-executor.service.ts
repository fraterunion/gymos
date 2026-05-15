import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BuildJob, BuildJobPlatform, BuildJobProfile } from '@prisma/client';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type EasBuildJobContext = Pick<
  BuildJob,
  | 'id'
  | 'platform'
  | 'profile'
  | 'appDisplayName'
  | 'appScheme'
  | 'expoSlug'
  | 'iosBundleIdentifier'
  | 'androidPackage'
>;

const DEFAULT_ICON = './assets/images/icon.png';
const DEFAULT_SPLASH = './assets/images/splash-icon.png';
const DEFAULT_ADAPTIVE = './assets/images/adaptive-icon.png';

// Must match `packageManager` in the root package.json.
const PNPM_VERSION = '10.11.0';

function easPlatformArg(p: BuildJobPlatform): 'ios' | 'android' {
  switch (p) {
    case 'IOS':
      return 'ios';
    case 'ANDROID':
      return 'android';
    default: {
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

function easProfileName(p: BuildJobProfile): 'preview' | 'production' {
  switch (p) {
    case 'PREVIEW':
      return 'preview';
    case 'PRODUCTION':
      return 'production';
    default: {
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

function truncateMessage(msg: string, max = 4000): string {
  const t = msg.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

const MEANINGFUL_EAS_PATTERNS: RegExp[] = [
  /it looks like/i,
  /you haven't/i,
  /you need to/i,
  /\berror:/i,
  /✖\s/,
  /✗\s/,
  /build (failed|error)/i,
  /cannot find/i,
  /could not (find|resolve)/i,
  /failed to/i,
  /authentication failed/i,
  /project not found/i,
  /requires?\s+(git|vcs)/i,
  /git repository/i,
  /no such file/i,
  /eas\.json/i,
  /unauthorized/i,
  /invalid token/i,
];

function extractEasErrorMessage(stderr: string, stdout: string, exitCode: number): string {
  function pickLines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.replace(/[⠀-⣿]/g, '').trim()) // strip braille spinner chars
      .filter(Boolean)
      .filter((l) => MEANINGFUL_EAS_PATTERNS.some((p) => p.test(l)));
  }

  const meaningful = [...pickLines(stderr), ...pickLines(stdout)];
  if (meaningful.length > 0) {
    const deduped = [...new Set(meaningful)].slice(0, 6);
    return deduped.join('\n');
  }

  const fallback = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('▸') && !l.startsWith('[') && l.length < 300)
    .slice(-5)
    .join('\n');

  return truncateMessage(fallback || stdout || `EAS build failed (exit code ${exitCode})`, 600);
}

function extractExpoBuildUrl(text: string): string | null {
  const m = text.match(/https:\/\/expo\.dev\/[^\s"'<>]+/);
  return m?.[0] ?? null;
}

function extractArtifactUrl(text: string): string | null {
  const m = text.match(/https:\/\/expo\.dev\/[^\s"'<>]*\/artifacts\/[^\s"'<>]+/i);
  if (m?.[0]) return m[0];
  const m2 = text.match(/https:\/\/[^\s"'<>]+\.(apk|aab|ipa)(\?[^\s"'<>]*)?/i);
  return m2?.[0] ?? null;
}

/** Directories excluded when copying source into the temp workspace. */
const COPY_EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.next', '.expo', 'build', 'android', 'ios',
]);
const COPY_EXCLUDED_EXTS = new Set(['.log']);

function copyRecursive(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (COPY_EXCLUDED_DIRS.has(entry.name)) continue;
    if (!entry.isDirectory() && COPY_EXCLUDED_EXTS.has(path.extname(entry.name))) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

@Injectable()
export class EasBuildExecutorService {
  private readonly logger = new Logger(EasBuildExecutorService.name);

  constructor(private readonly config: ConfigService) {}

  isWorkerEnabled(): boolean {
    const raw = this.config.get<string>('BUILD_WORKER_ENABLED') ?? 'false';
    return raw.trim().toLowerCase() === 'true';
  }

  assertReadyForExecution(): void {
    const missing: string[] = [];
    const token = this.config.get<string>('EAS_ACCESS_TOKEN')?.trim();
    if (!token) missing.push('EAS_ACCESS_TOKEN');
    const mobileRoot = this.resolveMobileAppRoot();
    if (!mobileRoot) missing.push('MOBILE_APP_ROOT (could not resolve apps/mobile)');
    if (missing.length > 0) {
      throw new BadRequestException(
        `Build worker is enabled but misconfigured (missing: ${missing.join(', ')}).`,
      );
    }
  }

  resolveMobileAppRoot(): string | null {
    const override = this.config.get<string>('MOBILE_APP_ROOT')?.trim();
    if (override) return path.resolve(override);
    const cwd = process.cwd();
    const candidates = [
      path.join(cwd, '..', 'mobile'),
      path.join(cwd, 'apps', 'mobile'),
      path.join(cwd, '..', '..', 'apps', 'mobile'),
    ];
    for (const c of candidates) {
      try {
        fs.accessSync(path.join(c, 'eas.json'));
        return path.resolve(c);
      } catch {
        // try next
      }
    }
    return null;
  }

  getMobileRootDiagnostics(): { path: string | null; exists: boolean } {
    const override = this.config.get<string>('MOBILE_APP_ROOT')?.trim();
    if (override) {
      const p = path.resolve(override);
      return { path: p, exists: this.hasEasJsonUnder(p) };
    }
    const resolved = this.resolveMobileAppRoot();
    if (resolved) return { path: resolved, exists: true };
    return { path: null, exists: false };
  }

  private hasEasJsonUnder(dir: string): boolean {
    try {
      fs.accessSync(path.join(dir, 'eas.json'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Finds the monorepo root by walking up from mobileRoot looking for pnpm-workspace.yaml.
   * On Railway: mobileRoot = /app/apps/mobile → monoRoot = /app.
   */
  private resolveMonorepoRoot(mobileRoot: string): string | null {
    const candidates = [
      path.join(mobileRoot, '..', '..'), // apps/mobile → root
      path.join(mobileRoot, '..'),        // mobile → root
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'pnpm-workspace.yaml'))) {
        return path.resolve(c);
      }
    }
    return null;
  }

  /**
   * Runs `npx eas-cli build` from a temporary workspace.
   *
   * The workspace mirrors the monorepo structure (root configs + apps/mobile + packages/*) so
   * that `pnpm install` resolves workspace:* deps and populates node_modules before EAS CLI
   * reads the Expo config. EAS then uploads the source to Expo's build servers.
   */
  async execute(
    job: EasBuildJobContext,
    studioSlug: string,
  ): Promise<{ easBuildUrl: string | null; artifactUrl: string | null }> {
    const mobileRoot = this.resolveMobileAppRoot();
    if (!mobileRoot) {
      throw new Error('Could not resolve mobile app directory (eas.json not found).');
    }

    const easToken = this.config.get<string>('EAS_ACCESS_TOKEN')?.trim();
    if (!easToken) {
      throw new Error('EAS_ACCESS_TOKEN is not set.');
    }

    const expoPublicApiUrl =
      this.config.get<string>('EXPO_PUBLIC_API_URL')?.trim() ||
      this.config.get<string>('CORS_ORIGIN')?.split(',')[0]?.trim() ||
      '';
    if (!expoPublicApiUrl) {
      throw new Error('EXPO_PUBLIC_API_URL (or CORS_ORIGIN) must be set for white-label builds.');
    }

    const timeoutMs = Number(this.config.get<string>('EAS_BUILD_TIMEOUT_MS') ?? '600000');
    const safeTimeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 1_800_000) : 600_000;

    const platformArg = easPlatformArg(job.platform);
    const profileArg = easProfileName(job.profile);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: 'true',
      EAS_NO_VCS: '1',
      EXPO_NO_GIT_STATUS: '1',
      EXPO_NO_DOTENV: '1',
      EXPO_TOKEN: easToken,
      EXPO_NO_INTERACTIVE: '1',
      WHITELABEL_PROFILE: 'local',
      EXPO_PUBLIC_API_URL: expoPublicApiUrl,
      EXPO_PUBLIC_STUDIO_SLUG: studioSlug,
      APP_DISPLAY_NAME: job.appDisplayName,
      APP_SCHEME: job.appScheme,
      EXPO_SLUG: job.expoSlug,
      IOS_BUNDLE_IDENTIFIER: job.iosBundleIdentifier,
      ANDROID_PACKAGE: job.androidPackage,
      APP_ICON_PATH: this.config.get<string>('BUNDLE_DEFAULT_ICON_PATH')?.trim() || DEFAULT_ICON,
      APP_SPLASH_PATH:
        this.config.get<string>('BUNDLE_DEFAULT_SPLASH_PATH')?.trim() || DEFAULT_SPLASH,
      APP_ADAPTIVE_ICON_PATH:
        this.config.get<string>('BUNDLE_DEFAULT_ADAPTIVE_ICON_PATH')?.trim() || DEFAULT_ADAPTIVE,
    };

    const projectId = this.config.get<string>('EAS_PROJECT_ID')?.trim();
    const projectSlug = this.config.get<string>('EAS_PROJECT_SLUG')?.trim();
    const accountName = this.config.get<string>('EAS_ACCOUNT_NAME')?.trim();
    if (projectId) childEnv.EAS_PROJECT_ID = projectId;
    if (projectSlug) childEnv.EAS_PROJECT_SLUG = projectSlug;
    if (accountName) childEnv.EAS_ACCOUNT_NAME = accountName;

    const easArgs = [
      '-y',
      'eas-cli@latest',
      'build',
      '--platform',
      platformArg,
      '--profile',
      profileArg,
      '--non-interactive',
      '--json',
    ];

    const keepWorkspace =
      (this.config.get<string>('DEBUG_KEEP_BUILD_WORKSPACE') ?? '').toLowerCase() === 'true';

    const monoRoot = this.resolveMonorepoRoot(mobileRoot);
    const { workspace, mobileDir } = await this.createWorkspace(
      job.id,
      mobileRoot,
      monoRoot,
      childEnv,
    );

    // --- TEMPORARY DIAGNOSTICS ---
    this.logWorkspaceDiagnostics(job.id, workspace, mobileDir);
    await this.runExpoConfigDiagnostic(job.id, mobileDir, childEnv);
    // --- END TEMPORARY DIAGNOSTICS ---

    this.logger.log(
      JSON.stringify({
        event: 'eas_build_started',
        jobId: job.id,
        platform: job.platform,
        profile: job.profile,
        workspace,
        mobileDir,
      }),
    );

    const started = Date.now();
    let code: number;
    let stdout: string;
    let stderr: string;
    try {
      ({ code, stdout, stderr } = await this.spawnProc(
        'npx',
        easArgs,
        { cwd: mobileDir, env: childEnv },
        safeTimeout,
      ));
    } finally {
      if (!keepWorkspace) {
        await this.cleanupWorkspace(workspace);
      } else {
        this.logger.log(
          JSON.stringify({ event: 'workspace_kept', jobId: job.id, workspace, mobileDir }),
        );
      }
    }

    const durationMs = Date.now() - started;
    const combined = `${stdout}\n${stderr}`;
    this.logger.log(
      JSON.stringify({
        event: 'eas_build_finished',
        jobId: job.id,
        exitCode: code,
        durationMs,
      }),
    );

    if (code !== 0) {
      const errText = extractEasErrorMessage(stderr, stdout, code);
      throw new Error(errText);
    }

    let easBuildUrl = extractExpoBuildUrl(combined);
    let artifactUrl = extractArtifactUrl(combined);

    const jsonObj = this.tryParseEasJson(stdout) ?? this.tryParseEasJson(stderr);
    if (jsonObj) {
      const u = this.pickUrlFromJson(jsonObj);
      if (u) easBuildUrl = easBuildUrl ?? u;
      const art = this.pickArtifactFromJson(jsonObj);
      if (art) artifactUrl = artifactUrl ?? art;
    }

    return { easBuildUrl, artifactUrl };
  }

  // ---------------------------------------------------------------------------
  // Workspace creation
  // ---------------------------------------------------------------------------

  /**
   * Creates a temp build workspace, installs dependencies, and inits a git repo.
   *
   * Strategy (monorepo copy — preferred):
   *   /tmp/gymos-build-<id>/          ← temp monorepo root (git root)
   *     package.json                  ← copied from monoRoot
   *     pnpm-lock.yaml                ← copied from monoRoot
   *     pnpm-workspace.yaml           ← generated (only apps/mobile + packages/*)
   *     .npmrc                        ← copied if present
   *     apps/mobile/                  ← source copy (no node_modules)
   *     packages/{config,types,utils}/ ← all workspace packages
   *     node_modules/                 ← populated by pnpm install
   *
   * Fallback (if monoRoot not found): single-dir workspace with dotenv stubs + npm install.
   *
   * Returns workspace (temp monorepo root) and mobileDir (EAS build cwd).
   */
  private async createWorkspace(
    jobId: string,
    mobileRoot: string,
    monoRoot: string | null,
    installEnv: NodeJS.ProcessEnv,
  ): Promise<{ workspace: string; mobileDir: string }> {
    const workspaceDir = path.join(os.tmpdir(), `gymos-build-${jobId}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    this.logger.log(
      JSON.stringify({ event: 'workspace_created', jobId, workspace: workspaceDir, monoRoot }),
    );

    if (monoRoot) {
      return this.buildMonorepoWorkspace(jobId, workspaceDir, mobileRoot, monoRoot, installEnv);
    }
    return this.buildSimpleWorkspace(jobId, workspaceDir, mobileRoot, installEnv);
  }

  /**
   * Preferred path: partial monorepo copy + pnpm install.
   * pnpm's content-addressable store makes reinstalls fast on Railway after the first run.
   */
  private async buildMonorepoWorkspace(
    jobId: string,
    workspaceDir: string,
    mobileRoot: string,
    monoRoot: string,
    installEnv: NodeJS.ProcessEnv,
  ): Promise<{ workspace: string; mobileDir: string }> {
    // 1. Root config files
    for (const f of ['package.json', 'pnpm-lock.yaml', '.npmrc']) {
      const src = path.join(monoRoot, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(workspaceDir, f));
      }
    }

    // 2. apps/mobile source (no node_modules)
    const tempMobile = path.join(workspaceDir, 'apps', 'mobile');
    fs.mkdirSync(path.join(workspaceDir, 'apps'), { recursive: true });
    copyRecursive(mobileRoot, tempMobile);

    // 3. All packages/* (tiny — just tsconfig presets and tailwind configs; needed for workspace:*)
    const workspaceEntries: string[] = ['apps/mobile'];
    const packagesRoot = path.join(monoRoot, 'packages');
    if (fs.existsSync(packagesRoot)) {
      const pkgDirs = fs
        .readdirSync(packagesRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      const tempPackages = path.join(workspaceDir, 'packages');
      fs.mkdirSync(tempPackages, { recursive: true });
      for (const pkg of pkgDirs) {
        const src = path.join(packagesRoot, pkg);
        const dest = path.join(tempPackages, pkg);
        fs.mkdirSync(dest, { recursive: true });
        copyRecursive(src, dest);
        workspaceEntries.push(`packages/${pkg}`);
      }
    }

    // 4. Minimal pnpm-workspace.yaml covering only what we copied (prevents pnpm from looking
    //    for apps/admin or apps/api which are not present in the temp dir).
    //    nodeLinker: hoisted mirrors the project setting so deps land in node_modules/ at root.
    const workspaceYaml = [
      'packages:',
      ...workspaceEntries.map((p) => `  - '${p}'`),
      'nodeLinker: hoisted',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(workspaceDir, 'pnpm-workspace.yaml'), workspaceYaml);

    // 5. Install dependencies
    await this.installDependencies(workspaceDir, jobId, installEnv);

    // 6. Git: ignore node_modules in the snapshot commit so it stays small
    fs.writeFileSync(path.join(workspaceDir, '.gitignore'), 'node_modules/\n');
    await this.initGitRepo(workspaceDir, jobId);

    return { workspace: workspaceDir, mobileDir: tempMobile };
  }

  /**
   * Fallback when monoRoot cannot be found.
   * Creates a single-dir workspace, strips workspace:* devDeps, and runs npm install.
   */
  private async buildSimpleWorkspace(
    jobId: string,
    workspaceDir: string,
    mobileRoot: string,
    installEnv: NodeJS.ProcessEnv,
  ): Promise<{ workspace: string; mobileDir: string }> {
    this.logger.warn(
      JSON.stringify({
        event: 'workspace_monorepo_root_not_found',
        jobId,
        note: 'Falling back to simple workspace + npm install. Set MOBILE_APP_ROOT if this is unexpected.',
      }),
    );

    copyRecursive(mobileRoot, workspaceDir);

    // Rewrite package.json: remove devDependencies entirely to avoid workspace:* protocol errors
    const pkgJsonPath = path.join(workspaceDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
      delete pkg['devDependencies'];
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
    }

    // npm install — only runtime deps, no scripts, legacy peer dep resolution
    await this.npmInstall(workspaceDir, jobId, installEnv);

    // Dotenv stubs in case npm install didn't fully resolve them
    this.injectDotenvStubs(workspaceDir);

    await this.initGitRepo(workspaceDir, jobId);
    return { workspace: workspaceDir, mobileDir: workspaceDir };
  }

  // ---------------------------------------------------------------------------
  // Dependency installation
  // ---------------------------------------------------------------------------

  private async installDependencies(
    workspaceDir: string,
    jobId: string,
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.logger.log(JSON.stringify({ event: 'dependency_install_started', jobId, cwd: workspaceDir }));

    const installEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      CI: 'true',
      NPM_CONFIG_YES: 'true',
      // Suppress funding/telemetry noise in logs
      ADBLOCK: '1',
      DISABLE_OPENCOLLECTIVE: '1',
      // Do not inherit a token meant for Expo into pnpm registry calls
      EXPO_TOKEN: undefined,
    };

    const { code, stdout, stderr } = await this.spawnProc(
      'npx',
      [
        `pnpm@${PNPM_VERSION}`,
        'install',
        '--ignore-scripts',     // skip postinstall / native build scripts
        '--prefer-offline',     // use pnpm store cache if available (fast on Railway)
        '--no-frozen-lockfile', // allow partial-workspace lockfile regeneration
      ],
      { cwd: workspaceDir, env: installEnv },
      300_000, // 5-minute cap
    );

    if (code !== 0) {
      const combined = `${stderr}\n${stdout}`;
      const errorLines = combined
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && /error|err!/i.test(l))
        .slice(0, 10)
        .join('\n');
      const errMsg = truncateMessage(
        errorLines || combined.split('\n').filter(Boolean).slice(-10).join('\n'),
        500,
      );
      this.logger.error(
        JSON.stringify({ event: 'dependency_install_failed', jobId, error: errMsg }),
      );
      throw new Error(`pnpm install failed in build workspace:\n${errMsg}`);
    }

    this.logger.log(JSON.stringify({ event: 'dependency_install_finished', jobId }));
  }

  /** Fallback installer for the simple (non-monorepo) workspace path. */
  private async npmInstall(
    workspaceDir: string,
    jobId: string,
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.logger.log(
      JSON.stringify({ event: 'dependency_install_started', jobId, installer: 'npm', cwd: workspaceDir }),
    );

    const installEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      CI: 'true',
      npm_config_yes: 'true',
      EXPO_TOKEN: undefined,
    };

    const { code, stderr, stdout } = await this.spawnProc(
      'npm',
      [
        'install',
        '--omit=dev',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--no-package-lock',
      ],
      { cwd: workspaceDir, env: installEnv },
      420_000, // 7-minute cap (fresh npm download is slower)
    );

    if (code !== 0) {
      const errMsg = truncateMessage(
        stderr.split('\n').filter(Boolean).slice(-10).join('\n') || stdout,
        500,
      );
      this.logger.error(
        JSON.stringify({ event: 'dependency_install_failed', jobId, installer: 'npm', error: errMsg }),
      );
      throw new Error(`npm install failed in build workspace:\n${errMsg}`);
    }

    this.logger.log(
      JSON.stringify({ event: 'dependency_install_finished', jobId, installer: 'npm' }),
    );
  }

  // ---------------------------------------------------------------------------
  // TEMPORARY DIAGNOSTICS — remove once plugin resolution is confirmed stable
  // ---------------------------------------------------------------------------

  private logWorkspaceDiagnostics(
    jobId: string,
    workspace: string,
    mobileDir: string,
  ): void {
    let lsRoot = '';
    let lsMobile = '';
    try {
      lsRoot = fs
        .readdirSync(workspace, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        .join('\n');
    } catch {
      lsRoot = '(error reading workspace root)';
    }
    try {
      lsMobile = fs
        .readdirSync(mobileDir, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        .join('\n');
    } catch {
      lsMobile = '(error reading mobileDir)';
    }

    let appConfigHead = '';
    try {
      const p = path.join(mobileDir, 'app.config.js');
      appConfigHead = fs.existsSync(p)
        ? fs.readFileSync(p, 'utf8').slice(0, 400)
        : '(app.config.js not found)';
    } catch {
      appConfigHead = '(read error)';
    }

    this.logger.log(
      JSON.stringify({
        event: 'workspace_diagnostics',
        jobId,
        workspace,
        mobileDir,
        hasPackageJson: fs.existsSync(path.join(mobileDir, 'package.json')),
        hasNodeModules: fs.existsSync(path.join(workspace, 'node_modules')),
        hasExpoRouter: fs.existsSync(path.join(workspace, 'node_modules', 'expo-router')),
        hasEasJson: fs.existsSync(path.join(mobileDir, 'eas.json')),
        lsRoot,
        lsMobile,
        appConfigHead,
      }),
    );
  }

  /** Pre-flight: runs `npx expo config --json` in mobileDir and logs full stderr (with require stack). */
  private async runExpoConfigDiagnostic(
    jobId: string,
    mobileDir: string,
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    const diagEnv: NodeJS.ProcessEnv = { ...baseEnv, EXPO_NO_DOTENV: '1' };

    const { code, stdout, stderr } = await this.spawnProc(
      'npx',
      ['expo', 'config', '--json'],
      { cwd: mobileDir, env: diagEnv },
      60_000,
    );

    this.logger.log(
      JSON.stringify({
        event: 'expo_config_diagnostic',
        jobId,
        exitCode: code,
        stdout: truncateMessage(stdout, 1000),
        stderr: truncateMessage(stderr, 2000),
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // END TEMPORARY DIAGNOSTICS
  // ---------------------------------------------------------------------------

  /**
   * Belt-and-suspenders stub injection used by the simple (npm) fallback path.
   * Not needed when pnpm install is used (real dotenv is installed via hoisted node_modules).
   */
  private injectDotenvStubs(workspaceDir: string): void {
    const dotenvLib = path.join(workspaceDir, 'node_modules', 'dotenv', 'lib');
    fs.mkdirSync(dotenvLib, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'node_modules', 'dotenv', 'package.json'),
      JSON.stringify({ name: 'dotenv', version: '16.4.7', main: './lib/main.js' }),
    );
    fs.writeFileSync(
      path.join(dotenvLib, 'main.js'),
      [
        "'use strict';",
        'exports.config = function() { return { parsed: {} }; };',
        'exports.parse = function() { return {}; };',
        'exports.populate = function() {};',
        'exports.decrypt = function() { return ""; };',
      ].join('\n'),
    );

    const dotenvExpandLib = path.join(workspaceDir, 'node_modules', 'dotenv-expand', 'lib');
    fs.mkdirSync(dotenvExpandLib, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'node_modules', 'dotenv-expand', 'package.json'),
      JSON.stringify({ name: 'dotenv-expand', version: '11.0.7', main: './lib/main.js' }),
    );
    fs.writeFileSync(
      path.join(dotenvExpandLib, 'main.js'),
      [
        "'use strict';",
        'exports.expand = function(opts) { return opts || {}; };',
        'exports.config = function(opts) { return opts || {}; };',
      ].join('\n'),
    );
  }

  private async initGitRepo(dir: string, jobId: string): Promise<void> {
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'GymOS Build Worker',
      GIT_AUTHOR_EMAIL: 'builds@fraterunion.co',
      GIT_COMMITTER_NAME: 'GymOS Build Worker',
      GIT_COMMITTER_EMAIL: 'builds@fraterunion.co',
    };

    const run = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn('git', args, {
          cwd: dir,
          env: gitEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
        let errOut = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { errOut += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0)
            reject(new Error(`git ${args[0]} failed (exit ${code}): ${errOut.trim()}`));
          else resolve();
        });
      });

    await run(['init']);
    await run(['config', 'user.email', 'builds@fraterunion.co']);
    await run(['config', 'user.name', 'GymOS Build Worker']);
    await run(['add', '.']);
    await run(['commit', '-m', 'build snapshot', '--allow-empty']);

    this.logger.log(JSON.stringify({ event: 'git_initialized', jobId, dir }));
  }

  private async cleanupWorkspace(dir: string): Promise<void> {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      this.logger.log(JSON.stringify({ event: 'workspace_cleaned', dir }));
    } catch (err) {
      this.logger.warn(
        JSON.stringify({ event: 'workspace_cleanup_failed', dir, error: String(err) }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private tryParseEasJson(raw: string): Record<string, unknown> | null {
    const t = raw.trim();
    if (!t) return null;
    if (t.startsWith('{')) {
      try {
        const o = JSON.parse(t) as unknown;
        if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const o = JSON.parse(line) as unknown;
          if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  private pickUrlFromJson(obj: Record<string, unknown>): string | null {
    const build = obj['build'];
    if (build && typeof build === 'object' && build !== null) {
      const b = build as Record<string, unknown>;
      const url = b['url'];
      if (typeof url === 'string' && url.startsWith('http')) return url;
    }
    const url = obj['url'];
    if (typeof url === 'string' && url.includes('expo.dev')) return url;
    return null;
  }

  private pickArtifactFromJson(obj: Record<string, unknown>): string | null {
    const artifacts = obj['artifacts'];
    if (Array.isArray(artifacts) && artifacts.length > 0) {
      const first = artifacts[0];
      if (first && typeof first === 'object' && first !== null) {
        const u = (first as Record<string, unknown>)['url'];
        if (typeof u === 'string' && u.startsWith('http')) return u;
      }
    }
    return null;
  }

  /** Generic process spawner used by all subprocess calls in this service. */
  private spawnProc(
    cmd: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ code: 1, stdout, stderr: `${stderr}[TIMED OUT after ${timeoutMs}ms]` });
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
