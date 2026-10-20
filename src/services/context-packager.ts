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
/** Ignored files listed in the prompt payload. */
const MAX_IGNORED_ITEMS_IN_PROMPT = 50;
/** Share of the payload budget the ignored file list may use. */
const IGNORED_LIST_SHARE = 0.05;

const REVIEW_LIST_HEADER = "## Files Under Review (Ranked by Risk)";
const IGNORED_LIST_HEADER = "\n## Ignored / Pruned Files";
const DIFF_CONTENT_HEADER = "\n## Diff Content with Exact Line Anchors\n";
const DIFF_SEPARATOR = "\n---\n";
const PER_FILE_TRUNCATION_NOTICE = "\n... [diff truncated due to size limit]";
const TOTAL_TRUNCATION_NOTICE = "\n... [diff truncated to preserve context budget]";
const BUDGET_DROP_REASON = "Context window budget limit reached";

/**
 * Packages parsed diffs into token-budgeted, relevance-ranked context for the AI review engine.
 *
 * The payload holds the file list, the ignored file list and the diff
 * content, and it stays within maxTotalChars. The ignored file list is
 * capped by count and by length, and the room it needs is reserved from the
 * budget, so a pull request that touches thousands of lockfiles cannot grow
 * the prompt without bound. The list states how many files it left out.
 */
export function packageReviewContext(
  parsedDiff: ParsedDiff,
  options: PackagerOptions = {}
): ReviewContextPackage {
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxPerFileChars = options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS;

  const candidateItems: { file: DiffFile; filter: FilterResult }[] = [];
  const ignoredItems: { path: string; reason: string }[] = [];

  for (const file of parsedDiff.files) {
    const targetPath = file.newPath || file.oldPath;
    const filter = evaluateFile(targetPath);

    if (filter.shouldIgnore) {
      ignoredItems.push({
        path: targetPath,
        reason: filter.reason || "Ignored by rule",
      });
    } else {
      candidateItems.push({ file, filter });
    }
  }

  // Rank by risk weight descending (highest risk files first)
  candidateItems.sort((a, b) => b.filter.riskWeight - a.filter.riskWeight);

  const itemsToReview: ContextPackageItem[] = [];
  const reviewLines: string[] = [];
  const diffSections: string[] = [];
  let totalReviewableAdditions = 0;
  let totalReviewableDeletions = 0;

  // The ignored file list is capped, and the room it may use is reserved
  // from the budget, so the excluded files cannot crowd out the code.
  const ignoredReserve = Math.floor(maxTotalChars * IGNORED_LIST_SHARE);
  // The payload holds the file list, the ignored file list and the diff
  // content, so all three are counted against the budget.
  let used =
    REVIEW_LIST_HEADER.length + ignoredReserve + 1 + DIFF_CONTENT_HEADER.length;

  for (const item of candidateItems) {
    const path = item.file.newPath || item.file.oldPath;
    const reviewLine = `- **${path}** [Category: ${item.filter.category}, Priority: ${item.filter.riskWeight}/10]`;
    const lineCost = reviewLine.length + 1;

    if (used + lineCost >= maxTotalChars) {
      ignoredItems.push({
        path,
        reason: BUDGET_DROP_REASON,
      });
      continue;
    }

    let rawDiffText = formatFileHunks(item.file);
    let isTruncated = false;

    if (rawDiffText.length > maxPerFileChars) {
      rawDiffText = rawDiffText.slice(0, maxPerFileChars) + PER_FILE_TRUNCATION_NOTICE;
      isTruncated = true;
    }

    if (used + lineCost + rawDiffText.length + DIFF_SEPARATOR.length + 1 > maxTotalChars) {
      const room = Math.max(
        0,
        maxTotalChars - used - lineCost - DIFF_SEPARATOR.length - 1 - TOTAL_TRUNCATION_NOTICE.length
      );
      rawDiffText = rawDiffText.slice(0, room) + TOTAL_TRUNCATION_NOTICE;
      isTruncated = true;
    }

    const fileDiffText = scrubSecrets(rawDiffText).scrubbed;

    used += lineCost + fileDiffText.length + DIFF_SEPARATOR.length + 1;
    totalReviewableAdditions += item.file.addedLinesCount;
    totalReviewableDeletions += item.file.deletedLinesCount;

    reviewLines.push(reviewLine);
    diffSections.push(fileDiffText, DIFF_SEPARATOR);
    itemsToReview.push({
      file: item.file,
      filter: item.filter,
      formattedDiff: fileDiffText,
      isTruncated,
    });
  }

  const ignoredLines = formatIgnoredLines(ignoredItems, ignoredReserve);

  const promptPayload = scrubSecrets(
    constructPromptPayload(reviewLines, ignoredLines, diffSections)
  ).scrubbed;

  return {
    itemsToReview,
    ignoredItems,
    totalReviewableAdditions,
    totalReviewableDeletions,
    promptPayload,
  };
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

/**
 * Formats the ignored file list for the prompt. The list is capped by count
 * and by length, so it cannot grow without bound. The closing line states how
 * many files the list left out, so the model knows the list is partial.
 */
function formatIgnoredLines(
  ignoredItems: { path: string; reason: string }[],
  maxChars: number
): string[] {
  // The room for the closing line is reserved first, so it always fits.
  let used = 1 + IGNORED_LIST_HEADER.length + 1 + omittedNotice(ignoredItems.length).length;
  const lines: string[] = [];

  for (const item of ignoredItems.slice(0, MAX_IGNORED_ITEMS_IN_PROMPT)) {
    const line = `- ${item.path} (${item.reason})`;
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }

  const omitted = ignoredItems.length - lines.length;
  if (omitted > 0) lines.push(omittedNotice(omitted));

  return lines;
}

/** States how many ignored files the list left out. */
function omittedNotice(omitted: number): string {
  return `- ... (${omitted} more ignored ${omitted === 1 ? "file" : "files"} not listed)`;
}

function constructPromptPayload(
  reviewLines: string[],
  ignoredLines: string[],
  diffSections: string[]
): string {
  const sections: string[] = [REVIEW_LIST_HEADER, ...reviewLines];

  if (ignoredLines.length > 0) {
    sections.push(IGNORED_LIST_HEADER, ...ignoredLines);
  }

  sections.push(DIFF_CONTENT_HEADER, ...diffSections);

  return sections.join("\n");
}
