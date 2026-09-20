import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, isLineInDiff } from "./diff-parser.js";

describe("Unified Diff Parser", () => {
  const sampleDiff = `
diff --git a/src/auth.ts b/src/auth.ts
index abcdef1..1234567 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ export function login() {
   const user = findUser();
-  if (!user) return false;
+  if (!user) {
+    throw new Error("User not found");
+  }
   return true;
 }
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/README.md
@@ -0,0 +1,3 @@
+# Project HQ-JR
+Automated code reviewer.
+Version 1.0.
`;

  it("parses multiple files from a diff correctly", () => {
    const parsed = parseUnifiedDiff(sampleDiff);
    expect(parsed.files).toHaveLength(2);

    const authFile = parsed.files[0];
    expect(authFile.oldPath).toBe("src/auth.ts");
    expect(authFile.newPath).toBe("src/auth.ts");
    expect(authFile.isNew).toBe(false);
    expect(authFile.isDeleted).toBe(false);
    expect(authFile.hunks).toHaveLength(1);
    expect(authFile.addedLinesCount).toBe(3);
    expect(authFile.deletedLinesCount).toBe(1);

    const readmeFile = parsed.files[1];
    expect(readmeFile.newPath).toBe("README.md");
    expect(readmeFile.isNew).toBe(true);
    expect(readmeFile.addedLinesCount).toBe(3);
    expect(readmeFile.deletedLinesCount).toBe(0);

    expect(parsed.totalAdditions).toBe(6);
    expect(parsed.totalDeletions).toBe(1);
  });

  it("calculates exact line numbers within hunks", () => {
    const parsed = parseUnifiedDiff(sampleDiff);
    const authHunk = parsed.files[0].hunks[0];

    // Find the added lines
    const addedLines = authHunk.lines.filter((l) => l.type === "add");
    expect(addedLines).toHaveLength(3);
    expect(addedLines[0].newLineNumber).toBe(11);
    expect(addedLines[1].newLineNumber).toBe(12);
    expect(addedLines[2].newLineNumber).toBe(13);

    // Find the deleted line
    const deletedLines = authHunk.lines.filter((l) => l.type === "delete");
    expect(deletedLines).toHaveLength(1);
    expect(deletedLines[0].oldLineNumber).toBe(11);
  });

  it("verifies isLineInDiff correctly distinguishes diff lines from outside lines", () => {
    const parsed = parseUnifiedDiff(sampleDiff);
    const authFile = parsed.files[0];

    // Added lines are in diff on RIGHT side
    expect(isLineInDiff(authFile, 11, "RIGHT")).toBe(true);
    expect(isLineInDiff(authFile, 12, "RIGHT")).toBe(true);
    expect(isLineInDiff(authFile, 13, "RIGHT")).toBe(true);

    // Line 10 is a context line in diff
    expect(isLineInDiff(authFile, 10, "RIGHT")).toBe(true);

    // Line 999 is outside the hunk
    expect(isLineInDiff(authFile, 999, "RIGHT")).toBe(false);

    // Deleted line 11 is on LEFT side
    expect(isLineInDiff(authFile, 11, "LEFT")).toBe(true);
  });

  it("handles quoted file paths with spaces and special modes", () => {
    const diff = `
diff --git "a/path with spaces/file one.ts" "b/path with spaces/file one.ts"
old mode 100644
new mode 100755
index 1234567..89abcde
--- "a/path with spaces/file one.ts"
+++ "b/path with spaces/file one.ts"
@@ -1,2 +1,2 @@
-console.log("old");
+console.log("new");
diff --git a/sub-module b/sub-module
index 1111111..2222222 160000
--- a/sub-module
+++ b/sub-module
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files).toHaveLength(2);

    const spaceFile = parsed.files[0];
    expect(spaceFile.oldPath).toBe("path with spaces/file one.ts");
    expect(spaceFile.newPath).toBe("path with spaces/file one.ts");
    expect(spaceFile.isModeChange).toBe(true);
    expect(spaceFile.newMode).toBe("100755");

    const submoduleFile = parsed.files[1];
    expect(submoduleFile.isSubmodule).toBe(true);
    // Submodules should never anchor inline review comments
    expect(isLineInDiff(submoduleFile, 1, "RIGHT")).toBe(false);
  });
});
