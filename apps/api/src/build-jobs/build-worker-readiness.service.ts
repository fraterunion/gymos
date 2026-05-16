import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { EasBuildExecutorService } from './eas-build-executor.service';

export type BuildWorkerReadinessDto = {
  workerEnabled: boolean;
  pollIntervalMs: number;
  mobileAppRoot: string | null;
  mobileAppRootExists: boolean;
  easTokenConfigured: boolean;
  expoPublicApiUrlConfigured: boolean;
  /** True when the local eas-cli binary is found and executable (no npx involved). */
  easBinaryFound: boolean;
  /** Path to the resolved eas binary, or null when not found. */
  easBinaryPath: string | null;
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

    // Resolve the local eas binary — no npx, no network, no cache to corrupt.
    const easBinaryPath = this.easExecutor.resolveEasBinaryPath();
    const easBinaryFound = easBinaryPath !== null;

    let easCliReachable = false;
    let easCliVersion: string | undefined;
    if (easBinaryFound) {
      const probeEnv = envWithoutSecrets();
      const r = await this.spawnOnce(easBinaryPath!, ['--version'], {
        cwd: mobile.path ?? process.cwd(),
        env: probeEnv,
        timeoutMs: diagnosticsTimeoutMs,
      });
      easCliReachable = r.code === 0;
      if (easCliReachable) {
        const combined = `${r.stdout}\n${r.stderr}`.trim();
        const first = combined.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
        const cleaned = first.replace(/^eas-cli\//i, '').slice(0, 64);
        if (cleaned) easCliVersion = cleaned;
      } else {
        this.logger.warn(
          JSON.stringify({
            event: 'eas_cli_probe_failed',
            binary: easBinaryPath,
            exitCode: r.code,
            stderr: r.stderr.slice(-400).trim(),
          }),
        );
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
    if (!easBinaryFound) {
      blockingReasons.push(
        'local eas-cli binary missing; run pnpm install and ensure eas-cli is in dependencies.',
      );
    } else if (!easCliReachable) {
      blockingReasons.push(
        `eas-cli binary found at ${easBinaryPath} but --version failed. Check file permissions or reinstall.`,
      );
    }

    const canExecuteBuilds =
      workerEnabled &&
      easTokenConfigured &&
      expoPublicApiUrlConfigured &&
      Boolean(mobile.path && mobile.exists) &&
      easBinaryFound &&
      easCliReachable;

    return {
      workerEnabled,
      pollIntervalMs,
      mobileAppRoot: mobile.path,
      mobileAppRootExists: mobile.exists,
      easTokenConfigured,
      expoPublicApiUrlConfigured,
      easBinaryFound,
      easBinaryPath,
      easCliReachable,
      easCliVersion,
      canExecuteBuilds,
      blockingReasons,
    };
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
