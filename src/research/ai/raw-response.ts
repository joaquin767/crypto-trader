// Shared write-once raw-response helper — specs/daily-catalyst-manual-trading.md §5.13, §10.2.
//
// Used by both AI client adapters (src/research/ai/anthropic-client.ts,
// src/research/ai/claude-cli-client.ts) so the write-once path and behavior (one file per
// dateUtc under snapshotRoot, gitignored like other snapshots) can never drift between them.
// Same pattern as src/research/snapshot-store.ts's writeSnapshot: "wx" refuses to clobber an
// existing file, and an EEXIST race is treated as success (another run already wrote it).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write-once raw response, path from `snapshotRoot` (the caller decides the root, this never
 *  writes outside it). Never includes the API key/OAuth token (the raw response body never
 *  carries request credentials). Any throw here (e.g. an unwritable `snapshotRoot`) propagates
 *  to the caller — each adapter wraps this in its own try/catch (§5.13 "MUST resolve"). */
export function writeRawResponseOnce(snapshotRoot: string, dateUtc: string, data: unknown): string {
  const dir = join(snapshotRoot, dateUtc);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ai-analyst.raw.json");
  if (!existsSync(path)) {
    try {
      writeFileSync(path, JSON.stringify(data, null, 2), { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return path;
}
