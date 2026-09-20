import { createHash } from "node:crypto";
import { setCachedSymbol, getCachedSymbol } from "./db.js";
import type Database from "better-sqlite3";

export interface ExtractedSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "constant" | "method";
  line?: number;
  exported?: boolean;
  signature?: string;
}

export function computeContentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface CacheSymbolsParams {
  repo: string;
  commitSha: string;
  filePath: string;
  content: string | Buffer;
  symbols: ExtractedSymbol[];
  db?: Database.Database;
}

export function cacheSymbols(params: CacheSymbolsParams): string {
  const contentHash = computeContentHash(params.content);
  setCachedSymbol(
    {
      repo: params.repo,
      commitSha: params.commitSha,
      filePath: params.filePath,
      contentHash,
      symbolsJson: JSON.stringify(params.symbols),
    },
    params.db
  );
  return contentHash;
}

export interface GetCachedSymbolsParams {
  repo: string;
  commitSha: string;
  filePath: string;
  content?: string | Buffer;
  db?: Database.Database;
}

export function getCachedSymbols(params: GetCachedSymbolsParams): ExtractedSymbol[] | null {
  const contentHash = params.content !== undefined ? computeContentHash(params.content) : undefined;
  const rawJson = getCachedSymbol(
    {
      repo: params.repo,
      commitSha: params.commitSha,
      filePath: params.filePath,
      contentHash,
    },
    params.db
  );

  if (!rawJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      return parsed as ExtractedSymbol[];
    }
    return null;
  } catch {
    return null;
  }
}

export interface IsContentUnmodifiedParams {
  repo: string;
  commitSha: string;
  filePath: string;
  content: string | Buffer;
  db?: Database.Database;
}

export function isContentUnmodified(params: IsContentUnmodifiedParams): boolean {
  const currentHash = computeContentHash(params.content);
  const raw = getCachedSymbol(
    {
      repo: params.repo,
      commitSha: params.commitSha,
      filePath: params.filePath,
      contentHash: currentHash,
    },
    params.db
  );
  return raw !== null;
}
