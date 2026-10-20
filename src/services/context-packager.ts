import { DiffFile, ParsedDiff } from "./diff-parser.js";
import { evaluateFile, FilterResult } from "./file-filter.js";
import { scrubSecrets } from "./scrubber.js";

export interface ContextPackageItem {
  file: DiffFile;
  filter: FilterResult;
  formattedDiff: string;
  isTruncated: boolean;
}

export interface ReviewContextPackage {
  itemsToReview: ContextPackageItem[];
  ignoredItems: { path: string; reason: string }[];
  totalReviewableAdditions: number;
  totalReviewableDeletions: number;
  promptPayload: string;
}

export interface PackagerOptions {
  maxTotalChars?: number;
  maxPerFileChars?: number;
}

const DEFAULT_MAX_TOTAL_CHARS = 120000;
const DEFAULT_MAX_PER_FILE_CHARS = 30000;
const PER_FILE_TRUNCATION_NOTICE = "\n... [diff truncated due to size limit]";
const TOTAL_TRUNCATION_NOTICE = "\n... [diff truncated to preserve context budget]";
/** The shared tail of the budget cut notices. */
const BUDGET_CUT_TEXT = "truncated to preserve context budget";
const METADATA_TRUNCATION_NOTICE = "\n... [metadata truncated to preserve context budget]";
const BUDGET_DROP_REASON = "Context window budget limit reached";
const BINARY_SKIP_REASON = "Binary file has no reviewable text";
const NO_LINES_REASON = "No reviewable lines in the diff";
const PER_FILE_DROP_REASON = "Per-file size limit leaves no whole line";
/** The ignored file list may use at most this share of the payload budget. */
const IGNORED_LIST_SHARE = 0.2;

const REVIEW_LIST_HEADER = "## Files Under Review (Ranked by Risk)";
const IGNORED_LIST_HEADER = "\n## Ignored / Pruned Files";
const DIFF_CONTENT_HEADER = "\n## Diff Content with Exact Line Anchors\n";
const DIFF_SEPARATOR = "\n---\n";

interface PreparedItem {
  file: DiffFile;
  filter: FilterResult;
  path: string;
  /** Scrubbed diff text after the per file cap. */
  text: string;
  /** End index of the first code line in `text`. */
  minimumLength: number;
  isTruncated: boolean;
  /** Line for this file in the "Files Under Review" list. */
  reviewLine: string;
  /** Line for this file in the ignored list when the budget drops it. */
  droppedLine: string;
}

/**
 * Packages parsed diffs into token-budgeted, relevance-ranked context for the AI review engine.
 *
 * The whole emitted payload, metadata included, stays within maxTotalChars.
 * The file list and section headers are reserved first, the ignored file list
 * is capped at a share of the budget, and diff content gets the rest in risk
 * order. A cut of diff content lands on a line boundary and ends with a
 * truncation notice. When the section headers alone exceed the cap, no file
 * is kept and the payload is cut on a line boundary. That cut ends with a
 * truncation notice when the cap has room for it. A file with no reviewable
 * lines is moved to the ignored list instead of being reported as reviewable.
 */
export function packageReviewContext(
  parsedDiff: ParsedDiff,
  options: PackagerOptions = {}
): ReviewContextPackage {
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxPerFileChars = options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS;

  const candidateItems: { file: DiffFile; filter: FilterResult }[] = [];
  const filteredItems: { path: string; reason: string }[] = [];

  for (const file of parsedDiff.files) {
    const targetPath = file.newPath || file.oldPath;
    const filter = evaluateFile(targetPath);

    if (filter.shouldIgnore) {
      filteredItems.push({
        path: targetPath,
        reason: filter.reason || "Ignored by rule",
      });
      continue;
    }
    const reason = unreviewableReason(file);
    if (reason) {
      filteredItems.push({ path: targetPath, reason });
      continue;
    }
    candidateItems.push({ file, filter });
  }

  // Rank by risk weight descending (highest risk files first)
  candidateItems.sort((a, b) => b.filter.riskWeight - a.filter.riskWeight);

  const perFileDrops: { path: string; reason: string }[] = [];
  const prepared: PreparedItem[] = [];
  for (const { file, filter } of candidateItems) {
    const path = file.newPath || file.oldPath;
    const scrubbedPath = scrubSecrets(singleLinePath(path)).scrubbed;
    // Scrub before measuring, so the caps apply to the text actually sent.
    let text = scrubSecrets(formatFileHunks(file)).scrubbed;
    const minimumLength = firstCodeLineEnd(text);
    let isTruncated = false;
    if (text.length > maxPerFileChars) {
      // The notice is part of the text that is sent, so its room is taken off
      // the cap before the cut. The cut then fits the cap with the notice
      // attached.
      const room = maxPerFileChars - PER_FILE_TRUNCATION_NOTICE.length;
      const prefix = prefixThroughWholeLines(text, room, minimumLength);
      if (prefix === null) {
        perFileDrops.push({ path, reason: PER_FILE_DROP_REASON });
        continue;
      }
      if (prefix.length < text.length) {
        text = prefix + PER_FILE_TRUNCATION_NOTICE;
        isTruncated = true;
      }
    }
    prepared.push({
      file,
      filter,
      path,
      text,
      minimumLength,
      isTruncated,
      reviewLine: `- **${scrubbedPath}** [Category: ${filter.category}, Priority: ${filter.riskWeight}/10]`,
      droppedLine: formatIgnoredLine(path, BUDGET_DROP_REASON),
    });
  }
  const filteredLines = [...filteredItems, ...perFileDrops].map((item) =>
    formatIgnoredLine(item.path, item.reason)
  );

  // Keep the longest risk ranked prefix of files that fits. A shorter prefix
  // has less metadata and leaves every kept file at least as much room, so
  // fitting is monotone in the prefix length and a binary search finds it.
  const layoutFor = (count: number) =>
    fitPayload(prepared.slice(0, count), prepared.slice(count), filteredLines, maxTotalChars);
  let layout = layoutFor(prepared.length);
  if (!layout.fits) {
    let fitting = 0;
    let failing = prepared.length;
    while (failing - fitting > 1) {
      const middle = Math.floor((fitting + failing) / 2);
      if (layoutFor(middle).fits) {
        fitting = middle;
      } else {
        failing = middle;
      }
    }
    layout = layoutFor(fitting);
  }

  const itemsToReview: ContextPackageItem[] = layout.kept.map(({ item, text, isTruncated }) => ({
    file: item.file,
    filter: item.filter,
    formattedDiff: text,
    isTruncated,
  }));
  const budgetDropped = prepared.slice(itemsToReview.length);
  const ignoredItems = [
    ...filteredItems,
    ...perFileDrops,
    ...budgetDropped.map((item) => ({ path: item.path, reason: BUDGET_DROP_REASON })),
  ];
  // A file that the budget dropped is named in the ignored list, but the
  // payload must also say that the diff content was cut, so the cut is never
  // silent.
  //
  // The notice travels with the payload, so its room comes out of the
  // metadata. When no file was kept the metadata holds no review line, so the
  // cut cannot take a listed path away.
  let payload = layout.payload;
  if (budgetDropped.length > 0 && !payload.includes(BUDGET_CUT_TEXT)) {
    if (itemsToReview.length === 0 && maxTotalChars > TOTAL_TRUNCATION_NOTICE.length) {
      payload =
        cutAtLineBoundary(payload, maxTotalChars - TOTAL_TRUNCATION_NOTICE.length) +
        TOTAL_TRUNCATION_NOTICE;
    } else if (payload.length + TOTAL_TRUNCATION_NOTICE.length <= maxTotalChars) {
      payload = payload + TOTAL_TRUNCATION_NOTICE;
    }
  }

  return {
    itemsToReview,
    ignoredItems,
    totalReviewableAdditions: itemsToReview.reduce((sum, item) => sum + item.file.addedLinesCount, 0),
    totalReviewableDeletions: itemsToReview.reduce((sum, item) => sum + item.file.deletedLinesCount, 0),
    promptPayload: payload,
  };
}

/** A binary file, or any file with no hunk lines, has nothing to review. */
function unreviewableReason(file: DiffFile): string | null {
  if (file.isBinary) return BINARY_SKIP_REASON;
  if (!file.hunks.some((hunk) => hunk.lines.length > 0)) return NO_LINES_REASON;
  return null;
}

/**
 * A path on one line. A Git path can hold a newline, and the path is written
 * into the payload verbatim, so a raw newline in it would break the line
 * structure and the cut would be measured against the wrong line.
 */
function singleLinePath(path: string): string {
  return path.replace(/[\r\n]/g, (char) => (char === "\r" ? "\\r" : "\\n"));
}

/** Index of the newline that ends the first code line, or the text length. */
function firstCodeLineEnd(text: string): number {
  let start = 0;
  while (start < text.length) {
    const newlineAt = text.indexOf("\n", start);
    const end = newlineAt === -1 ? text.length : newlineAt;
    if (/^[+\- ] /.test(text.slice(start, end))) return end;
    if (newlineAt === -1) break;
    start = newlineAt + 1;
  }
  return text.length;
}

/**
 * Longest prefix of at most `room` characters that ends on a line boundary
 * and still contains the first code line. Null when that line does not fit.
 */
function prefixThroughWholeLines(text: string, room: number, minimumLength: number): string | null {
  if (minimumLength > text.length) return null;
  if (room >= text.length) return text;
  if (room < minimumLength) return null;
  const newlineAt = text.lastIndexOf("\n", room);
  if (newlineAt >= minimumLength) return text.slice(0, newlineAt);
  return null;
}

function formatIgnoredLine(path: string, reason: string): string {
  return `- ${scrubSecrets(singleLinePath(path)).scrubbed} (${scrubSecrets(reason).scrubbed})`;
}

interface PayloadLayout {
  fits: boolean;
  kept: { item: PreparedItem; text: string; isTruncated: boolean }[];
  payload: string;
}

/**
 * Lays out the payload for the given files and reports whether each of them
 * gets room for code. Sections are joined with "\n".
 */
function fitPayload(
  candidates: PreparedItem[],
  dropped: PreparedItem[],
  filteredLines: string[],
  maxTotalChars: number
): PayloadLayout {
  const sections: string[] = [REVIEW_LIST_HEADER, ...candidates.map((item) => item.reviewLine)];
  const ignoredLines = [...filteredLines, ...dropped.map((item) => item.droppedLine)];
  if (ignoredLines.length > 0) {
    sections.push(...formatIgnoredList(ignoredLines, Math.floor(maxTotalChars * IGNORED_LIST_SHARE)));
  }
  sections.push(DIFF_CONTENT_HEADER);

  // Every candidate adds its diff text and a separator, each joined by "\n".
  const fixedLength =
    sections.reduce((total, section) => total + section.length, 0) +
    (sections.length - 1) +
    candidates.length * (2 + DIFF_SEPARATOR.length);
  let available = maxTotalChars - fixedLength;

  const kept: PayloadLayout["kept"] = [];
  for (const item of candidates) {
    if (item.text.length <= available) {
      kept.push({ item, text: item.text, isTruncated: item.isTruncated });
      available -= item.text.length;
      continue;
    }
    const room = available - TOTAL_TRUNCATION_NOTICE.length;
    const prefix = prefixThroughWholeLines(item.text, room, item.minimumLength);
    if (prefix === null) {
      return { fits: false, kept: [], payload: "" };
    }
    kept.push({ item, text: prefix + TOTAL_TRUNCATION_NOTICE, isTruncated: true });
    available = 0;
  }

  for (const { text } of kept) {
    sections.push(text, DIFF_SEPARATOR);
  }
  const payload = sections.join("\n");
  if (payload.length <= maxTotalChars) {
    return { fits: true, kept, payload };
  }
  // Kept files were measured to fit. An overflow here means the headers
  // alone are over the cap, so drop the prefix and let the search shrink it.
  if (kept.length > 0) {
    return { fits: false, kept: [], payload: "" };
  }
  return { fits: true, kept, payload: cutMetadata(payload, maxTotalChars) };
}

/** Cuts metadata to the limit on a line boundary and appends a notice when it fits. */
function cutMetadata(text: string, limit: number): string {
  if (METADATA_TRUNCATION_NOTICE.length <= limit) {
    const body = cutAtLineBoundary(text, limit - METADATA_TRUNCATION_NOTICE.length);
    if (body.length === 0) return METADATA_TRUNCATION_NOTICE.slice(1);
    return body + METADATA_TRUNCATION_NOTICE;
  }
  return cutAtLineBoundary(text, limit);
}

/** Cuts text to the limit on a line boundary. Returns nothing when no whole line fits. */
function cutAtLineBoundary(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const newlineAt = text.lastIndexOf("\n", limit);
  if (newlineAt > 0) return text.slice(0, newlineAt);
  return "";
}

/**
 * Formats the ignored file list within maxChars. Entries that do not fit are
 * summarized in one closing line, so a pull request with thousands of
 * generated files cannot crowd the code out of the payload.
 */
function formatIgnoredList(lines: string[], maxChars: number): string[] {
  const summary = (omitted: number) =>
    `- ... (${omitted} more ignored ${omitted === 1 ? "file" : "files"} not listed)`;

  const sections = [IGNORED_LIST_HEADER];
  let used = IGNORED_LIST_HEADER.length;
  for (let i = 0; i < lines.length; i++) {
    const remaining = lines.length - i - 1;
    const reserve = remaining > 0 ? summary(remaining).length + 1 : 0;
    if (used + 1 + lines[i].length + reserve > maxChars) {
      sections.push(summary(lines.length - i));
      return sections;
    }
    sections.push(lines[i]);
    used += 1 + lines[i].length;
  }
  return sections;
}

function formatFileHunks(file: DiffFile): string {
  const parts: string[] = [];
  const filePath = singleLinePath(file.newPath || file.oldPath);
  parts.push(`### File: ${filePath} (${file.addedLinesCount} additions, ${file.deletedLinesCount} deletions)`);

  for (const hunk of file.hunks) {
    parts.push(`Hunk: ${hunk.header}`);
    for (const line of hunk.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
      const lineNum = line.newLineNumber ? `L${line.newLineNumber}` : line.oldLineNumber ? `L${line.oldLineNumber}` : "";
      parts.push(`${prefix} ${lineNum.padEnd(5)} | ${line.content}`);
    }
  }

  return parts.join("\n");
}
