import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
/*
 * Type-only imports, so nothing from the AWS SDK is loaded at runtime unless
 * `STORAGE_PROVIDER=s3` — the actual `import()` calls below are lazy. This keeps
 * a developer laptop and the test suite free of a dependency they do not use,
 * without giving up type safety at the vendor boundary.
 */
import type { S3Client } from '@aws-sdk/client-s3';
import type * as S3Module from '@aws-sdk/client-s3';
import type { getSignedUrl as GetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'storage' });

/**
 * Object storage (§6A.10 #9) — photos, weighbridge dockets, generated PDFs.
 *
 * ── Why the bytes never pass through this API ─────────────────────────────
 * A driver's phone uploads STRAIGHT to S3 using a presigned URL. The API only
 * ever issues the URL and records the key.
 *
 * That is not a micro-optimisation. Photos are the evidence that defends a
 * futile charge (M4.6), so there are five or more per job, taken on a building
 * site over patchy 4G. Routing them through Node would mean holding a multipart
 * body per upload, a request timeout the phone cannot retry cheaply, and a
 * memory profile that scales with how many drivers are working at once. Handing
 * out a URL costs nothing and lets the phone retry on its own.
 *
 * ── Why there is a stub at all ────────────────────────────────────────────
 * Same reason the mailer has one: the whole capture-and-view path had to be
 * buildable and testable before an AWS account existed. The stub keeps bytes on
 * local disk and hands out ordinary API URLs. Selecting the real thing is
 * `STORAGE_PROVIDER=s3` plus credentials — never a code change (§8).
 */

/** What the caller must know to complete an upload from the phone. */
export interface PresignedUpload {
  /** The permanent key. This is what gets stored on the photo record. */
  key: string;
  /** Where to PUT the bytes. Expires — see `S3_URL_TTL_SECONDS`. */
  uploadUrl: string;
  /** Headers the PUT must carry, or the signature will not match. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageProvider {
  /** For logs and `/readyz`, so it is obvious which provider is live. */
  readonly name: string;
  /** A URL the phone can PUT to directly. */
  presignUpload: (input: {
    key: string;
    contentType: string;
    contentLength: number;
  }) => Promise<PresignedUpload>;
  /** A short-lived URL for reading one object back. */
  presignDownload: (key: string) => Promise<string>;
  /** Server-side write, for things the API generates itself (PDFs). */
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /** Used by the stub's own read route, and by PDF generation. */
  get: (key: string) => Promise<Readable>;
  remove: (key: string) => Promise<void>;
  exists: (key: string) => Promise<boolean>;
}

/**
 * The MIME types a driver's phone may upload.
 *
 * An allow-list, not a block-list. The bucket is served back to browsers, and
 * `image/svg+xml` executes script in the origin that serves it — an allow-list
 * of raster formats plus PDF makes that whole class of problem unreachable.
 */
export const UPLOADABLE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
]);

/*
 * ⚠️ Wider than `UPLOADABLE_TYPES` on purpose. That set is what a driver's
 * PHONE may send; this map is every type any key in the system can encode. A
 * lead proposal arrives from the office as a Word document (see the lead
 * service's own allow-list), and a type missing from here gets a `.bin` key —
 * which reads back as no type at all, so the file downloads nameless instead of
 * opening.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/**
 * The type an object at this key holds, read back off its extension.
 *
 * ── Why the extension and not a stored value ──────────────────────────────
 * S3 keeps the `Content-Type` it was given at upload and returns it, so nothing
 * needs to remember it. The stub writes bare files to disk and has nowhere to
 * put it — but `buildKey` already encoded it in the extension, so the stub can
 * recover exactly what was declared rather than guessing.
 *
 * ⚠️ Returns null rather than a default. The stub's read route sends
 * `X-Content-Type-Options: nosniff`, and answering `application/octet-stream`
 * for an unknown extension is what makes a browser download a file instead of
 * displaying it. Null lets the caller stay silent, which is the honest answer.
 */
export function contentTypeForKey(key: string): string | null {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  const match = Object.entries(EXTENSIONS).find(([, ext]) => ext === extension);
  return match ? match[0] : null;
}

/**
 * 20 MB. A modern phone photo is 3–5 MB; a burst of HEIC frames is not.
 *
 * Re-exported from `@plastago/shared` rather than declared here: the console's
 * file pickers check the same ceiling, and two copies of the number drift the
 * first time one of them is raised.
 */
export { MAX_UPLOAD_BYTES } from '@plastago/shared';

/** The only non-id owner `buildKey` accepts. See the note there. */
export const SETTINGS_OWNER = 'singleton';

/**
 * Builds the key an object lives at.
 *
 * ── Why the shape is `plastago/jobs/<id>/photos/<uuid>.<ext>` ─────────────
 * Prefixed by owner so a lifecycle rule, a bulk delete or an access policy can
 * be written against a path rather than a database query. Ending in a UUID
 * rather than the driver's filename: two phones both produce `IMG_0001.jpg`, and
 * a caller-supplied name is a path-traversal vector besides.
 */
export function buildKey(input: {
  /*
   * `defects` is owned by the DRIVER's user id rather than the truck's, and
   * that is not an oversight. A defect photo is taken while the form is being
   * filled in — before the defect record exists — and the driver's pairing
   * gives a plate, not an id, so there is no vehicle id in hand at that moment.
   * The reporting driver is the one real id available, and grouping by it still
   * gives a lifecycle rule and a bulk delete something to match on.
   */
  scope:
    | 'jobs'
    | 'runs'
    | 'vehicles'
    | 'defects'
    | 'invoices'
    | 'certificates'
    | 'leads'
    | 'purchase-orders'
    | 'settings';
  ownerId: string;
  kind: string;
  contentType: string;
}): string {
  const extension = EXTENSIONS[input.contentType] ?? 'bin';
  /*
   * The owner id is checked rather than trusted: it reaches here from a route
   * parameter, and a `..` in a storage key escapes the prefix it is meant to
   * stay inside.
   *
   * `settings` is the one owner that is not a document id, because the settings
   * document is a singleton — it owns the invoice logo and the template
   * previews. Admitted as an exact literal rather than by relaxing the pattern,
   * so it can only ever be this one constant and never something that arrived
   * in a request.
   */
  const ownedBySingleton = input.scope === 'settings' && input.ownerId === SETTINGS_OWNER;

  if (!ownedBySingleton && !/^[a-f0-9]{24}$/i.test(input.ownerId)) {
    throw new Error(`Refusing to build a storage key for a non-id owner: ${input.ownerId}`);
  }
  /*
   * The prefix is applied HERE and nowhere else.
   *
   * Every key in the system is born in this function, so this is the one place
   * that can add it without a second place being able to disagree. In
   * particular the provider methods below take a key VERBATIM: a key read back
   * off a photo record already carries whatever prefix it was created under, so
   * prefixing inside `put`/`get`/`remove` would double it on write and lose the
   * old objects on read.
   */
  const path = `${input.scope}/${input.ownerId}/${input.kind}/${randomUUID()}.${extension}`;
  return env.S3_KEY_PREFIX ? `${env.S3_KEY_PREFIX}/${path}` : path;
}

/* ── The stub ────────────────────────────────────────────────────────────── */

/**
 * Keeps bytes under `STORAGE_STUB_DIR` and serves them from the API.
 *
 * The "presigned" upload URL points back at this API's own upload route rather
 * than at a signing service, so the client code path is identical to S3's: ask
 * for a URL, PUT the bytes to it, then reference the key. That is the whole
 * point — the phone must not know which provider is behind it.
 */
function createStubStorage(): StorageProvider {
  const root = resolve(process.cwd(), env.STORAGE_STUB_DIR);

  /**
   * Resolves a key to a path INSIDE the storage root, or throws.
   *
   * Defence in depth: keys are built by `buildKey` above and should already be
   * safe, but this is the last point before a filesystem write, and a traversal
   * here writes anywhere the process can reach.
   */
  const pathFor = (key: string): string => {
    const full = resolve(root, normalize(key));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error('Storage key escapes the storage root');
    }
    return full;
  };

  return {
    name: 'stub',

    presignUpload: async ({ key, contentType }) => {
      await mkdir(dirname(pathFor(key)), { recursive: true });

      /*
       * A short-lived HMAC over the key, so the upload route can verify that
       * this URL came from us. Without it the stub's upload endpoint would
       * accept a write to any key anybody named.
       */
      const expiresAt = Date.now() + env.S3_URL_TTL_SECONDS * 1000;
      const token = signStubToken(key, expiresAt);

      return {
        key,
        uploadUrl: `${env.AUTH_BASE_URL}/storage/${encodeURIComponent(key)}?expires=${String(expiresAt)}&token=${token}`,
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    presignDownload: (key) => {
      const expiresAt = Date.now() + env.S3_URL_TTL_SECONDS * 1000;
      const token = signStubToken(key, expiresAt);
      return Promise.resolve(
        `${env.AUTH_BASE_URL}/storage/${encodeURIComponent(key)}?expires=${String(expiresAt)}&token=${token}`,
      );
    },

    /*
     * `contentType` is deliberately unused. S3 stores it on the object; the
     * stub has no metadata to put it in, and inventing a sidecar file would be
     * one more thing to keep in step. It is recovered from the key's extension
     * on read instead — see `contentTypeForKey`.
     */
    put: async (key, body) => {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },

    get: (key) => Promise.resolve(createReadStream(pathFor(key))),

    remove: async (key) => {
      try {
        await unlink(pathFor(key));
      } catch {
        // Already gone is the outcome the caller wanted.
      }
    },

    exists: async (key) => {
      try {
        await stat(pathFor(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Signs a stub URL so only URLs this process issued are accepted.
 *
 * The real provider gets this from AWS SigV4; the stub has to do something
 * equivalent or it would be a world-writable bucket on the developer's laptop.
 */
export function signStubToken(key: string, expiresAt: number): string {
  return createHash('sha256')
    .update(`${key}:${String(expiresAt)}:${env.BETTER_AUTH_SECRET}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyStubToken(key: string, expiresAt: number, token: string): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = signStubToken(key, expiresAt);
  // Constant-time compare: a timing oracle on a 32-character hex token is a
  // small hole, but it is a free one to close.
  return timingSafeEqualHex(expected, token);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── S3 ──────────────────────────────────────────────────────────────────── */

/**
 * The real provider.
 *
 * Loaded lazily so `@aws-sdk/*` is never imported when `STORAGE_PROVIDER=stub`
 * — which keeps a developer laptop and the test suite free of an AWS dependency
 * they do not use.
 */
function createS3Storage(): StorageProvider {
  interface S3Deps {
    client: S3Client;
    commands: typeof S3Module;
    getSignedUrl: typeof GetSignedUrl;
  }

  let deps: Promise<S3Deps> | null = null;

  const load = async (): Promise<S3Deps> => {
    deps ??= (async () => {
      const [s3, presigner] = await Promise.all([
        import('@aws-sdk/client-s3'),
        import('@aws-sdk/s3-request-presigner'),
      ]);

      const client = new s3.S3Client({
        region: env.S3_REGION,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
        /*
         * Credentials are only passed when explicitly configured. Otherwise the
         * SDK's default chain finds the instance role, which is the better
         * deployment: nothing long-lived to leak or rotate.
         */
        ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: env.S3_ACCESS_KEY_ID,
                secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      });

      return { client, commands: s3, getSignedUrl: presigner.getSignedUrl };
    })();

    return deps;
  };

  /** Every command needs it, and it is validated at boot for this provider. */
  const bucket = (): string => {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_PROVIDER=s3');
    return env.S3_BUCKET;
  };

  return {
    name: 's3',

    presignUpload: async ({ key, contentType, contentLength }) => {
      const s3 = await load();
      const expiresIn = env.S3_URL_TTL_SECONDS;

      /*
       * `ContentType` and `ContentLength` are part of the signature, so the
       * phone cannot present a 20 MB URL and then upload 2 GB, nor claim a JPEG
       * and store an HTML document that the bucket would later serve.
       */
      const command = new s3.commands.PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
        // Belt and braces alongside the bucket's own default encryption.
        ServerSideEncryption: 'AES256',
      });

      const uploadUrl = await s3.getSignedUrl(s3.client, command, { expiresIn });

      return {
        key,
        uploadUrl,
        /*
         * ⚠️ Every header the presigner SIGNED must be listed here, or the PUT
         * is rejected with `SignatureDoesNotMatch` — S3 recomputes the
         * signature from the headers it actually receives.
         *
         * `ServerSideEncryption` above is the one that catches people out: the
         * SDK signs it as `x-amz-server-side-encryption` rather than hoisting
         * it into the query string, so a client that does not send the header
         * presents a signature over a request it did not make. It cannot be
         * inferred by the client either — encryption is our decision, made
         * here, so it has to be handed over with the URL.
         *
         * `Content-Length` a browser sets itself from the body and will not let
         * `fetch` override; it is declared anyway because the signature covers
         * it, and a non-browser caller (a script, the driver app's retry queue)
         * has to know to send the same number it asked to be signed.
         */
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(contentLength),
          'x-amz-server-side-encryption': 'AES256',
        },
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    },

    presignDownload: async (key) => {
      const s3 = await load();
      const command = new s3.commands.GetObjectCommand({ Bucket: bucket(), Key: key });
      return s3.getSignedUrl(s3.client, command, { expiresIn: env.S3_URL_TTL_SECONDS });
    },

    put: async (key, body, contentType) => {
      const s3 = await load();
      await s3.client.send(
        new s3.commands.PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
    },

    get: async (key) => {
      const s3 = await load();
      const result = (await s3.client.send(
        new s3.commands.GetObjectCommand({ Bucket: bucket(), Key: key }),
      )) as { Body: Readable };
      return result.Body;
    },

    remove: async (key) => {
      const s3 = await load();
      await s3.client.send(new s3.commands.DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    },

    exists: async (key) => {
      const s3 = await load();
      try {
        await s3.client.send(new s3.commands.HeadObjectCommand({ Bucket: bucket(), Key: key }));
        return true;
      } catch {
        return false;
      }
    },
  };
}

let provider: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  provider ??= env.STORAGE_PROVIDER === 's3' ? createS3Storage() : createStubStorage();
  return provider;
}

/** Test seam. Nothing in `src/` should call this. */
export function setStorageForTesting(next: StorageProvider | undefined): void {
  provider = next;
}

export function describeStorage(): {
  provider: string;
  bucket: string | null;
  prefix: string | null;
} {
  return {
    provider: env.STORAGE_PROVIDER,
    bucket: env.STORAGE_PROVIDER === 's3' ? (env.S3_BUCKET ?? null) : null,
    // Reported alongside the bucket because "the file is not in S3" and "the
    // file is in S3 under a prefix you were not looking at" are the same
    // symptom, and this is the cheapest place to tell them apart.
    prefix: env.S3_KEY_PREFIX || null,
  };
}

log.debug(
  { provider: env.STORAGE_PROVIDER, prefix: env.S3_KEY_PREFIX },
  'storage configured',
);

/** Exposed for the stub's read/write route, which must resolve keys the same way. */
export const stubStorageRoot = (): string => resolve(process.cwd(), env.STORAGE_STUB_DIR);
export const stubPathFor = (key: string): string => {
  const root = stubStorageRoot();
  const full = resolve(root, normalize(key));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('Storage key escapes the storage root');
  }
  return full;
};

export { join as joinStoragePath };
