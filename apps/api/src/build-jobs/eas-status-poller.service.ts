import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'node:https';
import { URL } from 'node:url';
import { isExpoTerminalBuildStatus, normalizeExpoBuildStatus } from './expo-build-status';

export type EasRemoteBuildStatus = {
  expoStatus: string;
  artifactUrl: string | null;
  completedAt: Date | null;
  errorMessage: string | null;
};

/** @deprecated Use isExpoTerminalBuildStatus */
export function isExpoTerminalStatus(status: string): boolean {
  return isExpoTerminalBuildStatus(status);
}

@Injectable()
export class EasStatusPollerService {
  private readonly logger = new Logger(EasStatusPollerService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Fetches the current build status from the Expo REST API.
   * Returns null on any network/parse failure (caller should log + continue).
   * Never throws.
   */
  async fetchBuildStatus(expoBuildId: string): Promise<EasRemoteBuildStatus | null> {
    const token = this.config.get<string>('EAS_ACCESS_TOKEN')?.trim();
    if (!token) {
      return null;
    }

    const url = `https://api.expo.dev/v2/builds/${encodeURIComponent(expoBuildId)}`;
    let rawBody: string;
    try {
      rawBody = await this.httpGet(url, token);
    } catch (err) {
      this.logger.warn(`[EAS_POLLER] network_error buildId=${expoBuildId}: ${String(err)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      this.logger.warn(`[EAS_POLLER] parse_error buildId=${expoBuildId}: ${rawBody.slice(0, 200)}`);
      return null;
    }

    const build = (parsed as { data?: Record<string, unknown> })?.data;
    if (!build || typeof build['status'] !== 'string') {
      this.logger.warn(`[EAS_POLLER] unexpected_shape buildId=${expoBuildId}: ${rawBody.slice(0, 300)}`);
      return null;
    }

    const expoStatus = normalizeExpoBuildStatus(build['status'] as string);
    const artifacts = build['artifacts'] as {
      applicationArchiveUrl?: string | null;
      buildUrl?: string | null;
    } | null | undefined;
    const completedAtRaw = typeof build['completedAt'] === 'string' ? build['completedAt'] : null;
    const errorObj = build['error'] as { message?: string } | null | undefined;

    const artifactUrl = artifacts?.applicationArchiveUrl ?? artifacts?.buildUrl ?? null;
    const completedAt = completedAtRaw ? new Date(completedAtRaw) : null;
    const errorMessage = typeof errorObj?.message === 'string' ? errorObj.message : null;

    const isTerminal = isExpoTerminalStatus(expoStatus);
    this.logger.log(
      `[EAS_POLLER] polled buildId=${expoBuildId} status=${expoStatus} terminal=${isTerminal} artifact=${artifactUrl ? 'yes' : 'no'}`,
    );

    return { expoStatus, artifactUrl, completedAt, errorMessage };
  }

  /** Thin HTTPS GET wrapper — uses node:https directly to avoid adding an HTTP client dependency. */
  private httpGet(url: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}: ${body.slice(0, 300)}`));
            } else {
              resolve(body);
            }
          });
        },
      );
      req.setTimeout(15_000, () => {
        req.destroy(new Error('Expo API request timed out after 15s'));
      });
      req.on('error', reject);
      req.end();
    });
  }
}
