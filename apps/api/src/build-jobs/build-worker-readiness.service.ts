import { Injectable } from '@nestjs/common';
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
    try {
      const r = await this.spawnOnce('npx', ['--version'], {
        cwd: probeCwd,
        env: probeEnv,
        timeoutMs: diagnosticsTimeoutMs,
      });
      npxAvailable = r.code === 0 && r.stdout.trim().length > 0;
    } catch {
      npxAvailable = false;
    }

    let easCliReachable = false;
    let easCliVersion: string | undefined;
    try {
      const r = await this.spawnOnce('npx', ['-y', 'eas-cli@latest', '--version'], {
        cwd: probeCwd,
        env: probeEnv,
        timeoutMs: diagnosticsTimeoutMs,
      });
      easCliReachable = r.code === 0;
      if (easCliReachable) {
        const combined = `${r.stdout}\n${r.stderr}`.trim();
        const first = combined.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
        const cleaned = first.replace(/^eas-cli\//i, '').slice(0, 64);
        if (cleaned) easCliVersion = cleaned;
      }
    } catch {
      easCliReachable = false;
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
      blockingReasons.push('eas-cli could not be reached via npx (network, registry, or diagnostics timeout).');
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

  private spawnOnce(
    command: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
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
      child.stdout?.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr?.on('data', (c: string) => {
        stderr += c;
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('probe_timeout'));
      }, opts.timeoutMs);
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
