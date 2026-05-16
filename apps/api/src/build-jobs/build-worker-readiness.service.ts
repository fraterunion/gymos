import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { EasBuildExecutorService } from './eas-build-executor.service';

export type BuildWorkerReadinessDto = {
  workerEnabled: boolean;
  pollIntervalMs: number;
  mobileAppRoot: string | null;
  mobileAppRootExists: boolean;
  easTokenConfigured: boolean;
  expoPublicApiUrlConfigured: boolean;
  npxAvailable: boolean;
  easCliReachable: boolean;
  easCliVersion?: string;
  canExecuteBuilds: boolean;
  blockingReasons: string[];
};

/** Shared with BuildJobsQueueWorkerService (poll cadence). */
export function resolveBuildQueuePollIntervalMs(config: ConfigService): number {
  const raw = config.get<string>('BUILD_QUEUE_POLL_INTERVAL_MS');
  const n = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : 45_000;
  if (!Number.isFinite(n)) return 45_000;
  return Math.min(120_000, Math.max(30_000, Math.floor(n)));
}

function resolveDiagnosticsTimeoutMs(config: ConfigService): number {
  const raw = config.get<string>('BUILD_WORKER_DIAGNOSTICS_TIMEOUT_MS');
  const n = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : 20_000;
  if (!Number.isFinite(n)) return 20_000;
  return Math.min(60_000, Math.max(5_000, Math.floor(n)));
}

/** Avoid passing tokens to diagnostic child processes. */
function envWithoutSecrets(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of ['EXPO_TOKEN', 'EAS_ACCESS_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    delete e[k];
  }
  return e;
}

@Injectable()
export class BuildWorkerReadinessService {
  private readonly logger = new Logger(BuildWorkerReadinessService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly easExecutor: EasBuildExecutorService,
  ) {}

  async gatherWorkerReadiness(): Promise<BuildWorkerReadinessDto> {
    const diagnosticsTimeoutMs = resolveDiagnosticsTimeoutMs(this.config);
    const pollIntervalMs = resolveBuildQueuePollIntervalMs(this.config);
    const workerEnabled = this.easExecutor.isWorkerEnabled();

    const easTokenConfigured = Boolean(this.config.get<string>('EAS_ACCESS_TOKEN')?.trim());
    const expoUrl =
      this.config.get<string>('EXPO_PUBLIC_API_URL')?.trim() ||
      this.config.get<string>('CORS_ORIGIN')?.split(',')[0]?.trim() ||
      '';
    const expoPublicApiUrlConfigured = expoUrl.length > 0;

    const mobile = this.easExecutor.getMobileRootDiagnostics();

    const probeCwd = os.tmpdir();
    const probeEnv = envWithoutSecrets();

    let npxAvailable = false;
    {
      const r = await this.spawnOnce('npx', ['--version'], {
        cwd: probeCwd,
        env: probeEnv,
        timeoutMs: diagnosticsTimeoutMs,
      });
      npxAvailable = r.code === 0 && r.stdout.trim().length > 0;
    }

    let easCliReachable = false;
    let easCliVersion: string | undefined;
    let easCliProbeFailReason: string | undefined;
    {
      const doProbe = () =>
        this.spawnOnce('npx', ['-y', 'eas-cli@latest', '--version'], {
          cwd: probeCwd,
          env: probeEnv,
          timeoutMs: diagnosticsTimeoutMs,
        });

      let r = await doProbe();

      if (r.code !== 0) {
        const reason = r.timedOut
          ? `probe_timeout (${diagnosticsTimeoutMs}ms)`
          : `exit_code_${r.code}`;
        this.logger.warn(
          JSON.stringify({
            event: 'eas_cli_probe_failed_attempt_1',
            reason,
            stderr: r.stderr.slice(-500).trim(),
            stdout: r.stdout.slice(-200).trim(),
            note: 'Cleaning npm cache and retrying once.',
          }),
        );

        await this.cleanNpmCache(probeCwd, probeEnv);
        r = await doProbe();

        if (r.code !== 0) {
          easCliProbeFailReason = r.timedOut
            ? `probe_timeout (${diagnosticsTimeoutMs}ms)`
            : `exit_code_${r.code}`;
          this.logger.error(
            JSON.stringify({
              event: 'eas_cli_probe_failed_attempt_2',
              reason: easCliProbeFailReason,
              stderr: r.stderr.slice(-500).trim(),
              stdout: r.stdout.slice(-200).trim(),
            }),
          );
        }
      }

      easCliReachable = r.code === 0;
      if (easCliReachable) {
        const combined = `${r.stdout}\n${r.stderr}`.trim();
        const first = combined.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
        const cleaned = first.replace(/^eas-cli\//i, '').slice(0, 64);
        if (cleaned) easCliVersion = cleaned;
      }
    }

    const blockingReasons: string[] = [];
    if (!workerEnabled) {
      blockingReasons.push('BUILD_WORKER_ENABLED is not true — the queue worker will not run EAS builds.');
    }
    if (!easTokenConfigured) {
      blockingReasons.push('EAS_ACCESS_TOKEN is not configured.');
    }
    if (!expoPublicApiUrlConfigured) {
      blockingReasons.push('EXPO_PUBLIC_API_URL (or CORS_ORIGIN) is not configured for bundle-time API base URL.');
    }
    if (!mobile.path) {
      blockingReasons.push(
        'Mobile app root could not be resolved (set MOBILE_APP_ROOT or deploy apps/mobile with eas.json on the API host).',
      );
    } else if (!mobile.exists) {
      blockingReasons.push('Mobile app root path does not contain eas.json.');
    }
    if (!npxAvailable) {
      blockingReasons.push('npx is not available or did not respond before the diagnostics timeout.');
    }
    if (!easCliReachable) {
      const detail = easCliProbeFailReason ? ` (${easCliProbeFailReason})` : '';
      blockingReasons.push(
        `eas-cli could not be reached via npx after cache-clean + retry${detail}. Check network, npm registry, or increase BUILD_WORKER_DIAGNOSTICS_TIMEOUT_MS.`,
      );
    }

    const canExecuteBuilds =
      workerEnabled &&
      easTokenConfigured &&
      expoPublicApiUrlConfigured &&
      Boolean(mobile.path && mobile.exists) &&
      npxAvailable &&
      easCliReachable;

    return {
      workerEnabled,
      pollIntervalMs,
      mobileAppRoot: mobile.path,
      mobileAppRootExists: mobile.exists,
      easTokenConfigured,
      expoPublicApiUrlConfigured,
      npxAvailable,
      easCliReachable,
      easCliVersion,
      canExecuteBuilds,
      blockingReasons,
    };
  }

  private async cleanNpmCache(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    const r = await this.spawnOnce('npm', ['cache', 'clean', '--force'], { cwd, env, timeoutMs: 30_000 });
    if (r.code === 0) {
      this.logger.log(JSON.stringify({ event: 'npm_cache_cleaned' }));
    } else {
      this.logger.warn(JSON.stringify({ event: 'npm_cache_clean_failed', stderr: r.stderr.slice(-200).trim() }));
    }
  }

  private spawnOnce(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => { stdout += c; });
      child.stderr?.on('data', (c: string) => { stderr += c; });
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
        resolve({ code: 1, stdout, stderr, timedOut: true });
      }, opts.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr, timedOut: false });
      });
    });
  }
}
