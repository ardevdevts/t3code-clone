import type { OrchestrationMessage, ScopedThreadRef } from "@t3tools/contracts";
import { fetchEnvironmentThreadSnapshot } from "@t3tools/client-runtime/state/threads";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";

import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { readThreadDetail } from "./state/entities";
import { readPreparedConnection } from "./state/session";
import { runtime } from "./lib/runtime";

const ROLE_LABELS: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

/**
 * Pure function that serialises a thread's title and messages into a markdown
 * document suitable for copying or saving. Every non-empty message is
 * represented with a heading for the role and the message text. Image
 * attachments that cannot be embedded are annotated inline.
 */
export function buildThreadMarkdown(input: {
  readonly title: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}): string {
  const { title, messages } = input;
  const blocks: string[] = [];

  for (const message of messages) {
    const hasText = message.text.trim().length > 0;
    const attachments = message.attachments ?? [];
    if (!hasText && attachments.length === 0) continue;

    blocks.push(`## ${ROLE_LABELS[message.role] ?? message.role}`);

    if (hasText) {
      blocks.push(message.text.trim());
    }
    for (const attachment of attachments) {
      blocks.push(`_Attached image: ${attachment.name}_`);
    }
  }

  const header = `# ${title || "Thread"}`;
  if (blocks.length === 0) {
    return `${header}\n\n_No messages found._\n`;
  }

  return `${header}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Resolves the full conversation content for a thread.
 *
 * First checks the client-side detail cache (fast, no network). If that is
 * unavailable — for example for a thread that was never opened in the current
 * session — falls back to the HTTP thread-snapshot endpoint which returns the
 * full conversation regardless of client subscription state.
 */
async function resolveThreadForExport(ref: ScopedThreadRef): Promise<{
  readonly title: string;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
} | null> {
  // Fast path: the thread detail is already cached locally.
  const cached = readThreadDetail(ref);
  if (cached !== null) {
    return { title: cached.title, messages: cached.messages };
  }

  // Slow path: fetch the full snapshot over HTTP.
  const prepared = readPreparedConnection(ref.environmentId);
  if (!prepared) return null;

  try {
    const signer = await runtime.runPromise(
      Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    );
    const snapshot = await runtime.runPromise(
      fetchEnvironmentThreadSnapshot({
        prepared,
        threadId: ref.threadId,
        signer,
      }),
    );
    return { title: snapshot.thread.title, messages: snapshot.thread.messages };
  } catch {
    return null;
  }
}

/**
 * Load a thread's full content and copy it to the clipboard as markdown.
 *
 * Resolves against the server via HTTP for the authoritative snapshot, falling
 * back to the locally cached detail when the connection is unavailable.
 */
export async function copyThreadAsMarkdownToClipboard(ref: ScopedThreadRef): Promise<boolean> {
  const thread = await resolveThreadForExport(ref);
  if (thread === null) return false;
  const markdown = buildThreadMarkdown(thread);
  await writeTextToClipboard(markdown, "thread markdown");
  return true;
}
