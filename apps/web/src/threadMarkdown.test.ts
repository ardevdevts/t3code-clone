import { describe, expect, it } from "vite-plus/test";

import { buildThreadMarkdown } from "./threadMarkdown";

const makeMessage = (
  overrides: Partial<{ role: "user" | "assistant" | "system"; text: string; attachments: Array<{ type: "image"; name: string }> }>,
) => ({
  id: "msg_test",
  turnId: null,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
  role: overrides.role ?? "user",
  text: overrides.text ?? "",
  attachments: overrides.attachments ?? [],
}) as any;

describe("buildThreadMarkdown", () => {
  it("builds a markdown document with a heading for each role", () => {
    const result = buildThreadMarkdown({
      title: "Fix the build",
      messages: [
        makeMessage({ role: "user", text: "Build is broken" }),
        makeMessage({ role: "assistant", text: "Let me look at it." }),
      ],
    });

    expect(result).toBe(
      "# Fix the build\n\n## User\n\nBuild is broken\n\n## Assistant\n\nLet me look at it.\n",
    );
  });

  it("omits empty messages", () => {
    const result = buildThreadMarkdown({
      title: "Thread",
      messages: [
        makeMessage({ role: "user", text: "" }),
        makeMessage({ role: "assistant", text: "Only this one matters." }),
      ],
    });

    expect(result).toBe("# Thread\n\n## Assistant\n\nOnly this one matters.\n");
  });

  it("appends attachment annotations for image attachments", () => {
    const result = buildThreadMarkdown({
      title: "Thread",
      messages: [
        makeMessage({
          role: "user",
          text: "See screenshot",
          attachments: [{ type: "image", name: "error.png" }],
        }),
      ],
    });

    expect(result).toContain("_Attached image: error.png_");
  });

  it("falls back to a placeholder heading when title is empty", () => {
    const result = buildThreadMarkdown({
      title: "",
      messages: [makeMessage({ role: "user", text: "Hello" })],
    });

    expect(result).toMatch(/^# Thread\n/);
  });

  it("includes a no-messages note when there are no content messages", () => {
    const result = buildThreadMarkdown({
      title: "Empty thread",
      messages: [],
    });

    expect(result).toContain("_No messages found._");
  });
});
