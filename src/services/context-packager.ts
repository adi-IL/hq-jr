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
const MAX_IGNORED_ITEMS_IN_PROMPT = 50;
const IGNORED_LIST_SHARE = 0.05;
const REVIEW_LIST_HEADER = "## Files Under Review (Ranked by Risk)";
const IGNORED_LIST_HEADER = "## Ignored / Pruned Files";
const DIFF_CONTENT_HEADER = "## Diff Content with Exact Line Anchors";
const DIFF_SEPARATOR = "---";
const PER_FILE_TRUNCATION_NOTICE = "\n... [diff truncated due to size limit]";
const TOTAL_TRUNCATION_NOTICE = "\n... [diff truncated to preserve context budget]";
export const BUDGET_DROP_REASON = "Context window budget limit reached";

interface PreparedItem {
  file: DiffFile;
  filter: FilterResult;
  path: string;
  reviewLine: string;
  text: string;
  minimumText: string;
  isPerFileTruncated: boolean;
}

interface RenderedItem {
  item: PreparedItem;
  text: string;
  isTruncated: boolean;
}

interface Layout {
  fits: boolean;
  payload: string;
  kept: RenderedItem[];
}

/** Packages risk-ranked diffs into a character-bounded, scrubbed prompt. */
export function packageReviewContext(
  parsedDiff: ParsedDiff,
  options: PackagerOptions = {}
): ReviewContextPackage {
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxPerFileChars = options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS;
  const candidates: { file: DiffFile; filter: FilterResult }[] = [];
  const ignoredItems: { path: string; reason: string }[] = [];

  for (const file of parsedDiff.files) {
    const path = file.newPath || file.oldPath;
    const filter = evaluateFile(path);
    if (filter.shouldIgnore) ignoredItems.push({ path, reason: filter.reason || "Ignored by rule" });
    else candidates.push({ file, filter });
  }

  candidates.sort((a, b) => b.filter.riskWeight - a.filter.riskWeight);
  const prepared = candidates.map(({ file, filter }) => prepareItem(file, filter, maxPerFileChars));
  const layoutFor = (count: number) =>
    layoutPayload(prepared.slice(0, count), prepared.slice(count), ignoredItems, maxTotalChars);

  let low = 0;
  let high = prepared.length;
  let layout = layoutFor(high);
  if (!layout.fits) {
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (layoutFor(middle).fits) low = middle;
      else high = middle - 1;
    }
    layout = layoutFor(low);
  }

  const itemsToReview = layout.kept.map(({ item, text, isTruncated }) => ({
    file: item.file,
    filter: item.filter,
    formattedDiff: text,
    isTruncated,
  }));
  const budgetDropped = prepared.slice(itemsToReview.length).map((item) => ({
    path: item.path,
    reason: BUDGET_DROP_REASON,
  }));

  return {
    itemsToReview,
    ignoredItems: [...ignoredItems, ...budgetDropped],
    totalReviewableAdditions: itemsToReview.reduce((sum, item) => sum + item.file.addedLinesCount, 0),
    totalReviewableDeletions: itemsToReview.reduce((sum, item) => sum + item.file.deletedLinesCount, 0),
    promptPayload: layout.payload,
  };
}

function prepareItem(file: DiffFile, filter: FilterResult, maxPerFileChars: number): PreparedItem {
  const path = file.newPath || file.oldPath;
  const fullText = scrubSecrets(formatFileHunks(file)).scrubbed;
  const minimumText = firstCodeLine(fullText);
  let text = fullText;
  let isPerFileTruncated = false;
  if (text.length > maxPerFileChars) {
    text = cutAtLineBoundary(text, maxPerFileChars);
    isPerFileTruncated = true;
    if (text.length > 0) text += PER_FILE_TRUNCATION_NOTICE;
  }
  return {
    file, filter, path, minimumText, text, isPerFileTruncated,
    reviewLine: scrubSecrets(`- **${path}** [Category: ${filter.category}, Priority: ${filter.riskWeight}/10]`).scrubbed,
  };
}

function layoutPayload(
  candidates: PreparedItem[], dropped: PreparedItem[], filtered: { path: string; reason: string }[], maxTotalChars: number
): Layout {
  const ignoredLines = formatIgnoredLines(
    [...filtered, ...dropped.map((item) => ({ path: item.path, reason: BUDGET_DROP_REASON }))],
    Math.floor(maxTotalChars * IGNORED_LIST_SHARE)
  );
  const metadata = [
    REVIEW_LIST_HEADER,
    ...candidates.map((item) => item.reviewLine),
    ...(ignoredLines.length > 0 ? [IGNORED_LIST_HEADER, ...ignoredLines] : []),
    DIFF_CONTENT_HEADER,
  ];
  const metadataText = metadata.join("\n");
  const kept: RenderedItem[] = [];
  const payloadParts = [...metadata];

  if (candidates.length === 0 && dropped.length > 0) {
    const payload = scrubSecrets(`${metadataText}${TOTAL_TRUNCATION_NOTICE}`).scrubbed;
    if (payload.length <= maxTotalChars) return { fits: true, payload, kept };
  }

  for (const item of candidates) {
    if (item.text.length < item.minimumText.length) return { fits: false, payload: "", kept: [] };
    const currentLength = payloadParts.join("\n").length;
    const available = maxTotalChars - currentLength - 1;
    let text = item.text;
    let isTruncated = item.isPerFileTruncated;
    if (text.length + 1 + DIFF_SEPARATOR.length > available) {
      const contentRoom = available - 1 - DIFF_SEPARATOR.length - TOTAL_TRUNCATION_NOTICE.length;
      const cut = cutAtLineBoundary(item.text, contentRoom);
      if (cut.length < item.minimumText.length) return { fits: false, payload: "", kept: [] };
      text = `${cut}${TOTAL_TRUNCATION_NOTICE}`;
      isTruncated = true;
    }
    payloadParts.push(text, DIFF_SEPARATOR);
    kept.push({ item, text, isTruncated });
  }

  // Scrub after assembly too. This catches a secret split across boundaries.
  const payload = scrubSecrets(payloadParts.join("\n")).scrubbed;
  if (payload.length > maxTotalChars) return { fits: false, payload: "", kept: [] };
  if (candidates.length === 0 && metadataText.length > maxTotalChars) {
    return { fits: true, payload: cutMetadata(metadataText, maxTotalChars), kept: [] };
  }
  return { fits: true, payload, kept };
}

function formatIgnoredLines(items: { path: string; reason: string }[], maxChars: number): string[] {
  if (items.length === 0) return [];
  const summary = (count: number) => `- ... (${count} more ignored ${count === 1 ? "file" : "files"} not listed)`;
  const lines = items.slice(0, MAX_IGNORED_ITEMS_IN_PROMPT).map((item) =>
    scrubSecrets(`- ${item.path} (${item.reason})`).scrubbed
  );
  const output: string[] = [];
  let used = IGNORED_LIST_HEADER.length;
  for (let index = 0; index < lines.length; index++) {
    const omitted = items.length - index - 1;
    const reserve = omitted > 0 ? 1 + summary(omitted).length : 0;
    if (used + 1 + lines[index].length + reserve > maxChars) break;
    output.push(lines[index]);
    used += 1 + lines[index].length;
  }
  const omitted = items.length - output.length;
  if (omitted > 0 && used + 1 + summary(omitted).length <= maxChars) output.push(summary(omitted));
  return output;
}

function firstCodeLine(text: string): string {
  let offset = -1;
  for (let line = 0; line < 3; line++) {
    offset = text.indexOf("\n", offset + 1);
    if (offset === -1) return text;
  }
  return text.slice(0, offset);
}

function cutAtLineBoundary(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const lastBreak = text.slice(0, limit).lastIndexOf("\n");
  return lastBreak >= 0 ? text.slice(0, lastBreak) : "";
}

function cutMetadata(text: string, maxChars: number): string {
  return scrubSecrets(cutAtLineBoundary(text, maxChars)).scrubbed;
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
