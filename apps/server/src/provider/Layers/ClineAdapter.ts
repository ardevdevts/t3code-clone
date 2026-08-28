/**
 * ClineAdapter — Cline CLI (`cline --acp`) via ACP.
 *
 * Uses the shared AcpSessionRuntime for ACP protocol handling.
 *
 * @module provider/Layers/ClineAdapter
 */

import {
  ApprovalRequestId,
  type ClineSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ClineAdapterShape } from "../Services/ClineAdapter.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { parseSessionUpdateEvent, type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("cline");

const CLINE_RESUME_VERSION = 1 as const;

function parseClineResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== CLINE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

interface ClineTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

function toToolLifecycleItemType(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function resolveTurnSnapshot(context: ClineSessionContext, turnId: TurnId): ClineTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: ClineTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: ClineSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingElicitation {
  readonly answers: Deferred.Deferred<Record<string, unknown>>;
}

interface ClineSessionContext {
  session: ProviderSession;
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly directory: string;
  readonly clineSessionId: string;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingElicitations: Map<string, PendingElicitation>;
  turns: Array<ClineTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface ClineAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toRequestError = (cause: unknown, method: string): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

function mapAcpError(cause: EffectAcpErrors.AcpError): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: "acp",
    detail: cause.message ?? String(cause),
    cause,
  });
}

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, ClineSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

function updateProviderSession(
  context: ClineSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const stopClineContext = Effect.fn("stopClineContext")(function* (context: ClineSessionContext) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }

  yield* context.runtime.cancel.pipe(Effect.ignore({ log: true }));
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

function buildClineSpawnInput(
  binaryPath: string,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: binaryPath,
    args: ["--acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function makeClineAdapter(clineSettings: ClineSettings, options?: ClineAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cline");
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, ClineSessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Cline runtime identifier.",
            cause,
          }),
      ),
    );
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "acp.jsonrpc" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopClineContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const handleSessionUpdate = Effect.fn("handleSessionUpdate")(function* (
      context: ClineSessionContext,
      notification: EffectAcpSchema.SessionNotification,
    ) {
      const turnId = context.activeTurnId;
      const parsed = parseSessionUpdateEvent(notification);

      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.clineSessionId,
          type: "session.update",
          ...(turnId ? { turnId } : {}),
          payload: notification,
        },
      });

      for (const event of parsed.events) {
        if (event._tag === "ContentDelta") {
          if (event.text.trim().length > 0) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: event.itemId,
                raw: "rawPayload" in event ? event.rawPayload : notification,
              })),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: event.text,
              },
            });
          }
        } else if (event._tag === "ToolCallUpdated") {
          const toolCall = event.toolCall;
          const itemType = toToolLifecycleItemType(toolCall.kind);
          const toolName = toolCall.command ?? toolCall.kind ?? toolCall.title ?? "tool";
          const isCompleted = toolCall.status === "completed" || toolCall.status === "failed";
          const payload = {
            itemType,
            status: isCompleted ? ("completed" as const) : ("inProgress" as const),
            title: toolCall.title ?? toolName,
            detail: toolCall.detail,
            data: {
              tool: toolName,
              status: toolCall.status,
              ...(toolCall.detail ? { detail: toolCall.detail } : {}),
            },
          };
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: toolCall.toolCallId,
              raw: "rawPayload" in event ? event.rawPayload : notification,
            })),
            type: isCompleted ? "item.completed" : "item.updated",
            payload,
          });
          appendTurnItem(context, turnId, { toolCall });
        } else if (event._tag === "PlanUpdated") {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: "rawPayload" in event ? event.rawPayload : notification,
            })),
            type: "turn.plan.updated",
            payload: {
              explanation: event.payload.explanation,
              plan: event.payload.plan.map((step) => ({
                step: step.step,
                status: step.status,
              })),
            },
          });
        }
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: ClineSessionContext) {
      yield* context.runtime.getEvents().pipe(
        Stream.runForEach((event) => {
          if (event._tag === "EventStreamBarrier") {
            return Effect.void;
          }
          const notification = "rawPayload" in event ? event.rawPayload : null;
          if (notification) {
            return handleSessionUpdate(
              context,
              notification as EffectAcpSchema.SessionNotification,
            );
          }
          return Effect.void;
        }),
        Effect.forkIn(context.sessionScope),
      );
    });

    const startSession: ClineAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseClineResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopClineContext(existing);
          sessions.delete(input.threadId);
        }

        const runtimeLayer = AcpSessionRuntime.layer({
          spawn: buildClineSpawnInput(clineSettings.binaryPath, directory, options?.environment),
          cwd: directory,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.1" },
          authMethodId: "cline_login",
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          ),
        );

        const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(runtimeLayer),
        );

        // Register handlers for permission requests and elicitation
        const pendingApprovals = new Map<string, PendingApproval>();
        const pendingElicitations = new Map<string, PendingElicitation>();

        yield* runtime.handleRequestPermission((request) =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(request.toolCall.toolCallId, { decision: deferred });
            return yield* Deferred.await(deferred).pipe(
              Effect.map((decision) => ({
                outcome:
                  decision === "cancel" || decision === "decline"
                    ? ({ outcome: "cancelled" } as const)
                    : ({ outcome: "selected", optionId: "allow_once" } as const),
              })),
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to process Cline permission response.",
                    cause,
                  }),
              ),
            );
          }),
        );

        yield* runtime.handleElicitation((request) =>
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<Record<string, unknown>>();
            const elicitationId =
              "elicitationId" in request ? request.elicitationId : request.sessionId;
            pendingElicitations.set(elicitationId, { answers: deferred });
            return yield* Deferred.await(deferred).pipe(
              Effect.map((answers) => ({
                action: "accept",
                content: answers,
              })),
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to process Cline elicitation response.",
                    cause,
                  }),
              ),
            );
          }),
        );
        const startResult = yield* runtime
          .start()
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: CLINE_RESUME_VERSION,
            sessionId: startResult.sessionId,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: ClineSessionContext = {
          session,
          runtime,
          directory,
          clineSessionId: startResult.sessionId,
          pendingApprovals,
          pendingElicitations,
          turns: [],
          activeTurnId: undefined,
          stopped: yield* Ref.make(false),
          sessionScope: yield* Scope.make(),
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "Cline session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: startResult.sessionId,
          },
        });

        return session;
      },
    );

    const sendTurn: ClineAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      const turnId = TurnId.make(yield* randomUUIDv4);
      context.activeTurnId = turnId;

      yield* updateProviderSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          ...(typeof input.modelSelection?.options?.find((o) => o.id === "reasoningEffort")
            ?.value === "string"
            ? {
                effort: input.modelSelection.options.find((o) => o.id === "reasoningEffort")!
                  .value as string,
              }
            : {}),
        },
      });

      const promptText = input.input ?? "";
      const promptBlocks: EffectAcpSchema.ContentBlock[] = [{ type: "text", text: promptText }];
      const response = yield* context.runtime
        .prompt({ prompt: promptBlocks })
        .pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
          ),
        );

      yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: {
          schemaVersion: CLINE_RESUME_VERSION,
          sessionId: context.clineSessionId,
        },
      };
    });

    const interruptTurn: ClineAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        if (turnId && context.activeTurnId !== turnId) {
          return;
        }
        yield* context.runtime.cancel.pipe(Effect.ignore({ log: true }));
        if (context.activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: context.activeTurnId })),
            type: "turn.aborted",
            payload: { reason: "User interrupted" },
          });
        }
        yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
      },
    );

    const respondToRequest: ClineAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
      function* (threadId, requestId, decision) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `Permission request ${requestId} not found`,
          });
        }
        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      },
    );

    const respondToUserInput: ClineAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const pending = context.pendingElicitations.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Elicitation request ${requestId} not found`,
        });
      }
      context.pendingElicitations.delete(requestId);

      const responsePayload = Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [key, value]),
      );

      yield* Deferred.succeed(pending.answers, responsePayload);

      yield* emit({
        ...(yield* buildEventBase({ threadId, requestId })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const stopSession: ClineAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return;
        }
        yield* stopClineContext(context);
        sessions.delete(threadId);
      },
    );

    const listSessions: ClineAdapterShape["listSessions"] = () =>
      Effect.succeed([...sessions.values()].map((ctx) => ctx.session));

    const hasSession: ClineAdapterShape["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId));

    const readThread: ClineAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({ id: turn.id, items: turn.items })),
        };
      },
    );

    const rollbackThread: ClineAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        if (numTurns <= 0 || context.turns.length === 0) {
          return {
            threadId,
            turns: context.turns.map((turn) => ({ id: turn.id, items: turn.items })),
          };
        }
        const turnsToKeep = Math.max(0, context.turns.length - numTurns);
        context.turns = context.turns.slice(0, turnsToKeep);
        return {
          threadId,
          turns: context.turns.map((turn) => ({ id: turn.id, items: turn.items })),
        };
      },
    );

    const stopAll: ClineAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopClineContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    const streamEvents = Stream.fromQueue(runtimeEvents);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported" as const,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies ClineAdapterShape;
  });
}
