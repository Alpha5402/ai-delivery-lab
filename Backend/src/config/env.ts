import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/v3"),
  ARK_MODEL: z.string().optional(),
  CONDUIT_REPO_PATH: z.string().optional(),
  WORKSPACE_DB_PATH: z.string().default("./data/workspaces.sqlite"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
});

export const env = envSchema.parse(process.env);
