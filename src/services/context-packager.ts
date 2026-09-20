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

    let rawDiffText = formatFileHunks(item.file);
    let isTruncated = false;

    if (rawDiffText.length > maxPerFileChars) {
      rawDiffText = rawDiffText.slice(0, maxPerFileChars) + "\n... [diff truncated due to size limit]";
      isTruncated = true;
    }

    if (currentTotalChars + rawDiffText.length > maxTotalChars) {
      const remaining = Math.max(0, maxTotalChars - currentTotalChars);
      rawDiffText = rawDiffText.slice(0, remaining) + "\n... [diff truncated to preserve context budget]";
      isTruncated = true;
    }

    const fileDiffText = scrubSecrets(rawDiffText).scrubbed;

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

  const promptPayload = scrubSecrets(constructPromptPayload(itemsToReview, ignoredItems)).scrubbed;

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

function constructPromptPayload(
  itemsToReview: ContextPackageItem[],
  ignoredItems: { path: string; reason: string }[]
): string {
  const sections: string[] = [];

  sections.push("## Files Under Review (Ranked by Risk)");
  for (const item of itemsToReview) {
    const path = item.file.newPath || item.file.oldPath;
    sections.push(`- **${path}** [Category: ${item.filter.category}, Priority: ${item.filter.riskWeight}/10]`);
  }

  if (ignoredItems.length > 0) {
    sections.push("\n## Ignored / Pruned Files");
    for (const item of ignoredItems) {
      sections.push(`- ${item.path} (${item.reason})`);
    }
  }

  sections.push("\n## Diff Content with Exact Line Anchors\n");
  for (const item of itemsToReview) {
    sections.push(item.formattedDiff);
    sections.push("\n---\n");
  }

  return sections.join("\n");
}
