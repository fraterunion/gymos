import { normalizeExpoBuildStatus, webhookPayloadToRemoteStatus } from './expo-build-status';

describe('normalizeExpoBuildStatus', () => {
  it('maps webhook lowercase statuses to REST tokens', () => {
    expect(normalizeExpoBuildStatus('finished')).toBe('FINISHED');
    expect(normalizeExpoBuildStatus('errored')).toBe('ERRORED');
    expect(normalizeExpoBuildStatus('canceled')).toBe('CANCELED');
  });

  it('maps in-progress aliases', () => {
    expect(normalizeExpoBuildStatus('in_progress')).toBe('IN_PROGRESS');
    expect(normalizeExpoBuildStatus('IN_QUEUE')).toBe('IN_QUEUE');
  });
});

describe('webhookPayloadToRemoteStatus', () => {
  it('extracts artifact and error from build webhook shape', () => {
    const remote = webhookPayloadToRemoteStatus({
      id: 'build-1',
      status: 'finished',
      artifacts: { buildUrl: 'https://expo.dev/artifacts/app.aab' },
      completedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(remote.expoStatus).toBe('FINISHED');
    expect(remote.artifactUrl).toBe('https://expo.dev/artifacts/app.aab');
    expect(remote.errorMessage).toBeNull();
    expect(remote.completedAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('maps errored builds', () => {
    const remote = webhookPayloadToRemoteStatus({
      id: 'build-2',
      status: 'errored',
      error: { message: 'Build failed' },
    });
    expect(remote.expoStatus).toBe('ERRORED');
    expect(remote.errorMessage).toBe('Build failed');
  });
});
