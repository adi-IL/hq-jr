export interface DiffLine {
  type: "add" | "delete" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  isBinary: boolean;
  isSubmodule: boolean;
  isModeChange: boolean;
  oldMode?: string;
  newMode?: string;
  similarityIndex?: number;
  hunks: DiffHunk[];
  addedLinesCount: number;
  deletedLinesCount: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const GIT_DIFF_HEADER_REGEX = /^diff --git\s+(.+?)\s*$/;
const GIT_INDEX_REGEX = /^index\s+[0-9a-zA-Z]+\.\.[0-9a-zA-Z]+(?:\s+(\d+))?/;
const FILE_PATH_HEADER_REGEX = /^(?:---|\+\+\+) (.*)$/;
const SUBMODULE_MODE = "160000";

/**
 * Git escapes control characters with these letters inside a quoted path.
 */
const CONTROL_ESCAPE_CODES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
};

/**
 * Decodes a git quoted path. Git quotes the whole path and escapes every
 * non-ASCII byte as an octal escape, so the bytes must be reassembled before
 * they can be decoded as UTF-8. Literal characters are pushed as their UTF-8
 * bytes, because a single code point is not a single byte.
 */
function decodeGitQuotedPath(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== "\\") {
      const codePoint = body.codePointAt(i) as number;
      for (const byte of Buffer.from(String.fromCodePoint(codePoint), "utf8")) {
        bytes.push(byte);
      }
      if (codePoint > 0xffff) {
        i++;
      }
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      break;
    }
    if (next >= "0" && next <= "7") {
      const octal = body.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        i += 3;
        continue;
      }
    }
    const controlCode = CONTROL_ESCAPE_CODES[next];
    bytes.push(controlCode !== undefined ? controlCode : next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Finds the closing quote of a quoted path token, honouring backslash escapes.
 */
function findClosingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === '"') {
      return i;
    }
  }
  return -1;
}

function stripPathPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Splits the two path tokens of a "diff --git" header. A quoted path is one
 * token. An unquoted path may contain spaces or a literal quote, so the two
 * sides are separated on the b/ prefix and the split that yields the same
 * path on both sides wins. A quoted second path is used only when that
 * separator is absent.
 */
function splitGitHeaderPaths(rest: string): [string, string] | null {
  const trimmed = rest.trim();

  if (trimmed.startsWith('"')) {
    const firstEnd = findClosingQuote(trimmed);
    if (firstEnd < 0) {
      return null;
    }
    const first = trimmed.slice(0, firstEnd + 1);
    const remainder = trimmed.slice(firstEnd + 1).trim();
    if (!remainder) {
      return null;
    }
    if (!remainder.startsWith('"')) {
      return [first, remainder];
    }
    const secondEnd = findClosingQuote(remainder);
    if (secondEnd < 0) {
      return null;
    }
    return [first, remainder.slice(0, secondEnd + 1)];
  }

  const candidates: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === " " && trimmed.startsWith("b/", i + 1)) {
      candidates.push(i);
    }
  }
  for (const index of candidates) {
    const left = stripPathPrefix(trimmed.slice(0, index), "a/");
    const right = stripPathPrefix(trimmed.slice(index + 1), "b/");
    if (left === right) {
      return [trimmed.slice(0, index), trimmed.slice(index + 1)];
    }
  }
  if (candidates.length === 0) {
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === '"' && /\s/.test(trimmed[i - 1])) {
        const head = trimmed.slice(0, i).trim();
        const tail = trimmed.slice(i).trim();
        if (head && tail) {
          return [head, tail];
        }
        break;
      }
    }
    return null;
  }
  const index = candidates[0];
  return [trimmed.slice(0, index), trimmed.slice(index + 1)];
}

/**
 * Normalizes a path token taken from a diff header: decodes git quoting and
 * removes the a/ or b/ prefix git adds to the diff side of the path.
 */
function parseGitPath(raw: string, prefix: string): string {
  const trimmed = raw.trim();
  let value = trimmed;
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    value = decodeGitQuotedPath(value.slice(1, -1));
  }
  if (prefix && value.startsWith(prefix)) {
    value = value.slice(prefix.length);
  }
  return value;
}

/**
 * A file header path is either /dev/null or something path shaped. Deleted
 * lines such as "--- commented out" must not be mistaken for a header.
 */
function looksLikeFilePathHeader(raw: string): boolean {
  const value = raw.trim();
  if (value === "/dev/null") {
    return true;
  }
  if (value.startsWith('"')) {
    return true;
  }
  if (/^[ab]\//.test(value)) {
    return true;
  }
  return !/\s/.test(value);
}

/**
 * Parses unified git diff text into structured file and hunk objects.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files: DiffFile[] = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentOldLine = 0;
  let currentNewLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/path b/path
    if (line.startsWith("diff --git ")) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        files.push(currentFile);
      }

      const match = line.match(GIT_DIFF_HEADER_REGEX);
      const paths = match ? splitGitHeaderPaths(match[1]) : null;
      const oldPath = paths ? parseGitPath(paths[0], "a/") : "";
      const newPath = paths ? parseGitPath(paths[1], "b/") : "";

      currentFile = {
        oldPath,
        newPath,
        isNew: false,
        isDeleted: false,
        isRenamed: oldPath !== newPath && oldPath !== "" && newPath !== "",
        isBinary: false,
        isSubmodule: false,
        isModeChange: false,
        hunks: [],
        addedLinesCount: 0,
        deletedLinesCount: 0,
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    // Extended headers
    if (line.startsWith("new file mode ")) {
      currentFile.isNew = true;
      currentFile.newMode = line.replace("new file mode ", "").trim();
      if (currentFile.newMode === SUBMODULE_MODE) currentFile.isSubmodule = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.isDeleted = true;
      currentFile.oldMode = line.replace("deleted file mode ", "").trim();
      if (currentFile.oldMode === SUBMODULE_MODE) currentFile.isSubmodule = true;
      continue;
    }
    if (line.startsWith("old mode ")) {
      currentFile.oldMode = line.replace("old mode ", "").trim();
      currentFile.isModeChange = true;
      continue;
    }
    if (line.startsWith("new mode ")) {
      currentFile.newMode = line.replace("new mode ", "").trim();
      currentFile.isModeChange = true;
      continue;
    }
    if (line.startsWith("similarity index ")) {
      const similarity = parseInt(line.slice("similarity index ".length).trim(), 10);
      if (!Number.isNaN(similarity)) {
        currentFile.similarityIndex = similarity;
      }
      continue;
    }
    if (line.startsWith("rename from ")) {
      currentFile.oldPath = parseGitPath(line.slice("rename from ".length), "");
      currentFile.isRenamed = true;
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.newPath = parseGitPath(line.slice("rename to ".length), "");
      currentFile.isRenamed = true;
      continue;
    }
    if (line.startsWith("copy from ")) {
      currentFile.oldPath = parseGitPath(line.slice("copy from ".length), "");
      currentFile.isRenamed = false;
      continue;
    }
    if (line.startsWith("copy to ")) {
      currentFile.newPath = parseGitPath(line.slice("copy to ".length), "");
      currentFile.isRenamed = false;
      continue;
    }
    const indexMatch = line.match(GIT_INDEX_REGEX);
    if (indexMatch) {
      if (indexMatch[1] === SUBMODULE_MODE) {
        currentFile.isSubmodule = true;
      }
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      currentFile.isBinary = true;
      continue;
    }
    const pathHeaderMatch = !currentHunk ? line.match(FILE_PATH_HEADER_REGEX) : null;
    if (pathHeaderMatch && looksLikeFilePathHeader(pathHeaderMatch[1])) {
      if (pathHeaderMatch[0].startsWith("--- ") && pathHeaderMatch[1].trim() === "/dev/null") {
        currentFile.isNew = true;
      }
      if (pathHeaderMatch[0].startsWith("+++ ") && pathHeaderMatch[1].trim() === "/dev/null") {
        currentFile.isDeleted = true;
      }
      continue;
    }

    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentOldLine = oldStart;
      currentNewLine = newStart;

      currentHunk = {
        header: line,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    // Hunk body lines
    if (line.startsWith("+")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        newLineNumber: currentNewLine,
      });
      currentNewLine++;
      currentFile.addedLinesCount++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        type: "delete",
        content: line.slice(1),
        oldLineNumber: currentOldLine,
      });
      currentOldLine++;
      currentFile.deletedLinesCount++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNumber: currentOldLine,
        newLineNumber: currentNewLine,
      });
      currentOldLine++;
      currentNewLine++;
    } else if (line === "") {
      // A blank line inside a hunk body stands for an empty source line, so it
      // is counted to keep the later anchors aligned. The trailing empty
      // string of the split is not part of the hunk.
      const hunkIsComplete =
        currentOldLine - currentHunk.oldStart >= currentHunk.oldLines &&
        currentNewLine - currentHunk.newStart >= currentHunk.newLines;
      if (i < lines.length - 1 && !hunkIsComplete) {
        currentHunk.lines.push({
          type: "context",
          content: "",
          oldLineNumber: currentOldLine,
          newLineNumber: currentNewLine,
        });
        currentOldLine++;
        currentNewLine++;
      }
    } else if (line.startsWith("\\ No newline at end of file")) {
      // Ignore git marker
      continue;
    }
  }

  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  const totalAdditions = files.reduce((acc, f) => acc + f.addedLinesCount, 0);
  const totalDeletions = files.reduce((acc, f) => acc + f.deletedLinesCount, 0);

  return {
    files,
    totalAdditions,
    totalDeletions,
  };
}

/**
 * Checks if a specific line number in a file exists within the diff hunks.
 * Ensures review comments are never anchored to lines outside the diff.
 */
export function isLineInDiff(
  file: DiffFile | null | undefined,
  targetLine: number,
  side: "RIGHT" | "LEFT" = "RIGHT"
): boolean {
  if (!file || !file.hunks || file.isSubmodule || file.isBinary) {
    return false;
  }
  const normalizedSide = (side || "RIGHT").toUpperCase();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (normalizedSide === "RIGHT" && line.newLineNumber === targetLine) {
        return true;
      }
      if (normalizedSide === "LEFT" && line.oldLineNumber === targetLine) {
        return true;
      }
    }
  }
  return false;
}
