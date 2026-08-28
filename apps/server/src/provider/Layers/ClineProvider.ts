import {
  type ModelCapabilities,
  type ClineSettings,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const CLINE_PRESENTATION = {
  displayName: "Cline",
  showInteractionModeToggle: false,
} as const;
const MINIMUM_CLINE_VERSION = "0.1.0";

class ClineProbeError extends Data.TaggedError("ClineProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof ClineProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatClineProbeError(cause: unknown): {
  readonly installed: boolean;
  readonly message: string;
} {
  const detail = normalizedErrorMessage(cause);
  const lower = detail?.toLowerCase() ?? "";

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message:
        "Cline CLI (`cline`) is not installed or not on PATH. Install it with `npm i -g cline`.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the Cline binary (quarantine). Run `xattr -d com.apple.quarantine $(which cline)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the Cline process due to an invalid code signature. The binary may be corrupted — try reinstalling Cline.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute Cline CLI health check: ${detail}`
      : "Failed to execute Cline CLI health check.",
  };
}

function runClineVersionCheck(
  binaryPath: string,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<{ readonly stdout: string; readonly code: number }, ClineProbeError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<{ stdout: string; code: number }>((resolve, reject) => {
        const { spawn } = require("child_process");
        const proc = spawn(binaryPath, ["--version"], {
          cwd,
          env: { ...process.env, ...environment },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        proc.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        proc.on("close", (code: number) => {
          resolve({ stdout: stdout.trim(), code });
        });

        proc.on("error", (err: Error) => {
          reject(err);
        });
      }),
    catch: (cause) => new ClineProbeError({ cause, detail: String(cause) }),
  });
}

const DEFAULT_CLINE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const makePendingClineProvider = (
  clineSettings: ClineSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      clineSettings.customModels,
      DEFAULT_CLINE_MODEL_CAPABILITIES,
    );

    if (!clineSettings.enabled) {
      return buildServerProvider({
        presentation: CLINE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cline is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cline provider status has not been checked in this session yet.",
      },
    });
  });

export const checkClineProviderStatus = Effect.fn("checkClineProviderStatus")(function* (
  clineSettings: ClineSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = clineSettings.customModels;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatClineProbeError(cause);
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_CLINE_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!clineSettings.enabled) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_CLINE_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cline is disabled in T3 Code settings.",
      },
    });
  }

  const versionExit = yield* Effect.exit(
    runClineVersionCheck(clineSettings.binaryPath, cwd, resolvedEnvironment).pipe(
      Effect.mapError((cause) => new ClineProbeError({ cause, detail: String(cause) })),
    ),
  );

  if (versionExit._tag === "Failure") {
    return fallback(Cause.squash(versionExit.cause));
  }

  const version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

  if (!version) {
    return fallback(
      new Error(
        `Unable to determine Cline version from \`cline --version\` output. T3 Code requires Cline v${MINIMUM_CLINE_VERSION} or newer.`,
      ),
      null,
    );
  }

  if (compareSemverVersions(version, MINIMUM_CLINE_VERSION) < 0) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_CLINE_MODEL_CAPABILITIES),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Cline v${version} is too old. Upgrade to v${MINIMUM_CLINE_VERSION} or newer.`,
      },
    });
  }

  return buildServerProvider({
    presentation: CLINE_PRESENTATION,
    enabled: true,
    checkedAt,
    models: providerModelsFromSettings([], customModels, DEFAULT_CLINE_MODEL_CAPABILITIES),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: `Cline v${version} is available.`,
    },
  });
});
