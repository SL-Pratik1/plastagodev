import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/middleware/request-context.js';

/**
 * The extractor webhook authenticates with `?token=<secret>`, because the
 * vendor's configuration takes a URL and nothing else. Every request line used
 * to print that URL whole — into whatever log drain the deployment ships to.
 */
describe('request log redaction', () => {
  it('hides the webhook secret in a logged URL', () => {
    expect(redactUrl('/api/v1/webhooks/extractor?token=0e503d2b7f0e60ee')).toBe(
      '/api/v1/webhooks/extractor?token=[redacted]',
    );
  });

  it('hides it wherever it sits in the query, and keeps the rest', () => {
    expect(redactUrl('/x?page=2&token=abc&sort=asc')).toBe('/x?page=2&token=[redacted]&sort=asc');
  });

  it('leaves a URL with no credential alone', () => {
    expect(redactUrl('/api/v1/queues/po-review?page=1')).toBe('/api/v1/queues/po-review?page=1');
  });

  it('never throws on a missing URL', () => {
    expect(redactUrl(undefined)).toBe('?');
  });
});
