import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, buildOpenApiDocument } from '@plastago/shared';

/**
 * Emits the OpenAPI document to disk (§6A.9).
 *
 * This is the artefact the separate Flutter repo consumes. Two rules:
 *   • CI runs this and publishes a VERSIONED spec — the mobile repo pins a
 *     version rather than chasing a moving target. Without that, two repos
 *     drift silently, which §6A.5 calls the main risk of splitting them.
 *   • Never hand-edit the output. Change the Zod schemas in `@plastago/shared`.
 */
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi');
const OUT_FILE = resolve(OUT_DIR, 'openapi.json');

async function main(): Promise<void> {
  const document = buildOpenApiDocument();
  const pathCount = Object.keys(document.paths ?? {}).length;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.warn(`OpenAPI ${API_VERSION} → ${OUT_FILE} (${String(pathCount)} paths)`);
}

await main();
