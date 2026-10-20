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
const DIFF_SECTION_HEADER = "\n## Diff Content with Exact Line Anchors\n";
const FILE_SEPARATOR = "\n---\n";
const BUDGET_EXHAUSTED_REASON = "Context window budget limit reached";
const NO_CONTENT_REASON = "No reviewable diff content";

/**
 * Builds the metadata sections. The file list and the ignored list are always
 * sent, so their size is measured before any diff content is added.
 */
function buildMetadataSections(
  items: { file: DiffFile; filter: FilterResult }[],
  ignoredItems: { path: string; reason: string }[]
): string[] {
  const sections: string[] = ["## Files Under Review (Ranked by Risk)"];
  for (const item of items) {
    const path = scrubSecrets(item.file.newPath || item.file.oldPath).scrubbed;
    sections.push(`- **${path}** [Category: ${item.filter.category}, Priority: ${item.filter.riskWeight}/10]`);
  }

  if (ignoredItems.length > 0) {
    sections.push("\n## Ignored / Pruned Files");
    for (const item of ignoredItems) {
      const path = scrubSecrets(item.path).scrubbed;
      const reason = scrubSecrets(item.reason).scrubbed;
      sections.push(`- ${path} (${reason})`);
    }
  }

  return sections;
}

function sectionsLength(sections: string[]): number {
  if (sections.length === 0) {
    return 0;
  }
  return sections.reduce((total, section) => total + section.length, 0) + (sections.length - 1);
}

/**
 * Cuts text to the given limit and keeps a marker, so a partial diff is never
 * read as a complete file. Text that cannot hold the marker is dropped.
 */
function cutWithNotice(text: string, limit: number, notice: string): string {
  if (limit <= 0 || limit <= notice.length) {
    return "";
  }
  return text.slice(0, limit - notice.length) + notice;
}

/**
 * Cuts the payload on a line boundary, so a metadata line is never left half
 * written.
 */
function cutAtLineBoundary(payload: string, maxTotalChars: number): string {
  const cut = payload.slice(0, maxTotalChars);
  const lastBreak = cut.lastIndexOf("\n");
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/**
 * Packages parsed diffs into token-budgeted, relevance-ranked context for the AI review engine.
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

  // The metadata is always sent, so it is measured first and the diff content
  // only gets what the budget leaves.
  const metadataSize = sectionsLength(buildMetadataSections(candidateItems, ignoredItems));
  const contentBudget = Math.max(0, maxTotalChars - metadataSize - DIFF_SECTION_HEADER.length);

  const itemsToReview: ContextPackageItem[] = [];
  let usedContentChars = 0;
  let totalReviewableAdditions = 0;
  let totalReviewableDeletions = 0;

  for (const item of candidateItems) {
    const path = item.file.newPath || item.file.oldPath;
    const remaining = contentBudget - usedContentChars;
    if (remaining <= 0) {
      ignoredItems.push({ path, reason: BUDGET_EXHAUSTED_REASON });
      continue;
    }

    // Scrub before measuring: the cap has to apply to the text that is
    // actually emitted.
    let fileDiffText = scrubSecrets(formatFileHunks(item.file)).scrubbed;
    let isTruncated = false;

    if (fileDiffText.length > maxPerFileChars) {
      fileDiffText = fileDiffText.slice(0, maxPerFileChars) + PER_FILE_TRUNCATION_NOTICE;
      isTruncated = true;
    }

    if (fileDiffText.length > remaining) {
      fileDiffText = cutWithNotice(fileDiffText, remaining, TOTAL_TRUNCATION_NOTICE);
      isTruncated = true;
    }

    // A file without content cannot be reviewed, so it is not offered to the
    // model as a file to review.
    if (fileDiffText.trim().length === 0) {
      ignoredItems.push({ path, reason: NO_CONTENT_REASON });
      continue;
    }

    usedContentChars += fileDiffText.length;
    totalReviewableAdditions += item.file.addedLinesCount;
    totalReviewableDeletions += item.file.deletedLinesCount;

    itemsToReview.push({
      file: item.file,
      filter: item.filter,
      formattedDiff: fileDiffText,
      isTruncated,
    });
  }

  const promptPayload = constructPromptPayload(itemsToReview, ignoredItems, maxTotalChars);

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
 * Builds the final prompt payload and keeps it inside the character cap. The
 * metadata sections and the truncation notices count against the cap too, so
 * the diff content is trimmed until the whole payload fits, and a cut always
 * leaves a marker behind.
 */
function constructPromptPayload(
  itemsToReview: ContextPackageItem[],
  ignoredItems: { path: string; reason: string }[],
  maxTotalChars: number
): string {
  const sections = buildMetadataSections(itemsToReview, ignoredItems);
  sections.push(DIFF_SECTION_HEADER);

  const contentIndexes: number[] = [];
  for (const item of itemsToReview) {
    contentIndexes.push(sections.length);
    sections.push(item.formattedDiff);
    sections.push(FILE_SEPARATOR);
  }

  let overflow = sectionsLength(sections) - maxTotalChars;
  for (let i = contentIndexes.length - 1; i >= 0 && overflow > 0; i--) {
    const index = contentIndexes[i];
    const section = sections[index];
    if (section.length <= TOTAL_TRUNCATION_NOTICE.length) {
      continue;
    }
    const keep = Math.max(0, section.length - overflow - TOTAL_TRUNCATION_NOTICE.length);
    const trimmed = section.slice(0, keep) + TOTAL_TRUNCATION_NOTICE;
    sections[index] = trimmed;
    itemsToReview[i].formattedDiff = trimmed;
    itemsToReview[i].isTruncated = true;
    overflow -= section.length - trimmed.length;
  }

  const payload = sections.join("\n");
  return payload.length > maxTotalChars ? cutAtLineBoundary(payload, maxTotalChars) : payload;
}
