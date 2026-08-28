/**
 * ClineTextGeneration – Text generation layer using the Cline CLI via ACP.
 *
 * @module ClineTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TextGeneration from "./TextGeneration.ts";

export const makeClineTextGeneration = Effect.fn("makeClineTextGeneration")(function* () {
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ClineTextGeneration.generateCommitMessage")(function* (input) {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail:
          "Text generation not implemented for Cline provider. Use Codex or Claude for commit message generation.",
      });
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("ClineTextGeneration.generatePrContent")(function* (input) {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail:
          "Text generation not implemented for Cline provider. Use Codex or Claude for PR content generation.",
      });
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("ClineTextGeneration.generateBranchName")(function* (input) {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail:
          "Text generation not implemented for Cline provider. Use Codex or Claude for branch name generation.",
      });
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("ClineTextGeneration.generateThreadTitle")(function* (input) {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail:
          "Text generation not implemented for Cline provider. Use Codex or Claude for thread title generation.",
      });
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
