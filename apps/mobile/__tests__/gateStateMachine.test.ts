import { computeLoadedPhase } from '../lib/waiver/gateStateMachine';
import type { PublicWaiverDto, WaiverStatusDto } from '../lib/api/waiverApi';

const waiver: PublicWaiverDto = {
  id: 'doc-1',
  studioId: 'studio-1',
  version: '2026-07-01-v1',
  title: 'Carta Responsiva',
  bodyMarkdown: 'Los participantes asumen el riesgo...',
  effectiveAt: '2026-07-01T00:00:00.000Z',
};

function status(required: boolean, accepted: boolean): WaiverStatusDto {
  return {
    required,
    accepted,
    activeVersion: required ? '2026-07-01-v1' : null,
    activeWaiverDocumentId: required ? 'doc-1' : null,
    acceptedVersion: accepted ? '2026-07-01-v1' : null,
    acceptedAt: accepted ? '2026-07-01T00:01:00.000Z' : null,
    method: accepted ? 'SELF' : null,
  };
}

describe('computeLoadedPhase', () => {
  // ── Scenario 1: already accepted ──────────────────────────────────────────
  it('returns PASSED when waiver required and already accepted', () => {
    const result = computeLoadedPhase(status(true, true), waiver);
    expect(result).toEqual({ tag: 'PASSED' });
  });

  // ── Scenario 2: not required ───────────────────────────────────────────────
  it('returns PASSED when waiver not required (no active document)', () => {
    const result = computeLoadedPhase(status(false, true), null);
    expect(result).toEqual({ tag: 'PASSED' });
  });

  it('returns PASSED when required=false regardless of public waiver presence', () => {
    const result = computeLoadedPhase(status(false, false), waiver);
    expect(result).toEqual({ tag: 'PASSED' });
  });

  // ── Scenario 3: waiver required, document available ────────────────────────
  it('returns WAIVER_REQUIRED with the document when required, unsigned, and doc available', () => {
    const result = computeLoadedPhase(status(true, false), waiver);
    expect(result).toEqual({ tag: 'WAIVER_REQUIRED', waiver });
  });

  it('WAIVER_REQUIRED includes the full waiver object', () => {
    const result = computeLoadedPhase(status(true, false), waiver);
    if (result.tag !== 'WAIVER_REQUIRED') throw new Error('expected WAIVER_REQUIRED');
    expect(result.waiver.bodyMarkdown).toBe('Los participantes asumen el riesgo...');
    expect(result.waiver.id).toBe('doc-1');
  });

  // ── Scenario 6: invariant violation (required + not accepted + no doc) ─────
  it('returns RECOVERABLE_ERROR — not WAIVER_REQUIRED — when required=true accepted=false waiver=null', () => {
    const result = computeLoadedPhase(status(true, false), null);
    // This is the invariant violation from the incident investigation.
    // Must NEVER return { tag: 'WAIVER_REQUIRED' } when waiver is null.
    expect(result.tag).toBe('RECOVERABLE_ERROR');
  });

  it('RECOVERABLE_ERROR result has a non-empty message', () => {
    const result = computeLoadedPhase(status(true, false), null);
    if (result.tag !== 'RECOVERABLE_ERROR') throw new Error('expected RECOVERABLE_ERROR');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('WAIVER_REQUIRED is never produced when waiver is null', () => {
    const result = computeLoadedPhase(status(true, false), null);
    expect(result.tag).not.toBe('WAIVER_REQUIRED');
  });

  // ── Scenario 7: Retry sequence ────────────────────────────────────────────
  it('transitions correctly from ERROR to WAIVER_REQUIRED when retry succeeds', () => {
    // First call simulates the invariant violation
    const errorResult = computeLoadedPhase(status(true, false), null);
    expect(errorResult.tag).toBe('RECOVERABLE_ERROR');

    // Retry: now the document is available
    const retryResult = computeLoadedPhase(status(true, false), waiver);
    expect(retryResult).toEqual({ tag: 'WAIVER_REQUIRED', waiver });
  });

  // ── Scenario 8: after acceptance ─────────────────────────────────────────
  it('returns PASSED after acceptance is recorded (reload confirms accepted=true)', () => {
    const result = computeLoadedPhase(status(true, true), waiver);
    expect(result).toEqual({ tag: 'PASSED' });
  });
});
