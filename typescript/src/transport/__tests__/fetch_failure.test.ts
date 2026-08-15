import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeFetchFailure } from '../fetch_failure';

const TYPE_ERROR = new TypeError('Failed to fetch');

function withPageOrigin(origin: string): void {
  vi.stubGlobal('window', { location: { origin } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeFetchFailure', () => {
  it('names the cross-origin call when the page origin differs', () => {
    withPageOrigin('http://localhost:5173');

    const message = describeFetchFailure(
      'https://platform.askcosmo.ai/api/v1/external/realtime/session/start',
      TYPE_ERROR,
    );

    expect(message).toContain('Failed to fetch');
    expect(message).toContain('https://platform.askcosmo.ai');
    expect(message).toContain('http://localhost:5173');
    expect(message).toContain('cross-origin');
  });

  it('leaves a same-origin failure as the raw reason', () => {
    withPageOrigin('https://platform.askcosmo.ai');

    expect(
      describeFetchFailure('https://platform.askcosmo.ai/api/v1/external/x', TYPE_ERROR),
    ).toBe('Failed to fetch');
  });

  it('leaves the reason alone outside a browser', () => {
    expect(
      describeFetchFailure('https://platform.askcosmo.ai/api/v1/external/x', TYPE_ERROR),
    ).toBe('Failed to fetch');
  });

  it('leaves the reason alone when the url is not absolute', () => {
    withPageOrigin('https://platform.askcosmo.ai');

    expect(describeFetchFailure('/api/v1/external/x', TYPE_ERROR)).toBe(
      'Failed to fetch',
    );
  });
});
