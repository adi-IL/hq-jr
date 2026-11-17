import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export const THINKING_LEVELS = ["LOW", "MEDIUM", "HIGH", "XHIGH"] as const;
export type ThinkingLevelSetting = (typeof THINKING_LEVELS)[number];

const MODEL_THINKING_PAIRS = [
  ["HQ_JR_MODEL_TIER1", "HQ_JR_THINKING_TIER1"],
  ["HQ_JR_MODEL_TIER2", "HQ_JR_THINKING_TIER2"],
  ["HQ_JR_MODEL_ESCALATION", "HQ_JR_THINKING_ESCALATION"],
  ["HQ_JR_MODEL_DISCUSSION", "HQ_JR_THINKING_DISCUSSION"],
  ["HQ_JR_MODEL_REMEDIATION", "HQ_JR_THINKING_REMEDIATION"],
  ["HQ_JR_MODEL_HEALTH", "HQ_JR_THINKING_HEALTH"],
] as const;

export function isGemini4Argon(modelName: string): boolean {
  return modelName === "gemini-4-argon" || modelName.endsWith("/gemini-4-argon");
}

const envSchema = z
  .object({
    GOOGLE_CLOUD_PROJECT: z.string().default("test-gcp-project"),
    GOOGLE_CLOUD_LOCATION: z.literal("global", {
      error: 'GOOGLE_CLOUD_LOCATION must be "global" for Gemini 4 models.',
    }).default("global"),
    HQ_JR_MODEL_TIER1: z.string().trim().min(1, "HQ_JR_MODEL_TIER1 must not be empty").default("gemini-4-hydrogen"),
    HQ_JR_MODEL_TIER2: z.string().trim().min(1, "HQ_JR_MODEL_TIER2 must not be empty").default("gemini-4-hydrogen"),
    HQ_JR_MODEL_ESCALATION: z.string().trim().min(1, "HQ_JR_MODEL_ESCALATION must not be empty").default("gemini-4-argon"),
    HQ_JR_ESCALATION_MIN_RISK: z.enum(["LOW", "MEDIUM", "HIGH"]).default("HIGH"),
    HQ_JR_MODEL_DISCUSSION: z.string().trim().min(1, "HQ_JR_MODEL_DISCUSSION must not be empty").default("gemini-4-hydrogen"),
    HQ_JR_MODEL_REMEDIATION: z.string().trim().min(1, "HQ_JR_MODEL_REMEDIATION must not be empty").default("gemini-4-hydrogen"),
    HQ_JR_MODEL_HEALTH: z.string().trim().min(1, "HQ_JR_MODEL_HEALTH must not be empty").default("gemini-4-hydrogen"),
    HQ_JR_THINKING_TIER1: z.enum(THINKING_LEVELS).default("HIGH"),
    HQ_JR_THINKING_TIER2: z.enum(THINKING_LEVELS).default("HIGH"),
    HQ_JR_THINKING_ESCALATION: z.enum(THINKING_LEVELS).default("HIGH"),
    HQ_JR_THINKING_DISCUSSION: z.enum(THINKING_LEVELS).default("HIGH"),
    HQ_JR_THINKING_REMEDIATION: z.enum(THINKING_LEVELS).default("HIGH"),
    HQ_JR_THINKING_HEALTH: z.enum(THINKING_LEVELS).default("LOW"),
    HQ_JR_ESCALATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(32768),
    HQ_JR_AGENT_TIER3: z.string().default("antigravity-preview-05-2026"),
    HQ_JR_AI_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
    HQ_JR_DB_PATH: z.string().default("./data/hq-jr.db"),
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((data, ctx) => {
    for (const [modelField, thinkingField] of MODEL_THINKING_PAIRS) {
      if (isGemini4Argon(data[modelField]) && data[thinkingField] === "XHIGH") {
        ctx.addIssue({
          code: "custom",
          path: [thinkingField],
          message: `${thinkingField} cannot be "XHIGH" when ${modelField} uses ${data[modelField]} (supported levels: LOW, MEDIUM, HIGH).`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses the environment. An unusable value fails here, at startup, with the
 * name of the offending variable, instead of silently degrading a stage later.
 */
export function parseEnv(env: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const config = parseEnv();

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
/** Rank for a risk level outside the known set: below LOW so it never escalates. */
const UNKNOWN_RISK_RANK = -1;

function isRiskLevel(risk: unknown): risk is RiskLevel {
  return typeof risk === "string" && Object.prototype.hasOwnProperty.call(RISK_ORDER, risk);
}

/**
 * Single total order over risk levels: LOW < MEDIUM < HIGH. Anything else,
 * including inherited keys such as "constructor", ranks as UNKNOWN_RISK_RANK.
 */
export function riskRank(risk: RiskLevel): number {
  return isRiskLevel(risk) ? RISK_ORDER[risk] : UNKNOWN_RISK_RANK;
}

/**
 * True when risk is at or above threshold under the riskRank order. An
 * unrecognized threshold never matches, so it cannot escalate every pull request.
 */
export function riskAtLeast(risk: RiskLevel, threshold: RiskLevel): boolean {
  if (!isRiskLevel(threshold)) return false;
  return riskRank(risk) >= riskRank(threshold);
}
