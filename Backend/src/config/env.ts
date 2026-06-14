import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/v3"),
  ARK_MODEL: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  CONDUIT_REPO_PATH: z.string().optional(),
  WORKSPACE_DB_PATH: z.string().default("./data/workspaces.sqlite"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  // Git / GitHub 认证与配置
  GIT_USER_NAME: z.string().optional(),
  GIT_USER_EMAIL: z.string().optional(),
  GIT_AUTH_TOKEN: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().optional(),
  GITHUB_REPO: z.string().optional(),
  GITHUB_BASE_BRANCH: z.string().default("main"),
  GITHUB_REMOTE: z.string().default("origin"),
  // JSON Skill 配置目录（不存在时不报错）
  SKILL_CONFIG_DIR: z.string().optional(),
});

export const env = envSchema.parse(process.env);
