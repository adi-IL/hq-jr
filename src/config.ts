import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().default("test-gcp-project"),
  GOOGLE_CLOUD_LOCATION: z.string().default("global"),
  HQ_JR_MODEL_TIER1: z.string().default("gemini-3.8-flash"),
  HQ_JR_MODEL_TIER2: z.string().default("gemini-3.8-flash"),
  HQ_JR_MODEL_ESCALATION: z.string().default("gemini-4-argon"),
  HQ_JR_ESCALATION_MIN_RISK: z.enum(["LOW", "MEDIUM", "HIGH"]).default("HIGH"),
  HQ_JR_MODEL_DISCUSSION: z.string().default("gemini-3.8-flash"),
  HQ_JR_MODEL_REMEDIATION: z.string().default("gemini-3.8-flash"),
  HQ_JR_MODEL_HEALTH: z.string().default("gemini-3.8-flash"),
  HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(32768),
  HQ_JR_AGENT_TIER3: z.string().default("antigravity-preview-05-2026"),
  HQ_JR_AI_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  HQ_JR_DB_PATH: z.string().default("./data/hq-jr.db"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
});

export const config = envSchema.parse(process.env);

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
/** Rank for a risk level outside the known set: below LOW so it never escalates. */
const UNKNOWN_RISK_RANK = -1;

/** Single total order over risk levels: LOW < MEDIUM < HIGH. */
export function riskRank(risk: RiskLevel): number {
  return RISK_ORDER[risk] ?? UNKNOWN_RISK_RANK;
}

/** True when risk is at or above threshold under the riskRank order. */
export function riskAtLeast(risk: RiskLevel, threshold: RiskLevel): boolean {
  return riskRank(risk) >= riskRank(threshold);
}
