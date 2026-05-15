import { BuildJobErrorCategory } from '@prisma/client';

/** Classifies build failure text for Platform Console and ops filtering. */
export function classifyBuildError(message: string): BuildJobErrorCategory {
  const m = message.toLowerCase();

  if (
    /timed out|timeout after|no eas build url within|probe_timeout/i.test(m) ||
    m.includes('[timed out')
  ) {
    return BuildJobErrorCategory.TIMEOUT;
  }

  if (
    /unauthorized|invalid token|authentication failed|not authenticated|expo_token|eas_access_token|whoami|forbidden.*expo/i.test(
      m,
    )
  ) {
    return BuildJobErrorCategory.AUTH_ERROR;
  }

  if (
    /network request failed|econnrefused|enotfound|etimedout|503|502|504|service unavailable|eas outage|registry.npmjs.org/i.test(
      m,
    )
  ) {
    return BuildJobErrorCategory.EAS_OUTAGE;
  }

  if (
    /pre-build|validation failed|eas\.json|missing:|mobile configuration|expo_public_api_url|could not resolve mobile|misconfigured|complete mobile/i.test(
      m,
    )
  ) {
    return BuildJobErrorCategory.CONFIG_ERROR;
  }

  if (
    /eas build failed|build failed|exit \d+|gradle|xcode|bundl|metro|compilation failed/i.test(m)
  ) {
    return BuildJobErrorCategory.BUILD_FAILED;
  }

  return BuildJobErrorCategory.UNKNOWN;
}

export function errorCategoryLabel(category: BuildJobErrorCategory | null | undefined): string {
  switch (category) {
    case BuildJobErrorCategory.CONFIG_ERROR:
      return 'Configuration';
    case BuildJobErrorCategory.AUTH_ERROR:
      return 'Authentication';
    case BuildJobErrorCategory.EAS_OUTAGE:
      return 'EAS / network';
    case BuildJobErrorCategory.BUILD_FAILED:
      return 'Build failed';
    case BuildJobErrorCategory.TIMEOUT:
      return 'Timeout';
    case BuildJobErrorCategory.UNKNOWN:
    default:
      return 'Unknown';
  }
}
