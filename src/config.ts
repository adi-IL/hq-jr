import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().default("test-gcp-project"),
  GOOGLE_CLOUD_LOCATION: z.string().default("global"),
  HQ_JR_MODEL_TIER1: z.string().default("gemini-3.8-flash"),
  HQ_JR_MODEL_TIER2: z.string().default("gemini-3.8-flash"),
  HQ_JR_AGENT_TIER3: z.string().default("antigravity-preview-05-2026"),
  HQ_JR_DB_PATH: z.string().default("./data/hq-jr.db"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
});

export const config = envSchema.parse(process.env);
