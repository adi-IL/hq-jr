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
const GIT_DIFF_HEADER_REGEX =
  /^diff --git ("(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)\s*$/;
const GIT_INDEX_REGEX = /^index\s+[0-9a-zA-Z]+\.\.[0-9a-zA-Z]+(?:\s+(\d+))?/;
const FILE_PATH_HEADER_REGEX = /^(?:---|\+\+\+) (.*)$/;
const SUBMODULE_MODE = "160000";

/**
 * Decodes a git quoted path. Git quotes the whole path and escapes every
 * non-ASCII byte as an octal escape, so the bytes must be reassembled before
 * they can be decoded as UTF-8.
 */
function decodeGitQuotedPath(body: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0));
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
    bytes.push(next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
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
      const oldPath = parseGitPath(match ? match[1] : "", "a/");
      const newPath = parseGitPath(match ? match[2] : "", "b/");

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
    } else if (line.startsWith("\\ No newline at end of file")) {
      // Ignore git marker
      continue;
    }
    // A zero length body line is not a valid context line: unified diffs
    // always prefix context lines with a space, so this is diff noise.
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
