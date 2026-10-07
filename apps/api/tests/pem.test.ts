import { describe, expect, it } from 'vitest';
import { certificateExpiry, pemFromSetting, pemProblem } from '../src/lib/pem.js';

/**
 * The Microsoft 365 certificate, as it arrives in an environment variable.
 *
 * ⚠️ A PUBLIC certificate only — no private key is committed, even a throwaway
 * one. The "has a key" cases use marker lines, which is all `pemProblem` reads.
 */

/** Self-signed, `CN=PlastaGo test fixture`, valid until 7 Oct 2027 04:01:23 GMT. */
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUE7Jsx0kfk1rI196015uz/RmMg/swDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVUGxhc3RhR28gdGVzdCBmaXh0dXJlMB4XDTI2MTAwNzA0
MDEyM1oXDTI3MTAwNzA0MDEyM1owIDEeMBwGA1UEAwwVUGxhc3RhR28gdGVzdCBm
aXh0dXJlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw76ne8l76hK9
PdzmpWfzaBOB6a4uD6BFMzR2ZuYR3l6KSkha9yG/Z2+10n3tFlyL2lAvKTzMD8Ig
Qj8+idTcu4bsbRl6xrR61O3WQL5tb2nIqwK/5KJZqStwWB1eWfcoUkAJmxnZjP3h
MbaBmUxXx+x2CVUPEqB+avrY+/ZZETLiFUY2OVfLpNN+FxC0P7o2snKhwFV6U4We
1Lx0WdQTgpXlsA6/rrjABAyE+NWGdIsSBpImowaZtNope6vTPDuSZUEbZNJ67Zje
00/VZbmtzVvIWIxbVmr6PqKr0btX8IkSrJ1fLTdgEo2d7kn6mHCey3XN2az8g4d+
EbsYitUfHQIDAQABo1MwUTAdBgNVHQ4EFgQUS19bJndMIf/hJNiibKOUpCZc2hMw
HwYDVR0jBBgwFoAUS19bJndMIf/hJNiibKOUpCZc2hMwDwYDVR0TAQH/BAUwAwEB
/zANBgkqhkiG9w0BAQsFAAOCAQEADBLwdGpLNjuIdr3H6YBnf9t5K/AbnNdj5qn+
nKR2RZzrulZYRBHNzwjPruCF27RU6k4p3SBnU+fmRs4sgcQaAay3/x8k5p4ILU5v
t+eK+Z1op5QptR6/25wrFi5YmZ+Kg3JWBEFvNtHvswxxcjjba0pZ4ghyLsehnXHA
oTjf7qoTzKlmdv6oSO7Ztu58ZFARwyIt0Nq3ggr48FFEKwSv1sh/oBDRnL+a9+Zf
QiecEHShp2r/JH9G0koYPeUpUKyU6WjuzltxwarB/LNa5DqC5p0/1+KL2KWBUS3c
l9ykmTy06iFZSDZmYGKGCjHpoQ/AEzKwDFB+ZyrZclXONMV3yg==
-----END CERTIFICATE-----`;

const KEY_MARKERS = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
const COMBINED = `${KEY_MARKERS}\n${CERTIFICATE}`;

describe('reading the certificate setting', () => {
  it('takes the PEM as it is', () => {
    expect(pemFromSetting(COMBINED)).toBe(COMBINED);
  });

  /* What a single-line dashboard field does to a multi-line value. */
  it('restores line breaks typed as \\n', () => {
    expect(pemFromSetting(COMBINED.replace(/\n/g, '\\n'))).toBe(COMBINED);
  });

  it('decodes the whole file base64-encoded onto one line', () => {
    expect(pemFromSetting(Buffer.from(COMBINED).toString('base64'))).toBe(COMBINED);
  });
});

describe('whether the setting can sign us in', () => {
  it('accepts a certificate with its private key', () => {
    expect(pemProblem(COMBINED)).toBeNull();
  });

  /* The public half is what was emailed — pasting it here is the easy mistake. */
  it('refuses the certificate alone', () => {
    expect(pemProblem(CERTIFICATE)).toMatch(/private key/);
  });

  it('refuses a key with no certificate', () => {
    expect(pemProblem(KEY_MARKERS)).toMatch(/certificate/);
  });

  it('refuses a password-protected key', () => {
    const locked = `-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n${CERTIFICATE}`;

    expect(pemProblem(locked)).toMatch(/password/);
  });
});

describe('when the certificate expires', () => {
  it('reads the expiry from the certificate block, wherever it sits', () => {
    expect(certificateExpiry(COMBINED)?.toISOString()).toBe('2027-10-07T04:01:23.000Z');
  });

  it('answers null rather than guessing for something unreadable', () => {
    expect(certificateExpiry('-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----')).toBeNull();
  });
});
