import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { BotId, MemoryRecord } from "@der/domain";
import { validationError } from "../errors";

const SAFE_PROJECTION_ID = /^[A-Za-z0-9._-]+$/;

export type MemoryReconciliationStatus = "created" | "rebuilt" | "unchanged";

export interface MemoryReconciliationResult {
  readonly botId: BotId;
  readonly version: number;
  readonly path: string;
  readonly status: MemoryReconciliationStatus;
}

function assertSafeProjectionId(botId: BotId): void {
  if (
    botId.length === 0 ||
    botId === "." ||
    botId === ".." ||
    botId.includes("..") ||
    !SAFE_PROJECTION_ID.test(botId)
  ) {
    throw validationError(
      "memory.invalid_projection_id",
      "Invalid memory projection identifier",
      `Bot ID "${botId}" cannot be mapped to a safe Markdown projection filename.`,
      "/api/bots/memory",
    );
  }
}

function writeFileAtomically(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp-${crypto.randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "wx", 0o644);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup before unlinking temp file.
      }
    }
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Best-effort temp file cleanup.
    }
    throw error;
  }
}

export class MemoryProjection {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  pathForBot(botId: BotId): string {
    assertSafeProjectionId(botId);
    const targetPath = resolve(this.rootDir, `${botId}.md`);
    const rel = relative(this.rootDir, targetPath);
    if (rel.startsWith("..") || rel.includes(sep)) {
      throw validationError(
        "memory.invalid_projection_id",
        "Invalid memory projection path",
        `Bot ID "${botId}" resolves outside the memory projection root.`,
        `/api/bots/${botId}/memory`,
      );
    }
    return targetPath;
  }

  async project(record: MemoryRecord): Promise<MemoryReconciliationResult> {
    return this.reconcile(record);
  }

  async reconcile(record: MemoryRecord): Promise<MemoryReconciliationResult> {
    mkdirSync(this.rootDir, { recursive: true });
    const targetPath = this.pathForBot(record.botId);

    if (!existsSync(targetPath)) {
      writeFileAtomically(targetPath, record.markdown);
      return {
        botId: record.botId,
        version: record.version,
        path: targetPath,
        status: "created",
      };
    }

    const existing = readFileSync(targetPath, "utf8");
    if (existing === record.markdown) {
      return {
        botId: record.botId,
        version: record.version,
        path: targetPath,
        status: "unchanged",
      };
    }

    writeFileAtomically(targetPath, record.markdown);
    return {
      botId: record.botId,
      version: record.version,
      path: targetPath,
      status: "rebuilt",
    };
  }
}

export function createMemoryProjection(rootDir: string): MemoryProjection {
  return new MemoryProjection(rootDir);
}
