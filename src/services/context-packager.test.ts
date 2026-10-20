import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diff-parser.js";
import { packageReviewContext } from "./context-packager.js";

function listedReviewPaths(promptPayload: string): string[] {
  const metadata = promptPayload.split("## Diff Content with Exact Line Anchors")[0];
  return [...metadata.matchAll(/- \*\*(.+?)\*\*/g)].map((match) => match[1]);
}

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

  const manyFileDiff = Array.from({ length: 8 }, (_, index) => {
    const path = `src/feature/module-with-a-long-name-${index}.ts`;
    return `diff --git a/${path} b/${path}
new file mode 100644
index 000..${index} 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1,2 @@
+export const value${index} = ${index};
+export const label${index} = "text";
`;
  }).join("\n");

  const largeFileDiff = `diff --git a/src/very/long/path/to/a/module/file.ts b/src/very/long/path/to/a/module/file.ts
index 1111111..2222222 100644
--- a/src/very/long/path/to/a/module/file.ts
+++ b/src/very/long/path/to/a/module/file.ts
@@ -1,1 +1,200 @@
${Array.from({ length: 200 }, (_, index) => `+export const entry${index} = "value ${index}";\n`).join("")}`;

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
    // The metadata of this diff is larger than a tiny budget, so the budget
    // has to leave room for the file list before any diff content is added.
    const context = packageReviewContext(parsed, { maxTotalChars: 400 });

    expect(context.promptPayload.length).toBeGreaterThan(0);
    expect(context.promptPayload.length).toBeLessThanOrEqual(400);
    expect(context.itemsToReview.length).toBeGreaterThanOrEqual(1);
    expect(context.itemsToReview[0].isTruncated).toBe(true);
  });

  it("enforces the character cap on the scrubbed payload", () => {
    const secretLines = Array.from({ length: 200 }, () => '+const apiKey = "aaaaaaaaaa";\n').join("");
    const diff = `diff --git a/src/config.ts b/src/config.ts
index 1111111..2222222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,1 +1,200 @@
${secretLines}`;

    const parsed = parseUnifiedDiff(diff);
    const context = packageReviewContext(parsed, { maxTotalChars: 1000 });

    expect(context.promptPayload.length).toBeLessThanOrEqual(1000);
    expect(context.itemsToReview[0].isTruncated).toBe(true);
  });

  it("does not offer a file for review when its diff content is empty", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 400 });

    for (const item of context.itemsToReview) {
      expect(item.formattedDiff.trim().length).toBeGreaterThan(0);
    }

    const listed = listedReviewPaths(context.promptPayload);
    expect(listed).toEqual(context.itemsToReview.map((item) => item.file.newPath));
    expect(listed).not.toContain("src/controllers/items.ts");
  });

  it("reserves the metadata size so the diff content is trimmed instead", () => {
    const parsed = parseUnifiedDiff(manyFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 1200 });

    expect(context.promptPayload.length).toBeLessThanOrEqual(1200);
    expect(context.itemsToReview.length).toBeGreaterThan(0);

    for (const item of context.itemsToReview) {
      expect(item.formattedDiff.trim().length).toBeGreaterThan(0);
    }

    expect(listedReviewPaths(context.promptPayload)).toEqual(
      context.itemsToReview.map((item) => item.file.newPath)
    );
  });

  it("cuts the metadata on a line boundary when the metadata alone exceeds the cap", () => {
    const parsed = parseUnifiedDiff(manyFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 400 });

    expect(context.promptPayload.length).toBeLessThanOrEqual(400);

    const metadata = context.promptPayload.split("## Diff Content with Exact Line Anchors")[0];
    for (const line of metadata.split("\n")) {
      if (line.startsWith("- **")) {
        expect(line).toMatch(/\]\s*$/);
      } else if (line.startsWith("- ")) {
        expect(line).toMatch(/\)\s*$/);
      }
    }
  });

  it("keeps a truncation marker when the budget cuts the diff content", () => {
    const parsed = parseUnifiedDiff(largeFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 2000 });

    expect(context.promptPayload.length).toBeLessThanOrEqual(2000);
    expect(context.promptPayload).toContain("[diff truncated to preserve context budget]");
    expect(context.itemsToReview[0].isTruncated).toBe(true);
  });
});
