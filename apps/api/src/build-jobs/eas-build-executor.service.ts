import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BuildJob, BuildJobPlatform, BuildJobProfile } from '@prisma/client';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
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

@Injectable()
export class EasBuildExecutorService {
  private readonly logger = new Logger(EasBuildExecutorService.name);

  constructor(private readonly config: ConfigService) {}

  isWorkerEnabled(): boolean {
    const raw = this.config.get<string>('BUILD_WORKER_ENABLED') ?? 'false';
    return raw.trim().toLowerCase() === 'true';
  }

  /** Validates secrets and paths when worker is enabled and a run is requested. */
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

  /**
   * Runs `npx eas-cli build` with fixed argv (no shell interpolation). Env carries snapshot values only.
   * `--json` implies non-interactive (EAS CLI); JSON is written to stdout, status lines to stderr.
   */
  async execute(job: EasBuildJobContext, studioSlug: string): Promise<{ easBuildUrl: string | null; artifactUrl: string | null }> {
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
    const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 1_800_000) : 600_000;

    const platformArg = easPlatformArg(job.platform);
    const profileArg = easProfileName(job.profile);

    this.logger.log(
      JSON.stringify({
        event: 'eas_build_started',
        jobId: job.id,
        platform: job.platform,
        profile: job.profile,
      }),
    );

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
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
      APP_SPLASH_PATH: this.config.get<string>('BUNDLE_DEFAULT_SPLASH_PATH')?.trim() || DEFAULT_SPLASH,
      APP_ADAPTIVE_ICON_PATH: this.config.get<string>('BUNDLE_DEFAULT_ADAPTIVE_ICON_PATH')?.trim() || DEFAULT_ADAPTIVE,
    };

    const projectId = this.config.get<string>('EAS_PROJECT_ID')?.trim();
    const projectSlug = this.config.get<string>('EAS_PROJECT_SLUG')?.trim();
    const accountName = this.config.get<string>('EAS_ACCOUNT_NAME')?.trim();
    if (projectId) childEnv.EAS_PROJECT_ID = projectId;
    if (projectSlug) childEnv.EAS_PROJECT_SLUG = projectSlug;
    if (accountName) childEnv.EAS_ACCOUNT_NAME = accountName;

    const args = ['-y', 'eas-cli@latest', 'build', '--platform', platformArg, '--profile', profileArg, '--json'];

    const started = Date.now();
    const { code, stdout, stderr } = await this.spawnNpx(args, { cwd: mobileRoot, env: childEnv }, safeTimeout);
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
      const errText = truncateMessage(stderr || stdout || `eas build exited with code ${code}`);
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

  private spawnNpx(
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('npx', args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`EAS build timed out after ${timeoutMs}ms`));
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
