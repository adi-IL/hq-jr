import { describe, it, expect, vi } from "vitest";
import { TriageResultSchema, DeepReviewResultSchema } from "../schemas/review.js";
import { checkAiHealth, runTriage, pollSandboxInteraction, extractSandboxVerdict, ai } from "./ai.js";

describe("Review Schemas", () => {
  it("validates a well-formed triage payload", () => {
    const raw = {
      summary: "Added new user auth routes",
      overallRisk: "MEDIUM",
      files: [
        {
          path: "src/auth.ts",
          risk: "HIGH",
          reason: "Touches JWT validation logic",
          shouldReview: true,
        },
        {
          path: "package-lock.json",
          risk: "LOW",
          reason: "Auto-generated lockfile",
          shouldReview: false,
        },
      ],
    };

    const parsed = TriageResultSchema.parse(raw);
    expect(parsed.overallRisk).toBe("MEDIUM");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].shouldReview).toBe(true);
    expect(parsed.files[1].shouldReview).toBe(false);
  });

  it("validates a deep review result with inline comments", () => {
    const raw = {
      summary: "Found potential timing attack vulnerability in token check",
      verdict: "REQUEST_CHANGES",
      requiresSandboxVerification: false,
      comments: [
        {
          path: "src/auth.ts",
          line: 45,
          side: "RIGHT",
          severity: "CRITICAL",
          category: "SECURITY",
          title: "Insecure string comparison for HMAC tokens",
          body: "Use crypto.timingSafeEqual instead of strict equality to avoid timing attacks.",
          suggestedPatch: "crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))",
        },
      ],
    };

    const parsed = DeepReviewResultSchema.parse(raw);
    expect(parsed.verdict).toBe("REQUEST_CHANGES");
    expect(parsed.comments[0].severity).toBe("CRITICAL");
  });
});

describe.runIf(process.env.RUN_LIVE_TESTS === "true")("Vertex AI Live Health Check", () => {
  it("verifies live connectivity using ADC to Vertex AI", async () => {
    const health = await checkAiHealth();
    expect(health.status).toBe("ok");
    expect(health.latencyMs).toBeGreaterThan(0);
  }, 60000);

  it("executes live Tier 1 triage with Gemini 3.8 Flash structured output", async () => {
    // Small cooldown between API calls to prevent quota burst
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const diff = `
diff --git a/src/utils/sanitize.ts b/src/utils/sanitize.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/utils/sanitize.ts
@@ -0,0 +1,5 @@
+export function sanitizeHtml(input: string): string {
+  return input.replace(/<script.*?>.*?<\\/script>/gi, '');
+}
`;

    const triage = await runTriage(diff);
    expect(triage.summary).toBeDefined();
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(triage.overallRisk);
    expect(triage.files.length).toBeGreaterThan(0);
    expect(triage.files[0].path).toContain("sanitize.ts");
  }, 60000);
});

describe("pollSandboxInteraction status mapping", () => {
  it("returns incomplete when interactions.get throws", async () => {
    vi.spyOn(ai.interactions, "get").mockRejectedValueOnce(new Error("network down"));
    const result = await pollSandboxInteraction("ix-1", {
      maxWaitMs: 50,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    });
    expect(result.status).toBe("incomplete");
    expect(result.errorMessage).toContain("interactions.get failed");
  });

  it("preserves incomplete terminal status (not collapsed to failed)", async () => {
    vi.spyOn(ai.interactions, "get").mockResolvedValueOnce({
      status: "incomplete",
      output_text: "",
      errors: [{ message: "agent incomplete" }],
    } as never);
    const result = await pollSandboxInteraction("ix-2", {
      maxWaitMs: 50,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    });
    expect(result.status).toBe("incomplete");
  });

  it("maps budget_exceeded to failed and cancelled to cancelled", async () => {
    vi.spyOn(ai.interactions, "get").mockResolvedValueOnce({
      status: "budget_exceeded",
      output_text: "",
    } as never);
    const failed = await pollSandboxInteraction("ix-3", {
      maxWaitMs: 50,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    });
    expect(failed.status).toBe("failed");

    vi.spyOn(ai.interactions, "get").mockResolvedValueOnce({
      status: "cancelled",
      output_text: "",
    } as never);
    const cancelled = await pollSandboxInteraction("ix-4", {
      maxWaitMs: 50,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: async () => {},
    });
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("extractSandboxVerdict multi-fence", () => {
  it("skips non-verdict fences then parses a later verdict fence", () => {
    const text =
      "```json\n{\"meta\":true}\n```\n```json\n{\"reproduced\":true,\"patchCured\":false}\n```";
    const v = extractSandboxVerdict(text);
    expect(v?.reproduced).toBe(true);
    expect(v?.patchCured).toBe(false);
  });
});
