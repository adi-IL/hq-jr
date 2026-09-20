import { z } from "zod";

export const TriageFileVerdictSchema = z.object({
  path: z.string().describe("Relative path to the modified file"),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]).describe("Risk classification of the changes in this file"),
  reason: z.string().describe("Short explanation of why this risk was assigned"),
  shouldReview: z.boolean().describe("Whether this file requires deep semantic analysis"),
});

export const TriageResultSchema = z.object({
  summary: z.string().describe("High-level triage summary of changes"),
  overallRisk: z.enum(["LOW", "MEDIUM", "HIGH"]).describe("Overall risk level of the entire pull request"),
  files: z.array(TriageFileVerdictSchema).describe("Per-file risk verdicts"),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export const ReviewCommentSchema = z.object({
  path: z.string().describe("Target file path relative to repository root"),
  line: z.coerce.number().int().nonnegative().default(1).describe("Target line number in the diff (0 for file-level)"),
  side: z.enum(["RIGHT", "LEFT"]).default("RIGHT").describe("Diff side to attach comment to"),
  severity: z.enum(["CRITICAL", "WARNING", "SUGGESTION"]).describe("Severity level"),
  category: z.enum(["SECURITY", "BUG", "PERFORMANCE", "DESIGN", "STYLE"]).describe("Issue classification"),
  title: z.string().describe("Short declarative title of the issue"),
  body: z.string().describe("Actionable review explanation"),
  suggestedPatch: z.string().optional().describe("Concrete replacement code or patch snippet"),
});

export const SandboxProbeRequestSchema = z.object({
  targetFile: z.string().describe("File path under test"),
  targetLine: z.coerce.number().int().optional().describe("Source line under test"),
  archetype: z.enum([
    "UNIT_ASSERTION",
    "PROPERTY_BASED",
    "SUBPROCESS_PROBE",
    "FAULT_INJECTION",
  ]).describe("Test archetype for probing the defect"),
  failureHypothesis: z.string().describe("Boundary condition or invariant that triggers the defect"),
  expectedFailureKind: z.enum([
    "PANIC",
    "EXCEPTION",
    "RESOURCE_LEAK",
    "WRONG_OUTPUT",
    "CRASH",
  ]).describe("Expected mode of failure when unpatched"),
  suggestedPatch: z.string().optional().describe("Remediation patch snippet to verify fix"),
});

export type SandboxProbeRequest = z.infer<typeof SandboxProbeRequestSchema>;

export const DeepReviewResultSchema = z.object({
  summary: z.string().describe("Detailed architectural and semantic analysis summary"),
  verdict: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]).describe("Overall review verdict"),
  resolvedPriorIssues: z.array(z.string()).default([]).describe("Prior review issues verified as fixed in this commit"),
  unresolvedPriorIssues: z.array(z.string()).default([]).describe("Prior review issues that remain open or unaddressed"),
  comments: z.array(ReviewCommentSchema).describe("List of line-anchored review comments"),
  requiresSandboxVerification: z.boolean().default(false).describe("Whether critical issues require isolated test reproduction"),
  verificationGoal: z.string().optional().describe("Objective for Tier 3 sandbox agent if verification is requested"),
  sandboxProbes: z.array(SandboxProbeRequestSchema).default([]).describe("Structured adversarial probes for Tier 3 verification"),
});

export type DeepReviewResult = z.infer<typeof DeepReviewResultSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
