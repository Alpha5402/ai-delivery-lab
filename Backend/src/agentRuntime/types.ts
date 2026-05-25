import { z } from "zod";

export const runtimeToolNameSchema = z.enum([
  "list_files",
  "read_file",
  "read_agent_guide",
  "git_status",
  "detect_test_commands",
]);

export const runtimeToolCallSchema = z.object({
  tool: runtimeToolNameSchema,
  input: z.record(z.unknown()).default({}),
  output: z.unknown(),
  durationMs: z.number().int().min(0),
});

export const agentRuntimeTraceSchema = z.object({
  runtime: z.literal("simple-agent-runtime"),
  workspaceId: z.string(),
  workspaceDir: z.string().optional(),
  observations: z.array(z.string()),
  toolCalls: z.array(runtimeToolCallSchema),
});

export type RuntimeToolName = z.infer<typeof runtimeToolNameSchema>;
export type RuntimeToolCall = z.infer<typeof runtimeToolCallSchema>;
export type AgentRuntimeTrace = z.infer<typeof agentRuntimeTraceSchema>;

