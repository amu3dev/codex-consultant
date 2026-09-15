import { z } from "zod";

export const codexConsultInputSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must not be empty"),
  cwd: z.string().trim().min(1, "cwd must not be empty").optional(),
  model: z.string().trim().min(1, "model must not be empty").optional(),
});

export const codexContinueInputSchema = z.object({
  threadId: z.string().trim().min(1, "threadId must not be empty"),
  prompt: z.string().trim().min(1, "prompt must not be empty"),
});

export const codexReviewInputSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must not be empty"),
  cwd: z.string().trim().min(1, "cwd must not be empty"),
});

export type CodexConsultInput = z.infer<typeof codexConsultInputSchema>;
export type CodexContinueInput = z.infer<typeof codexContinueInputSchema>;
export type CodexReviewInput = z.infer<typeof codexReviewInputSchema>;
