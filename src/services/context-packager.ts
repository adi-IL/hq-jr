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
/** Reason recorded for a file that was dropped because the budget ran out. */
export const BUDGET_DROP_REASON = "Context window budget limit reached";

/**
 * Packages parsed diffs into token-budgeted, relevance-ranked context for the AI review engine.
 *
 * The payload holds the file list, the ignored file list and the diff
 * content, and it stays within maxTotalChars. The ignored file list is
 * capped by count and by length, and the room it needs is reserved from the
 * budget, so a pull request that touches thousands of lockfiles cannot grow
 * the prompt without bound. The list states how many files it left out.
 *
 * Every part is scrubbed before it is measured, because a redaction can
 * replace a short secret with a longer placeholder. The budget therefore
 * holds for the text that is actually sent, and not for the text before the
 * redaction. A cut payload always says that it was cut.
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
  // Set when the diff content was cut without a notice of its own, so the
  // payload can say that the content was cut.
  let payloadNotice: string | null = null;

  // The ignored file list is capped, and the room it may use is reserved
  // from the budget, so the excluded files cannot crowd out the code.
  const ignoredReserve = Math.floor(maxTotalChars * IGNORED_LIST_SHARE);
  // The payload holds the file list, the ignored file list and the diff
  // content, so all three are counted against the budget.
  let used =
    REVIEW_LIST_HEADER.length + ignoredReserve + 1 + DIFF_CONTENT_HEADER.length;

  for (const item of candidateItems) {
    const path = item.file.newPath || item.file.oldPath;
    // The review line is scrubbed before it is measured, because a redaction
    // can replace a short secret with a longer placeholder.
    const reviewLine = scrubSecrets(
      `- **${path}** [Category: ${item.filter.category}, Priority: ${item.filter.riskWeight}/10]`
    ).scrubbed;
    const lineCost = reviewLine.length + 1;

    if (used + lineCost >= maxTotalChars) {
      ignoredItems.push({
        path,
        reason: BUDGET_DROP_REASON,
      });
      continue;
    }

    // The diff text is scrubbed before the budget is measured. A redaction
    // can replace a short secret with the longer placeholder, so the budget
    // has to hold for the text that is actually sent.
    let fileDiffText = scrubSecrets(formatFileHunks(item.file)).scrubbed;
    let isTruncated = false;
    // False when the file has no room for any content at all, so the payload
    // does not carry an empty diff section.
    let emitDiffSection = true;

    if (fileDiffText.length > maxPerFileChars) {
      fileDiffText = fileDiffText.slice(0, maxPerFileChars) + PER_FILE_TRUNCATION_NOTICE;
      isTruncated = true;
    }

    // The room that is left for this file, once its review line and the two
    // join delimiters around its separator are paid for. The diff sections
    // are joined with a newline on each side of the separator, so a file
    // costs two delimiters, not one.
    const available = maxTotalChars - used - lineCost - DIFF_SEPARATOR.length - 2;
    if (fileDiffText.length > available) {
      if (available < TOTAL_TRUNCATION_NOTICE.length) {
        // Even the notice does not fit next to the content. The file keeps
        // its place in the review list, and the payload says that the diff
        // content was cut, so the cut is never silent.
        fileDiffText = "";
        isTruncated = true;
        emitDiffSection = false;
        if (!payloadNotice) {
          payloadNotice = TOTAL_TRUNCATION_NOTICE;
          // The notice travels with the payload, so its room is taken from
          // the budget as soon as it is known.
          used += TOTAL_TRUNCATION_NOTICE.length;
        }
      } else {
        // The room for the notice is taken off the content before the cut, so
        // the payload with the notice stays inside the budget.
        fileDiffText =
          fileDiffText.slice(0, available - TOTAL_TRUNCATION_NOTICE.length) +
          TOTAL_TRUNCATION_NOTICE;
        isTruncated = true;
      }
    }

    used += lineCost + fileDiffText.length + DIFF_SEPARATOR.length + 2;
    totalReviewableAdditions += item.file.addedLinesCount;
    totalReviewableDeletions += item.file.deletedLinesCount;

    reviewLines.push(reviewLine);
    if (emitDiffSection) diffSections.push(fileDiffText, DIFF_SEPARATOR);
    itemsToReview.push({
      file: item.file,
      filter: item.filter,
      formattedDiff: fileDiffText,
      isTruncated,
    });
  }

  const ignoredLines = formatIgnoredLines(ignoredItems, ignoredReserve);

  const promptPayload = buildPromptPayload({
    reviewLines,
    ignoredLines,
    diffSections,
    payloadNotice,
    maxTotalChars,
  });

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
 * many files the list left out, so the model knows the list is partial. The
 * list stays inside the room it reserved from the budget, so it cannot push
 * the payload past that budget.
 */
function formatIgnoredLines(
  ignoredItems: { path: string; reason: string }[],
  maxChars: number
): string[] {
  if (ignoredItems.length === 0) return [];

  // The room for the closing line is reserved first, so it always fits.
  const overhead = IGNORED_LIST_HEADER.length + omittedNotice(ignoredItems.length).length;
  if (overhead > maxChars) {
    // The list does not fit in the room it reserved. It is left out rather
    // than pushed over the budget of the payload.
    return [];
  }

  let used = overhead;
  const lines: string[] = [];

  for (const item of ignoredItems.slice(0, MAX_IGNORED_ITEMS_IN_PROMPT)) {
    // The line is scrubbed before it is measured, because a redaction can
    // replace a short secret with a longer placeholder.
    const line = scrubSecrets(`- ${item.path} (${item.reason})`).scrubbed;
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

/**
 * Builds the prompt payload and keeps it inside the budget. The payload is
 * scrubbed as a whole, so a secret that spans two parts is still redacted,
 * and the length that is checked is the length of the text that is sent.
 *
 * When the parts do not fit, the diff content is dropped before the notice
 * that says the diff was cut, because a payload that hides its own cut is
 * worse than a payload that says it.
 */
function buildPromptPayload(params: {
  reviewLines: string[];
  ignoredLines: string[];
  diffSections: string[];
  payloadNotice: string | null;
  maxTotalChars: number;
}): string {
  const head: string[] = [REVIEW_LIST_HEADER, ...params.reviewLines];
  if (params.ignoredLines.length > 0) {
    head.push(IGNORED_LIST_HEADER, ...params.ignoredLines);
  }
  const body: string[] = [DIFF_CONTENT_HEADER, ...params.diffSections];
  const notice = params.payloadNotice ?? "";

  const headText = head.join("\n");
  const bodyText = body.join("\n");

  const withBody = scrubSecrets(`${headText}\n${bodyText}${notice}`).scrubbed;
  if (withBody.length <= params.maxTotalChars) return withBody;

  // The payload does not fit. The diff content goes first, because the notice
  // that says the content was cut matters more than the content itself.
  const withoutBody = scrubSecrets(`${headText}${notice}`).scrubbed;
  if (withoutBody.length <= params.maxTotalChars) return withoutBody;

  // The review list and the notice do not fit either. The tail of the list
  // is cut so the payload that is sent stays inside the budget.
  const room = Math.max(0, params.maxTotalChars - notice.length);
  return `${scrubSecrets(headText).scrubbed.slice(0, room)}${notice}`;
}
