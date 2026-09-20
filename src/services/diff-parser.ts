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

function parseGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
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

      // Support unquoted and quoted file paths
      const match = line.match(/^diff --git (?:"a\/(.+?)"|a\/(.+?))\s+(?:"b\/(.+)"|b\/(.+))$/);
      const oldPath = parseGitPath(match ? (match[1] || match[2] || "") : "");
      const newPath = parseGitPath(match ? (match[3] || match[4] || "") : "");

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
      if (currentFile.newMode === "160000") currentFile.isSubmodule = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.isDeleted = true;
      currentFile.oldMode = line.replace("deleted file mode ", "").trim();
      if (currentFile.oldMode === "160000") currentFile.isSubmodule = true;
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
    if (line.includes("160000")) {
      currentFile.isSubmodule = true;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      currentFile.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (line === "--- /dev/null") {
        currentFile.isNew = true;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") {
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
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLineNumber: currentOldLine,
        newLineNumber: currentNewLine,
      });
      currentOldLine++;
      currentNewLine++;
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
