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
  "git_config_identity",
  "git_create_branch",
  "git_commit_changes",
  "git_push_branch",
  "github_create_pr",
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
  /** Skill 命中原因摘要（命中关键词、匹配的 pattern/scope），前端 tooltip 展示 */
  skillMatchReason: z.object({
    skillId: z.string(),
    skillName: z.string(),
    matchedPattern: z.string(),
    matchedScope: z.string().optional(),
    hitKeywords: z.array(z.string()),
  }).optional(),
});

export type RuntimeToolName = z.infer<typeof runtimeToolNameSchema>;
export type RuntimeToolCall = z.infer<typeof runtimeToolCallSchema>;
export type AgentRuntimeTrace = z.infer<typeof agentRuntimeTraceSchema>;

