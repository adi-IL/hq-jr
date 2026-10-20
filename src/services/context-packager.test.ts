import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diff-parser.js";
import { packageReviewContext } from "./context-packager.js";

describe("Context Packager", () => {
  const multiFileDiff = `
diff --git a/package-lock.json b/package-lock.json
index 111..222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
-{"version": "1.0.0"}
+{"version": "1.0.1"}
diff --git a/src/controllers/items.ts b/src/controllers/items.ts
new file mode 100644
index 000..333 100644
--- /dev/null
+++ b/src/controllers/items.ts
@@ -0,0 +1,5 @@
+export function getItems() {
+  return ["item1", "item2"];
+}
diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts
new file mode 100644
index 000..444 100644
--- /dev/null
+++ b/src/auth/jwt.ts
@@ -0,0 +1,5 @@
+export function verifyToken(token: string) {
+  return token.length > 10;
+}
`;

  it("filters out noise files and orders review items by risk priority", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    const context = packageReviewContext(parsed);

    // package-lock.json should be in ignoredItems
    expect(context.ignoredItems).toHaveLength(1);
    expect(context.ignoredItems[0].path).toBe("package-lock.json");

    // itemsToReview should have 2 files
    expect(context.itemsToReview).toHaveLength(2);

    // Security file (jwt.ts) should be ranked first before items.ts
    const firstItem = context.itemsToReview[0];
    const secondItem = context.itemsToReview[1];

    expect(firstItem.file.newPath).toBe("src/auth/jwt.ts");
    expect(firstItem.filter.category).toBe("SECURITY");

    expect(secondItem.file.newPath).toBe("src/controllers/items.ts");
    expect(secondItem.filter.category).toBe("BACKEND");
  });

  it("enforces maxTotalChars budget and flags truncation", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    // Artificially tiny budget
    const context = packageReviewContext(parsed, { maxTotalChars: 150 });

    expect(context.promptPayload.length).toBeGreaterThan(0);
    expect(context.itemsToReview.length).toBeGreaterThanOrEqual(1);
    expect(context.itemsToReview[0].isTruncated).toBe(true);
  });

  it("keeps the payload inside a tiny budget and says that the diff was cut", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 150 });

    // The notice is part of the text that is sent, so the payload with the
    // notice has to stay inside the budget.
    expect(context.promptPayload.length).toBeLessThanOrEqual(150);
    expect(context.promptPayload).toContain("truncated to preserve context budget");
  });

  it("keeps the payload inside the budget for every budget", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);

    for (const budget of [60, 100, 150, 200, 300, 500, 1000, 5000]) {
      const context = packageReviewContext(parsed, { maxTotalChars: budget });
      expect(context.promptPayload.length).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the payload inside the budget when a secret is replaced by a longer placeholder", () => {
    const secretLines = Array.from({ length: 10 }, () => `+const api_key = "abcd1234";`).join("\n");
    const diff = `diff --git a/src/config.ts b/src/config.ts
index 111..222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,1 +1,11 @@
 export const port = 3000;
${secretLines}
`;
    // The placeholder is longer than the secret it replaces, so the budget
    // has to hold for the redacted text and not for the text before it.
    const context = packageReviewContext(parseUnifiedDiff(diff), { maxTotalChars: 650 });

    expect(context.promptPayload.length).toBeLessThanOrEqual(650);
    expect(context.promptPayload).toContain("[REDACTED_SECRET]");
    expect(context.promptPayload).not.toContain("abcd1234");
  });

  it("keeps the emitted file diff inside the per file budget", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    const context = packageReviewContext(parsed, { maxPerFileChars: 60 });

    for (const item of context.itemsToReview) {
      // The notice marks the cut, so the diff text itself stays inside the
      // per file budget.
      const content = item.formattedDiff.replace("\n... [diff truncated due to size limit]", "");
      expect(content.length).toBeLessThanOrEqual(60);
      expect(item.formattedDiff).toContain("truncated due to size limit");
    }
    expect(context.promptPayload.length).toBeLessThanOrEqual(120000);
  });

  it("bounds the ignored file list in the prompt payload", () => {
    const ignoredPaths = Array.from({ length: 3000 }, (_, index) => `docs/guide${index}.md`);
    const diff = [
      ...ignoredPaths.map(
        (path) =>
          `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+new\n`
      ),
      `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,2 @@
 export const app = 1;
+export const version = 2;
`,
    ].join("");
    const context = packageReviewContext(parseUnifiedDiff(diff));

    expect(context.ignoredItems).toHaveLength(3000);

    const ignoredSection = context.promptPayload
      .split("## Ignored / Pruned Files")[1]
      .split("## Diff Content")[0];
    const listed = ignoredSection
      .split("\n")
      .filter((line) => line.startsWith("- ") && !line.startsWith("- ..."));

    expect(listed.length).toBeLessThanOrEqual(50);
    expect(ignoredSection).toContain("2950 more ignored files not listed");
    expect(context.promptPayload).toContain("docs/guide0.md");
    expect(context.promptPayload).not.toContain("docs/guide2999.md");
    expect(context.promptPayload.length).toBeLessThanOrEqual(120000);
    expect(context.promptPayload).toContain("export const version = 2;");
  });

  describe("payload budget boundary", () => {
    /** One file diff with a fixed number of added lines. */
    const fileDiff = (path: string, addedLines: number) => {
      const added = Array.from(
        { length: addedLines },
        (_, index) => `+const added${index} = ${index};`
      ).join("\n");
      return `diff --git a/${path} b/${path}
index 111..222 100644
--- a/${path}
+++ b/${path}
@@ -1,3 +1,${3 + addedLines} @@
 const value = 1;
${added}
 export default value;
`;
    };

    // Three ignored files, so the ignored list uses the room it reserved from
    // the budget, and four reviewable files.
    const ignoredPaths = [
      "docs/generated/long/path/one.md",
      "docs/generated/long/path/two.md",
      "docs/generated/long/path/three.md",
    ];
    const reviewablePaths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const boundaryDiff = [
      ...ignoredPaths.map((path) => fileDiff(path, 2)),
      ...reviewablePaths.map((path) => fileDiff(path, 8)),
    ].join("");

    it("keeps the diff sections when the budget fits them", () => {
      const parsed = parseUnifiedDiff(boundaryDiff);
      // 1350 characters hold the review list, the ignored list and three diff
      // sections. The diff sections are joined with a newline on each side of
      // the separator, so a file costs two delimiters. Counting only one
      // made the payload one character per file too long, which pushed it past
      // the cap and dropped every diff section.
      const context = packageReviewContext(parsed, { maxTotalChars: 1350 });

      expect(context.promptPayload.length).toBeLessThanOrEqual(1350);
      expect(context.promptPayload).toContain("### File: src/a.ts");
      expect(context.promptPayload).toContain("### File: src/b.ts");
      expect(context.promptPayload).toContain("### File: src/c.ts");
    });

    it("keeps the payload inside the budget around the boundary", () => {
      const parsed = parseUnifiedDiff(boundaryDiff);

      for (const budget of [1300, 1320, 1340, 1350, 1370, 1380, 1400]) {
        const context = packageReviewContext(parsed, { maxTotalChars: budget });
        expect(context.promptPayload.length).toBeLessThanOrEqual(budget);
      }
    });
  });
});
