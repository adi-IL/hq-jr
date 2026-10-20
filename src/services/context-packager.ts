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

  const itemsToReview: ContextPackageItem[] = [];
  let currentTotalChars = 0;
  let totalReviewableAdditions = 0;
  let totalReviewableDeletions = 0;

  for (const item of candidateItems) {
    if (currentTotalChars >= maxTotalChars) {
      ignoredItems.push({
        path: item.file.newPath || item.file.oldPath,
        reason: "Context window budget limit reached",
      });
      continue;
    }

    // Scrub before measuring: the placeholder is longer than the text it
    // replaces, so budgeting on raw text would overshoot the cap.
    let fileDiffText = scrubSecrets(formatFileHunks(item.file)).scrubbed;
    let isTruncated = false;

    if (fileDiffText.length > maxPerFileChars) {
      fileDiffText = fileDiffText.slice(0, maxPerFileChars) + PER_FILE_TRUNCATION_NOTICE;
      isTruncated = true;
    }

    const remaining = maxTotalChars - currentTotalChars;
    if (fileDiffText.length > remaining) {
      if (remaining <= TOTAL_TRUNCATION_NOTICE.length) {
        fileDiffText = fileDiffText.slice(0, Math.max(0, remaining));
      } else {
        fileDiffText =
          fileDiffText.slice(0, remaining - TOTAL_TRUNCATION_NOTICE.length) + TOTAL_TRUNCATION_NOTICE;
      }
      isTruncated = true;
    }

    currentTotalChars += fileDiffText.length;
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
 * diff content is trimmed until the whole payload fits.
 */
function constructPromptPayload(
  itemsToReview: ContextPackageItem[],
  ignoredItems: { path: string; reason: string }[],
  maxTotalChars: number
): string {
  const sections: string[] = [];

  sections.push("## Files Under Review (Ranked by Risk)");
  for (const item of itemsToReview) {
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

  sections.push("\n## Diff Content with Exact Line Anchors\n");

  const contentIndexes: number[] = [];
  for (const item of itemsToReview) {
    contentIndexes.push(sections.length);
    sections.push(item.formattedDiff);
    sections.push("\n---\n");
  }

  const payloadLength = () =>
    sections.reduce((total, section) => total + section.length, 0) + (sections.length - 1);

  let overflow = payloadLength() - maxTotalChars;
  for (let i = contentIndexes.length - 1; i >= 0 && overflow > 0; i--) {
    const index = contentIndexes[i];
    const cut = Math.min(overflow, sections[index].length);
    sections[index] = sections[index].slice(0, sections[index].length - cut);
    itemsToReview[i].formattedDiff = sections[index];
    itemsToReview[i].isTruncated = true;
    overflow -= cut;
  }

  const payload = sections.join("\n");
  return payload.length > maxTotalChars ? payload.slice(0, maxTotalChars) : payload;
}
