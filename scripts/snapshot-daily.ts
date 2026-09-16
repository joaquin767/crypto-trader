// snapshot:daily CLI — specs/daily-catalyst-manual-trading.md §5.12 (Phase 1 slice).
//
// Scheduled decision time is <date>T00:15:00Z (default: today UTC); the effective decision time is
// resolved after fetching (see resolveDecisionTime). Runs every Phase 1 source adapter
// for config.symbols, writes each snapshot write-once (§5.2), builds FeatureVectors (§5.3),
// and prints `{ sources: [{sourceId,status,statusDetail,rows}], features: FeatureVector[] }`
// as JSON to stdout.
//
// Exit codes: 0 whenever snapshots were written (any status, including all-"unavailable");
// 3 if a snapshot for the date already exists and --revision was not given; 4 if the decision
// time is in the future.
//
// Usage: node --experimental-strip-types scripts/snapshot-daily.ts --config ./config.json
//   [--date YYYY-MM-DD] [--revision N] [--snapshot-root <dir>]
// (--snapshot-root is not in the spec's CLI list; it exists so a live smoke run or a test can
// point snapshots outside the repo instead of the committed data/snapshots default.)

import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.ts";
import type { AdapterDeps } from "../src/research/http.ts";
import { defaultAdapterDeps } from "../src/research/http.ts";
import { buildFeatures, DEFAULT_STALENESS_MS } from "../src/research/features.ts";
import { readSnapshots, writeSnapshot } from "../src/research/snapshot-store.ts";
import { createAllSourceAdapters } from "../src/research/sources/index.ts";
import type { FeatureVector, SourceSnapshot } from "../src/research/types.ts";

export interface SnapshotDailyArgs {
  date: string;
  revision: number;
  revisionProvided: boolean;
  configPath: string;
  snapshotRoot: string;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function parseSnapshotDailyArgs(argv: readonly string[], now: number): SnapshotDailyArgs {
  const revisionStr = flagValue(argv, "--revision");
  return {
    date: flagValue(argv, "--date") ?? todayUtc(now),
    revision: revisionStr !== undefined ? Number.parseInt(revisionStr, 10) : 0,
    revisionProvided: revisionStr !== undefined,
    configPath: flagValue(argv, "--config") ?? "./config.json",
    snapshotRoot: flagValue(argv, "--snapshot-root") ?? "data/snapshots",
  };
}

export type SnapshotDailyDecision =
  | { kind: "proceed"; decisionTime: number }
  | { kind: "exit"; code: 3 | 4; message: string };

/** Factored out from runSnapshotDaily so the exit-code logic is unit-testable without spawning
 *  the CLI or touching the filesystem/network. */
export function decideSnapshotAction(
  args: Pick<SnapshotDailyArgs, "date" | "revision" | "revisionProvided">,
  now: number,
  hasExistingSnapshots: boolean,
): SnapshotDailyDecision {
  const decisionTime = Date.parse(`${args.date}T00:15:00Z`);
  if (!Number.isFinite(decisionTime)) {
    return { kind: "exit", code: 4, message: `invalid --date "${args.date}"` };
  }
  if (decisionTime > now) {
    return { kind: "exit", code: 4, message: `decision time ${new Date(decisionTime).toISOString()} is in the future` };
  }
  if (!args.revisionProvided && hasExistingSnapshots) {
    return { kind: "exit", code: 3, message: `snapshots for ${args.date} already exist; pass --revision N to add a new one` };
  }
  return { kind: "proceed", decisionTime };
}

/** A live run finishes fetching after the scheduled 00:15 by construction, so sources whose
 *  availableAt is their fetchedAt would always fail the P2 filter against the scheduled time.
 *  When every fetch landed inside [scheduled, scheduled + LIVE_WINDOW_MS], the data was genuinely
 *  in hand at the last fetchedAt, which becomes the decision time. Otherwise (a backdated or late
 *  run) the scheduled time stands and later-fetched sources are filtered out, as P2 requires. */
export const LIVE_WINDOW_MS = 2 * 60 * 60_000;

export function resolveDecisionTime(
  scheduledDecisionTime: number,
  fetchedAts: readonly number[],
): { decisionTime: number; mode: "live" | "scheduled" } {
  if (fetchedAts.length === 0) return { decisionTime: scheduledDecisionTime, mode: "scheduled" };
  const allInWindow = fetchedAts.every(
    (t) => t >= scheduledDecisionTime && t <= scheduledDecisionTime + LIVE_WINDOW_MS,
  );
  if (!allInWindow) return { decisionTime: scheduledDecisionTime, mode: "scheduled" };
  return { decisionTime: Math.max(...fetchedAts), mode: "live" };
}

export interface SnapshotDailyOutput {
  scheduledDecisionTime: number;
  decisionTime: number;
  decisionMode: "live" | "scheduled";
  sources: { sourceId: string; status: string; statusDetail: string; rows: SourceSnapshot["rows"] }[];
  features: FeatureVector[];
}

export interface SnapshotDailyResult {
  exitCode: number;
  message?: string;
  output?: SnapshotDailyOutput;
}

export async function runSnapshotDaily(args: SnapshotDailyArgs, deps: AdapterDeps): Promise<SnapshotDailyResult> {
  const now = deps.now();
  const existing = readSnapshots(args.date, { rootDir: args.snapshotRoot });
  const decision = decideSnapshotAction(args, now, existing.length > 0);
  if (decision.kind === "exit") {
    return { exitCode: decision.code, message: decision.message };
  }

  const config = loadConfig(args.configPath);
  const adapters = createAllSourceAdapters(deps);

  const snapshots: SourceSnapshot[] = [];
  for (const adapter of adapters) {
    const snap = await adapter.fetch(decision.decisionTime, config.symbols);
    writeSnapshot(args.date, snap, { revision: args.revision, rootDir: args.snapshotRoot });
    snapshots.push(snap);
  }

  const resolved = resolveDecisionTime(decision.decisionTime, snapshots.map((s) => s.fetchedAt));
  const features = buildFeatures(snapshots, config.symbols, resolved.decisionTime, DEFAULT_STALENESS_MS);

  return {
    exitCode: 0,
    output: {
      scheduledDecisionTime: decision.decisionTime,
      decisionTime: resolved.decisionTime,
      decisionMode: resolved.mode,
      sources: snapshots.map((s) => ({ sourceId: s.sourceId, status: s.status, statusDetail: s.statusDetail, rows: s.rows })),
      features,
    },
  };
}

async function main(): Promise<void> {
  const deps = defaultAdapterDeps();
  const args = parseSnapshotDailyArgs(process.argv.slice(2), deps.now());
  const result = await runSnapshotDaily(args, deps);
  if (result.output) {
    console.log(JSON.stringify(result.output, null, 2));
  }
  if (result.message) {
    console.error(result.message);
  }
  process.exitCode = result.exitCode;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
