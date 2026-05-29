import { z } from "zod";

export const runtimeToolNameSchema = z.enum([
  "list_files",
  "read_file",
  "read_agent_guide",
  "git_status",
  "detect_test_commands",
  "detect_workflow_commands",
  "run_command",
  "write_file",
  "git_checkout_branch",
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
  /** 命中的 Skill id，用于在 UI / API 中展示本次由哪个 Skill 控制执行 */
  selectedSkillId: z.string().optional(),
});

export type RuntimeToolName = z.infer<typeof runtimeToolNameSchema>;
export type RuntimeToolCall = z.infer<typeof runtimeToolCallSchema>;
export type AgentRuntimeTrace = z.infer<typeof agentRuntimeTraceSchema>;

