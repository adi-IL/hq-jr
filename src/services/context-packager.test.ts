import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diff-parser.js";
import { packageReviewContext } from "./context-packager.js";

function listedReviewPaths(promptPayload: string): string[] {
  const metadata = promptPayload.split("## Diff Content with Exact Line Anchors")[0];
  return [...metadata.matchAll(/- \*\*(.+?)\*\*/g)].map((match) => match[1]);
}

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

describe("Context Packager", () => {

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
    // Artificially tiny budget
    const context = packageReviewContext(parsed, { maxTotalChars: 150 });

    expect(context.promptPayload.length).toBeGreaterThan(0);
    // A 150-character cap cannot hold the required metadata, a listed path,
    // and one complete code line. The file must therefore be ignored.
    expect(context.itemsToReview).toHaveLength(0);
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

  it("filters out noise files and orders review items by risk priority", () => {
    const context = packageReviewContext(parseUnifiedDiff(multiFileDiff));
    expect(context.ignoredItems).toHaveLength(1);
    expect(context.ignoredItems[0].path).toBe("package-lock.json");
    expect(context.itemsToReview).toHaveLength(2);
    expect(context.itemsToReview[0].file.newPath).toBe("src/auth/jwt.ts");
    expect(context.itemsToReview[0].filter.category).toBe("SECURITY");
    expect(context.itemsToReview[1].file.newPath).toBe("src/controllers/items.ts");
    expect(context.itemsToReview[1].filter.category).toBe("BACKEND");
  });

  it("enforces maxTotalChars budget and flags truncation", () => {
    const context = packageReviewContext(parseUnifiedDiff(`${multiFileDiff}${largeFileDiff}`), { maxTotalChars: 1000 });
    expect(context.promptPayload.length).toBeGreaterThan(0);
    expect(context.promptPayload.length).toBeLessThanOrEqual(1000);
    expect(context.itemsToReview.length).toBeGreaterThanOrEqual(1);
    expect(context.itemsToReview.some((item) => item.isTruncated)).toBe(true);
  });

  it("enforces the character cap on the scrubbed payload", () => {
    const secretLines = Array.from({ length: 200 }, () => '+const apiKey = "aaaaaaaaaa";\n').join("");
    const diff = `diff --git a/src/config.ts b/src/config.ts
index 1111111..2222222 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,1 +1,200 @@
${secretLines}`;
    const context = packageReviewContext(parseUnifiedDiff(diff), { maxTotalChars: 1000 });
    expect(context.promptPayload.length).toBeLessThanOrEqual(1000);
    expect(context.itemsToReview[0].isTruncated).toBe(true);
  });

  it("omits a file from review when the budget leaves no room for its code", () => {
    const context = packageReviewContext(parseUnifiedDiff(multiFileDiff), { maxTotalChars: 400 });
    for (const item of context.itemsToReview) expect(item.formattedDiff.trim().length).toBeGreaterThan(0);
    const listed = listedReviewPaths(context.promptPayload);
    expect(listed).toEqual(context.itemsToReview.map((item) => item.file.newPath));
    expect(listed).not.toContain("src/controllers/items.ts");
  });

  it("reserves the metadata size so the diff content is trimmed instead", () => {
    const context = packageReviewContext(parseUnifiedDiff(manyFileDiff), { maxTotalChars: 1200 });
    expect(context.promptPayload.length).toBeLessThanOrEqual(1200);
    expect(context.itemsToReview.length).toBeGreaterThan(0);
    for (const item of context.itemsToReview) expect(item.formattedDiff.trim().length).toBeGreaterThan(0);
    expect(listedReviewPaths(context.promptPayload)).toEqual(context.itemsToReview.map((item) => item.file.newPath));
  });

  it("cuts the metadata on a line boundary when the metadata alone exceeds the cap", () => {
    const context = packageReviewContext(parseUnifiedDiff(manyFileDiff), { maxTotalChars: 400 });
    expect(context.promptPayload.length).toBeLessThanOrEqual(400);
    const metadata = context.promptPayload.split("## Diff Content with Exact Line Anchors")[0];
    for (const line of metadata.split("\n")) {
      if (line.startsWith("- **")) expect(line).toMatch(/\]\s*$/);
      else if (line.startsWith("- ")) expect(line).toMatch(/\)\s*$/);
    }
  });

  it("keeps a truncation marker when the budget cuts the diff content", () => {
    const context = packageReviewContext(parseUnifiedDiff(largeFileDiff), { maxTotalChars: 2000 });
    expect(context.promptPayload.length).toBeLessThanOrEqual(2000);
    expect(context.promptPayload).toContain("[diff truncated to preserve context budget]");
    expect(context.itemsToReview[0].isTruncated).toBe(true);
  });

  it("ends every budget cut with a truncation notice", () => {
    const context = packageReviewContext(parseUnifiedDiff(`${multiFileDiff}${largeFileDiff}`), { maxTotalChars: 1500 });
    const truncated = context.itemsToReview.filter((item) => item.isTruncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const item of truncated) {
      expect(item.formattedDiff.endsWith("... [diff truncated to preserve context budget]")).toBe(true);
      expect(context.promptPayload).toContain(item.formattedDiff);
    }
    expect(context.promptPayload.length).toBeLessThanOrEqual(1500);
  });

  it("keeps at least one line of code for every file it offers for review", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    for (let cap = 150; cap <= 700; cap++) {
      const context = packageReviewContext(parsed, { maxTotalChars: cap });
      expect(context.promptPayload.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(listedReviewPaths(context.promptPayload), `cap ${cap}`).toEqual(context.itemsToReview.map((item) => item.file.newPath));
      for (const item of context.itemsToReview) {
        expect(item.formattedDiff, `cap ${cap}`).toContain("+ L1");
        expect(context.promptPayload, `cap ${cap}`).toContain(item.formattedDiff);
      }
    }
  });

  it("moves a file with no room for code to the ignored list", () => {
    const context = packageReviewContext(parseUnifiedDiff(multiFileDiff), { maxTotalChars: 400 });
    expect(context.itemsToReview.map((item) => item.file.newPath)).toEqual(["src/auth/jwt.ts"]);
    expect(context.ignoredItems).toContainEqual({ path: "src/controllers/items.ts", reason: "Context window budget limit reached" });
    expect(context.totalReviewableAdditions).toBe(3);
  });

  it("summarizes a long ignored list so code still fits", () => {
    const assets = Array.from({ length: 500 }, (_, i) => `diff --git a/assets/image_${i}.png b/assets/image_${i}.png
index 1111111..2222222 100644
Binary files a/assets/image_${i}.png and b/assets/image_${i}.png differ`).join("\n");
    const context = packageReviewContext(parseUnifiedDiff(`${multiFileDiff}${assets}\n`), { maxTotalChars: 4000 });
    expect(context.promptPayload.length).toBeLessThanOrEqual(4000);
    expect(context.itemsToReview).toHaveLength(2);
    expect(context.promptPayload).toContain("verifyToken");
    expect(context.promptPayload).toMatch(/- \.\.\. \(\d+ more ignored files not listed\)/);
    expect(context.ignoredItems).toHaveLength(501);
  });

  it("does not offer a file with no reviewable lines", () => {
    const diff = `diff --git a/src/data/blob.ts b/src/data/blob.ts
new file mode 100644
index 111..222 100644
Binary files a/src/data/blob.ts and b/src/data/blob.ts differ
diff --git a/src/data/script.ts b/src/data/script.ts
old mode 100644
new mode 100755
diff --git a/src/data/empty.ts b/src/data/empty.ts
index 111..222 100644
--- a/src/data/empty.ts
+++ b/src/data/empty.ts
@@ -1,0 +1,0 @@
diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts
new file mode 100644
index 000..444 100644
--- /dev/null
+++ b/src/auth/jwt.ts
@@ -0,0 +1,3 @@
+export function verifyToken(token: string) {
+  return token.length > 10;
+}
`;
    const context = packageReviewContext(parseUnifiedDiff(diff));

    expect(context.itemsToReview.map((item) => item.file.newPath)).toEqual(["src/auth/jwt.ts"]);
    expect(context.ignoredItems).toContainEqual({
      path: "src/data/blob.ts",
      reason: "Binary file has no reviewable text",
    });
    expect(context.ignoredItems).toContainEqual({
      path: "src/data/script.ts",
      reason: "No reviewable lines in the diff",
    });
    expect(context.ignoredItems).toContainEqual({
      path: "src/data/empty.ts",
      reason: "No reviewable lines in the diff",
    });
    expect(context.promptPayload).not.toContain("### File: src/data/blob.ts");
    expect(context.promptPayload).not.toContain("### File: src/data/empty.ts");
    expect(context.promptPayload).toContain("verifyToken");
  });

  it("keeps a file whose only hunk lines are unchanged context", () => {
    const diff = `diff --git a/src/data/ctx.ts b/src/data/ctx.ts
index 111..222 100644
--- a/src/data/ctx.ts
+++ b/src/data/ctx.ts
@@ -1,2 +1,2 @@
 unchanged line
 another line
`;
    const context = packageReviewContext(parseUnifiedDiff(diff));

    expect(context.itemsToReview.map((item) => item.file.newPath)).toEqual(["src/data/ctx.ts"]);
    expect(context.itemsToReview[0].formattedDiff).toContain("unchanged line");
    expect(context.ignoredItems).toHaveLength(0);
  });

  it("adds a truncation notice when a metadata cut has room for one", () => {
    const parsed = parseUnifiedDiff(manyFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 80 });

    expect(context.itemsToReview).toHaveLength(0);
    expect(context.promptPayload.length).toBeLessThanOrEqual(80);
    expect(context.promptPayload).toBe("... [metadata truncated to preserve context budget]");
  });

  it("cuts a cap shorter than the metadata notice on a line boundary", () => {
    const parsed = parseUnifiedDiff(manyFileDiff);
    const context = packageReviewContext(parsed, { maxTotalChars: 20 });

    expect(context.promptPayload.length).toBeLessThanOrEqual(20);
    expect(context.promptPayload).not.toContain("[metadata truncated");
    expect(context.promptPayload.split("\n").every((line) => line === "" || line === "## Files Under Review (Ranked by Risk)")).toBe(true);
  });

  it("drops a file when the per-file cap cannot hold one whole code line", () => {
    const parsed = parseUnifiedDiff(largeFileDiff);
    const context = packageReviewContext(parsed, { maxPerFileChars: 40 });

    expect(context.itemsToReview).toHaveLength(0);
    expect(context.ignoredItems).toContainEqual({
      path: "src/very/long/path/to/a/module/file.ts",
      reason: "Per-file size limit leaves no whole line",
    });
  });

  it("cuts a per-file diff on a line boundary and adds a notice", () => {
    const parsed = parseUnifiedDiff(largeFileDiff);
    const context = packageReviewContext(parsed, { maxPerFileChars: 400 });
    const item = context.itemsToReview[0];

    expect(context.itemsToReview).toHaveLength(1);
    expect(item.isTruncated).toBe(true);
    expect(item.formattedDiff.endsWith("... [diff truncated due to size limit]")).toBe(true);
    const body = item.formattedDiff.replace(/\n\.\.\. \[diff truncated due to size limit\]$/, "");
    expect(body).toMatch(/^[+\- ] /m);
    for (const line of body.split("\n")) {
      if (line.includes(" | ")) expect(line).toMatch(/;$/);
    }
  });

  it("holds the budget invariants across caps", () => {
    const diff = `${manyFileDiff}
diff --git a/src/data/blob.ts b/src/data/blob.ts
new file mode 100644
index 111..222 100644
Binary files a/src/data/blob.ts and b/src/data/blob.ts differ
diff --git a/src/data/empty.ts b/src/data/empty.ts
index 111..222 100644
--- a/src/data/empty.ts
+++ b/src/data/empty.ts
@@ -1,0 +1,0 @@
`;
    const parsed = parseUnifiedDiff(diff);
    const full = packageReviewContext(parsed, { maxTotalChars: 1_000_000 });
    const codeLines = new Set(full.itemsToReview.flatMap((item) => item.formattedDiff.split("\n")));
    const notices = new Set([
      "... [diff truncated due to size limit]",
      "... [diff truncated to preserve context budget]",
      "... [metadata truncated to preserve context budget]",
    ]);
    const headers = new Set([
      "## Files Under Review (Ranked by Risk)",
      "## Ignored / Pruned Files",
      "## Diff Content with Exact Line Anchors",
      "---",
    ]);

    for (let cap = 1; cap <= 2000; cap++) {
      const context = packageReviewContext(parsed, { maxTotalChars: cap });

      expect(context.promptPayload.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(listedReviewPaths(context.promptPayload), `cap ${cap}`).toEqual(
        context.itemsToReview.map((item) => item.file.newPath)
      );
      expect(
        context.itemsToReview.some((item) => item.file.newPath === "src/data/blob.ts"),
        `cap ${cap}`
      ).toBe(false);
      expect(
        context.itemsToReview.some((item) => item.file.newPath === "src/data/empty.ts"),
        `cap ${cap}`
      ).toBe(false);

      for (const item of context.itemsToReview) {
        expect(item.formattedDiff.length, `cap ${cap}`).toBeGreaterThan(0);
        const body = item.formattedDiff
          .replace(/\n\.\.\. \[diff truncated due to size limit\]$/, "")
          .replace(/\n\.\.\. \[diff truncated to preserve context budget\]$/, "");
        expect(body, `cap ${cap}`).toMatch(/^[+\- ] /m);
        expect(context.promptPayload, `cap ${cap}`).toContain(item.formattedDiff);
      }

      for (const line of context.promptPayload.split("\n")) {
        if (line === "" || notices.has(line) || headers.has(line) || codeLines.has(line)) continue;
        const wholeListLine =
          /^- \*\*.+\*\* \[Category: [A-Z]+, Priority: \d+\/10\]$/.test(line) ||
          /^- .+ \([^()\n]+\)$/.test(line) ||
          /^- \.\.\. \(\d+ more ignored files? not listed\)$/.test(line);
        expect(wholeListLine, `cap ${cap} line ${line}`).toBe(true);
      }
    }
  });
});

describe("context packager per file cap", () => {
  const bigFile = `diff --git a/src/big.ts b/src/big.ts
new file mode 100644
index 111..222 100644
--- /dev/null
+++ b/src/big.ts
@@ -0,0 +1,20 @@
${Array.from({ length: 20 }, (_, i) => `+const v${i} = ${i};`).join("\n")}
`;

  it("keeps the emitted diff inside the per file cap", () => {
    for (let cap = 30; cap <= 400; cap++) {
      const context = packageReviewContext(parseUnifiedDiff(bigFile), {
        maxPerFileChars: cap,
      });
      for (const item of context.itemsToReview) {
        expect(item.formattedDiff.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("still marks a cut diff with the notice", () => {
    const context = packageReviewContext(parseUnifiedDiff(bigFile), {
      maxPerFileChars: 200,
    });
    const item = context.itemsToReview[0];
    expect(item.isTruncated).toBe(true);
    expect(item.formattedDiff).toContain("[diff truncated due to size limit]");
    expect(item.formattedDiff.length).toBeLessThanOrEqual(200);
  });
});

describe("context packager paths with a newline", () => {
  const newlinePath = [
    'diff --git "a/src/we\\n+ fake" "b/src/we\\n+ fake"',
    "index 111..222 100644",
    '--- "a/src/we\\n+ fake"',
    '+++ "b/src/we\\n+ fake"',
    "@@ -1,2 +1,2 @@",
    "+const a = 1;",
    "+const b = 2;",
    "",
  ].join("\n");

  it("writes the path on one line so the cut is measured against real code", () => {
    const context = packageReviewContext(parseUnifiedDiff(newlinePath), {
      maxPerFileChars: 200,
    });
    const item = context.itemsToReview[0];
    expect(item).toBeDefined();
    expect(item.formattedDiff).toContain("### File: src/we\\n+ fake (");
    expect(item.formattedDiff.split("\n")[0]).toContain("src/we\\n+ fake");
  });

  it("drops the file when the cap cannot hold one whole code line", () => {
    for (const cap of [118, 110, 100, 90]) {
      const context = packageReviewContext(parseUnifiedDiff(newlinePath), {
        maxPerFileChars: cap,
      });
      expect(context.itemsToReview, `cap ${cap}`).toHaveLength(0);
    }
  });
});

describe("context packager budget cut announcement", () => {
  it("says the diff was cut when the budget dropped every file", () => {
    const parsed = parseUnifiedDiff(multiFileDiff);
    for (let cap = 150; cap <= 700; cap++) {
      const context = packageReviewContext(parsed, { maxTotalChars: cap });
      const dropped = context.ignoredItems.filter((item) => item.reason.includes("budget"));
      if (dropped.length === 0 || context.itemsToReview.length > 0) continue;
      expect(context.promptPayload, `cap ${cap}`).toContain("truncated to preserve context budget");
      expect(context.promptPayload.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it("announces the cut when the diff content filled the cap", () => {
    const diff = `diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts
new file mode 100644
index 111..222 100644
--- /dev/null
+++ b/src/auth/jwt.ts
@@ -0,0 +1,3 @@
+export function verifyToken(t: string) {
+  return t.length > 0;
+}
diff --git a/src/controllers/items.ts b/src/controllers/items.ts
new file mode 100644
index 111..222 100644
--- /dev/null
+++ b/src/controllers/items.ts
@@ -0,0 +1,3 @@
+export const items = ["a", "b", "c"];
+export const more = items.map((i) => i.toUpperCase());
+export default items;
`;
    for (let cap = 300; cap <= 460; cap++) {
      const context = packageReviewContext(parseUnifiedDiff(diff), { maxTotalChars: cap });
      const dropped = context.ignoredItems.filter((item) => item.reason.includes("budget"));
      if (dropped.length === 0) continue;
      expect(context.promptPayload, `cap ${cap}`).toContain("truncated to preserve context budget");
      expect(context.promptPayload.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it("names a dropped file in the ignored list with the budget reason", () => {
    const context = packageReviewContext(parseUnifiedDiff(multiFileDiff), { maxTotalChars: 400 });
    expect(context.itemsToReview.map((item) => item.file.newPath)).toEqual(["src/auth/jwt.ts"]);
    expect(context.ignoredItems).toContainEqual({
      path: "src/controllers/items.ts",
      reason: "Context window budget limit reached",
    });
  });
});
