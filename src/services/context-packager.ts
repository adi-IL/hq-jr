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
const BUDGET_DROP_REASON = "Context window budget limit reached";
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
  /** Shortest cut that still shows code: the file and hunk headers plus one line. */
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
 * order. Every budget cut ends with a truncation notice. A file that would
 * not keep at least one line of code is moved to the ignored list instead of
 * being reported as reviewable.
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
    } else {
      candidateItems.push({ file, filter });
    }
  }

  // Rank by risk weight descending (highest risk files first)
  candidateItems.sort((a, b) => b.filter.riskWeight - a.filter.riskWeight);

  const prepared: PreparedItem[] = candidateItems.map(({ file, filter }) => {
    const path = file.newPath || file.oldPath;
    const scrubbedPath = scrubSecrets(path).scrubbed;
    // Scrub before measuring, so the caps apply to the text actually sent.
    let text = scrubSecrets(formatFileHunks(file)).scrubbed;
    const minimumLength = endOfLine(text, 3);
    let isTruncated = false;
    if (text.length > maxPerFileChars) {
      text = text.slice(0, maxPerFileChars) + PER_FILE_TRUNCATION_NOTICE;
      isTruncated = true;
    }
    return {
      file,
      filter,
      path,
      text,
      minimumLength,
      isTruncated,
      reviewLine: `- **${scrubbedPath}** [Category: ${filter.category}, Priority: ${filter.riskWeight}/10]`,
      droppedLine: formatIgnoredLine(path, BUDGET_DROP_REASON),
    };
  });
  const filteredLines = filteredItems.map((item) => formatIgnoredLine(item.path, item.reason));

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
  const ignoredItems = [
    ...filteredItems,
    ...prepared.slice(itemsToReview.length).map((item) => ({ path: item.path, reason: BUDGET_DROP_REASON })),
  ];

  return {
    itemsToReview,
    ignoredItems,
    totalReviewableAdditions: itemsToReview.reduce((sum, item) => sum + item.file.addedLinesCount, 0),
    totalReviewableDeletions: itemsToReview.reduce((sum, item) => sum + item.file.deletedLinesCount, 0),
    promptPayload: layout.payload,
  };
}

/** Index just past the given number of lines, or the text length if shorter. */
function endOfLine(text: string, lines: number): number {
  let index = -1;
  for (let i = 0; i < lines; i++) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) {
      return text.length;
    }
  }
  return index;
}

function formatIgnoredLine(path: string, reason: string): string {
  return `- ${scrubSecrets(path).scrubbed} (${scrubSecrets(reason).scrubbed})`;
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
    if (room < item.minimumLength) {
      return { fits: false, kept: [], payload: "" };
    }
    kept.push({ item, text: item.text.slice(0, room) + TOTAL_TRUNCATION_NOTICE, isTruncated: true });
    available = 0;
  }

  for (const { text } of kept) {
    sections.push(text, DIFF_SEPARATOR);
  }
  const payload = sections.join("\n");
  // Only reachable with no files kept, when the section headers and the
  // ignored list summary alone exceed a cap far below the default.
  return { fits: true, kept, payload: payload.length > maxTotalChars ? cutAtLineBoundary(payload, maxTotalChars) : payload };
}

/** Cuts text to the limit on a line boundary, so no line is left half written. */
function cutAtLineBoundary(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
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
  const filePath = file.newPath || file.oldPath;
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
