import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "./index.js";

describe("buildReviewPrompt", () => {
  it("scrubs credentials from PR title and body", () => {
    const githubToken = `ghp_${"A".repeat(36)}`;

    const prompt = buildReviewPrompt({
      pullNumber: 7,
      title: `leak ${githubToken}`,
      body: "password=supersecretvalue",
      author: "alice",
      files: [{ path: "src/auth.ts", risk: "HIGH", reason: "credential handling" }],
      promptPayload: "### File: src/auth.ts",
    });

    expect(prompt).not.toContain(githubToken);
    expect(prompt).not.toContain("supersecretvalue");
    expect(prompt).toContain("[REDACTED_SECRET]");
    expect(prompt).toContain("untrusted metadata");
    expect(prompt).toContain("src/auth.ts");
  });
});
