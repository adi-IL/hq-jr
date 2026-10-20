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

  it("does not treat a hunk body line containing 160000 as a submodule", () => {
    const diff = `diff --git a/src/timeout.ts b/src/timeout.ts
index 1111111..2222222 100644
--- a/src/timeout.ts
+++ b/src/timeout.ts
@@ -1,2 +1,3 @@
 const t = 1;
+const timeout = 160000;
 const u = 2;
`;
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];

    expect(file.isSubmodule).toBe(false);
    expect(isLineInDiff(file, 2, "RIGHT")).toBe(true);
  });

  it("keeps deleted lines that look like file headers inside a hunk", () => {
    const diff = `diff --git a/src/notes.ts b/src/notes.ts
index 1111111..2222222 100644
--- a/src/notes.ts
+++ b/src/notes.ts
@@ -10,4 +10,3 @@
 const kept = 1;
--- commented out
+const replaced = 2;
-const removed = 3;
 const tail = 4;
`;
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const hunk = file.hunks[0];

    expect(file.deletedLinesCount).toBe(2);
    expect(hunk.lines.map((line) => line.type)).toEqual([
      "context",
      "delete",
      "add",
      "delete",
      "context",
    ]);

    const deleted = hunk.lines.filter((line) => line.type === "delete");
    expect(deleted[0].content).toBe("-- commented out");
    expect(deleted[0].oldLineNumber).toBe(11);
    expect(deleted[1].oldLineNumber).toBe(12);

    const added = hunk.lines.filter((line) => line.type === "add");
    expect(added[0].newLineNumber).toBe(11);
  });

  it("does not emit a phantom context line for the trailing empty string", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 const first = 1;
-const second = 2;
+const third = 3;
`;
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];
    const hunk = file.hunks[0];

    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines.filter((line) => line.type === "context")).toHaveLength(1);
    expect(isLineInDiff(file, 3, "RIGHT")).toBe(false);
    expect(isLineInDiff(file, 2, "LEFT")).toBe(true);
  });

  it("decodes quoted git paths with octal escapes", () => {
    const diff = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
index 1111111..2222222 100644
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files[0].oldPath).toBe("src/café.ts");
    expect(parsed.files[0].newPath).toBe("src/café.ts");
  });

  it("decodes escaped quotes inside a quoted git path", () => {
    const diff = `diff --git "a/src/we\\"ird.ts" "b/src/we\\"ird.ts"
index 1111111..2222222 100644
--- "a/src/we\\"ird.ts"
+++ "b/src/we\\"ird.ts"
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files[0].oldPath).toBe('src/we"ird.ts');
    expect(parsed.files[0].newPath).toBe('src/we"ird.ts');
  });

  it("parses rename headers and the similarity index", () => {
    const diff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 92%
rename from src/old-name.ts
rename to src/new-name.ts
index 1111111..2222222 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);
    const file = parsed.files[0];

    expect(file.isRenamed).toBe(true);
    expect(file.similarityIndex).toBe(92);
    expect(file.oldPath).toBe("src/old-name.ts");
    expect(file.newPath).toBe("src/new-name.ts");
  });

  it("keeps unquoted paths that contain a space", () => {
    const diff = `diff --git a/src/my file.ts b/src/my file.ts
index 1111111..2222222 100644
--- a/src/my file.ts
+++ b/src/my file.ts
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].oldPath).toBe("src/my file.ts");
    expect(parsed.files[0].newPath).toBe("src/my file.ts");
  });

  it("keeps unquoted paths that contain a space when the file was renamed", () => {
    const diff = `diff --git a/src/old name.ts b/src/new name.ts
index 1111111..2222222 100644
--- a/src/old name.ts
+++ b/src/new name.ts
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files[0].oldPath).toBe("src/old name.ts");
    expect(parsed.files[0].newPath).toBe("src/new name.ts");
    expect(parsed.files[0].isRenamed).toBe(true);
  });

  it("decodes a quoted path that holds a literal non-ASCII character", () => {
    const diff = `diff --git "a/src/café.ts" "b/src/café.ts"
index 1111111..2222222 100644
--- "a/src/café.ts"
+++ "b/src/café.ts"
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files[0].oldPath).toBe("src/café.ts");
    expect(parsed.files[0].newPath).toBe("src/café.ts");
  });

  it("decodes the control character escapes of a quoted path", () => {
    const diff = `diff --git "a/src/a\\tb.ts" "b/src/a\\tb.ts"
index 1111111..2222222 100644
--- "a/src/a\\tb.ts"
+++ "b/src/a\\tb.ts"
@@ -1,1 +1,1 @@
 const value = 1;
`;
    const parsed = parseUnifiedDiff(diff);

    expect(parsed.files[0].oldPath).toBe("src/a\tb.ts");
    expect(parsed.files[0].newPath).toBe("src/a\tb.ts");
  });

  it("keeps the line anchors aligned across a blank line inside a hunk", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 const first = 1;

-const second = 2;
+const third = 3;
 const tail = 4;
`;
    const parsed = parseUnifiedDiff(diff);
    const hunk = parsed.files[0].hunks[0];

    expect(hunk.lines.map((line) => line.type)).toEqual([
      "context",
      "context",
      "delete",
      "add",
      "context",
    ]);

    const deleted = hunk.lines.filter((line) => line.type === "delete");
    const added = hunk.lines.filter((line) => line.type === "add");
    const lastContext = hunk.lines[hunk.lines.length - 1];

    expect(deleted[0].oldLineNumber).toBe(3);
    expect(added[0].newLineNumber).toBe(3);
    expect(lastContext.oldLineNumber).toBe(4);
    expect(lastContext.newLineNumber).toBe(4);
  });

  it("does not add a phantom context line for a blank line after a complete hunk", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 const first = 1;
-const second = 2;
+const third = 3;

`;
    const parsed = parseUnifiedDiff(diff);
    const hunk = parsed.files[0].hunks[0];

    expect(hunk.lines).toHaveLength(3);
    expect(hunk.lines.filter((line) => line.type === "context")).toHaveLength(1);
  });
});
