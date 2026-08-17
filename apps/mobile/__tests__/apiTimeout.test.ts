/**
 * Tests for apiRequest timeout and abort behavior.
 *
 * These tests run in Node (testEnvironment: 'node'), mocking global fetch
 * and the session/env modules so no React Native APIs are needed.
 *
 * Key design: mock fetch must respond to the AbortSignal passed in options,
 * otherwise timeout/abort tests silently hang rather than reject.
 */

// ── Module mocks (must be before imports) ────────────────────────────────────
jest.mock('../lib/env', () => ({
  getApiV1BaseUrl: () => 'https://api.example.com/api/v1',
  getStudioSlug: () => 'ares',
}));

jest.mock('../lib/session', () => ({
  getAccessToken: () => 'test-access-token',
  setAccessToken: jest.fn(),
  getRefreshTokenFromStore: jest.fn().mockResolvedValue(null),
  saveRefreshTokenToStore: jest.fn(),
  clearRefreshTokenFromStore: jest.fn(),
  emitSessionInvalidated: jest.fn(),
}));

import { apiRequest } from '../lib/api/client';
import { ApiError, TimeoutError } from '../lib/api/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * A fetch mock that hangs until the provided AbortSignal fires, then rejects
 * with a proper AbortError. Without this, timeout/abort tests silently hang.
 */
function makeSignalAwareFetch(optionalResponse?: Response): jest.Mock {
  return jest.fn().mockImplementation((_url: string, options: RequestInit) => {
    if (optionalResponse && !options?.signal?.aborted) {
      return Promise.resolve(optionalResponse);
    }
    return new Promise<Response>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return; // no signal — hangs indefinitely (shouldn't happen in production)

      if (signal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }

      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

/** Flush microtask queue to let async chains settle. */
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('apiRequest', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── Scenario 3+4: timeout ─────────────────────────────────────────────────

  it('throws TimeoutError when request hangs for 15 seconds', async () => {
    global.fetch = makeSignalAwareFetch();

    const requestPromise = apiRequest('/test-endpoint', { skipAuth: true });

    jest.advanceTimersByTime(15_001);
    await flushPromises();

    await expect(requestPromise).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError is also an ApiError (correct inheritance chain)', async () => {
    global.fetch = makeSignalAwareFetch();

    const requestPromise = apiRequest('/test-endpoint', { skipAuth: true });
    jest.advanceTimersByTime(15_001);
    await flushPromises();

    const err = await requestPromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).name).toBe('TimeoutError');
  });

  it('does not timeout when response arrives before 15 seconds', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse({ success: true }));

    const result = await apiRequest<{ success: boolean }>('/test-endpoint', { skipAuth: true });

    // Advancing past 15s after a completed request should not throw
    jest.advanceTimersByTime(15_001);
    expect(result).toEqual({ success: true });
  });

  // ── Caller-provided AbortSignal ────────────────────────────────────────────

  it('propagates caller abort without misclassifying it as a timeout', async () => {
    const controller = new AbortController();
    global.fetch = makeSignalAwareFetch();

    const requestPromise = apiRequest('/test-endpoint', {
      skipAuth: true,
      signal: controller.signal,
    });

    controller.abort();
    await flushPromises();

    const err = await requestPromise.catch((e: unknown) => e);
    // Must be an AbortError — not a TimeoutError
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(TimeoutError);
  });

  // ── Scenario 5: server errors ─────────────────────────────────────────────

  it('propagates 404 as ApiError with correct status', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(404, { message: 'Not found' }),
    );

    await expect(
      apiRequest('/missing', { skipAuth: true }),
    ).rejects.toMatchObject({ status: 404, message: 'Not found' });
  });

  it('returns parsed JSON on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse({ id: 'doc-1' }));

    const result = await apiRequest<{ id: string }>('/waiver', { skipAuth: true });
    expect(result).toEqual({ id: 'doc-1' });
  });

  it('returns null when server sends empty body (no active waiver)', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(null));

    const result = await apiRequest<null>('/waiver', { skipAuth: true });
    expect(result).toBeNull();
  });

  // ── Timer cleanup ─────────────────────────────────────────────────────────

  it('clears the timeout timer after a successful response (no timer leak)', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse({ ok: true }));

    await apiRequest('/test-endpoint', { skipAuth: true });

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('clears the timeout timer even after a TimeoutError (no timer leak)', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    global.fetch = makeSignalAwareFetch();

    const requestPromise = apiRequest('/test-endpoint', { skipAuth: true });
    jest.advanceTimersByTime(15_001);
    await flushPromises();

    await requestPromise.catch(() => {});
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  // ── Scenario 9: mutation idempotency — no auto-retry ──────────────────────

  it('does not automatically retry POST requests on timeout', async () => {
    const fetchSpy = makeSignalAwareFetch();
    global.fetch = fetchSpy;

    const requestPromise = apiRequest('/waiver-acceptance', {
      method: 'POST',
      body: JSON.stringify({ accepted: true }),
      skipAuth: true,
    });

    jest.advanceTimersByTime(15_001);
    await flushPromises();

    await expect(requestPromise).rejects.toBeInstanceOf(TimeoutError);
    // Exactly one network attempt — mutations must NOT be retried automatically
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
