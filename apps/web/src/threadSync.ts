import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing";

/**
 * How long a sync phase must persist before the status pill is shown. Brief
 * re-syncs on refocus resolve in a few hundred milliseconds; showing the pill
 * for those reads as a flicker, so it only appears for syncs that outlast
 * this window.
 */
export const THREAD_SYNC_REVEAL_DELAY_MS = 500;

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  return phase === "loading" ? "Loading messages..." : "Syncing messages...";
}
