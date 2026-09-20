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
});
