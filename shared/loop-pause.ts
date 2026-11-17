import { z, type ZodType } from "zod";

type RpcContract<InputSchema extends ZodType, OutputSchema extends ZodType> = {
  name: string;
  input: InputSchema;
  output: OutputSchema;
};

function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(input: {
  name: string;
  input: InputSchema;
  output: OutputSchema;
}): RpcContract<InputSchema, OutputSchema> {
  return input;
}

/** `agent`: the agent said "nothing to do" (soft, ends on any real prompt). `user`: the user paused it (hard). */
export const LOOP_PAUSE_KINDS = ["agent", "user"] as const;
export type LoopPauseKind = (typeof LOOP_PAUSE_KINDS)[number];

/** What a pause or resume did, in words the user or the agent can act on. */
export const LoopStateSchema = z.object({
  paused: z.boolean(),
  kind: z.enum(LOOP_PAUSE_KINDS).nullable(),
  message: z.string(),
});
export type LoopState = z.infer<typeof LoopStateSchema>;

/** Used by the `/roles-pause-agent-loop` and `/roles-resume-agent-loop` slash commands (a user pause is hard). */
export const setAgentLoopPaused = defineRpc({
  name: "roles.set-agent-loop-paused",
  input: z.object({ agentId: z.string().min(1), paused: z.boolean() }),
  output: LoopStateSchema,
});

/** Timeline row appended when a loop is paused or resumed. Each event is its own row, so it sits where it happened. */
export const LOOP_ROW_KIND = "loop-state";
export const LoopRowSchema = z.object({ text: z.string() });
