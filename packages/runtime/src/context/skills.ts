import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import { DomainError, type Skill, type SkillId } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import {
  assertSafeResourcePath,
  MAX_SKILL_WALK_DEPTH,
  SKILL_FILE,
  type SkillSource,
} from "@tanstack/ai-skills";
import { parse as parseYaml } from "yaml";

export interface RejectedSkill {
  readonly relativePath: string;
  readonly reason: string;
}

export interface LoadedSkillCatalog {
  readonly skills: readonly Skill[];
  readonly rejected: readonly RejectedSkill[];
}

export interface SkillCatalogOptions {
  readonly rootDir: string;
  readonly maxDepth?: number;
}

const VALID_SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function toPosixRelative(rootDir: string, targetPath: string): string {
  const rel = relative(rootDir, targetPath);
  return rel.split(sep).join(posix.sep);
}

function isInsideRoot(rootRealPath: string, candidateRealPath: string): boolean {
  if (candidateRealPath === rootRealPath) {
    return true;
  }
  const prefix = rootRealPath.endsWith(sep) ? rootRealPath : `${rootRealPath}${sep}`;
  return candidateRealPath.startsWith(prefix);
}

function pathOutsideRootError(skillId: string, requestedPath: string): DomainError {
  return new DomainError({
    type: "https://der.invalid/problems/skill-path-outside-root",
    title: "Skill path outside configured root",
    status: 400,
    detail: `Path "${requestedPath}" for skill "${skillId}" is outside the configured skills root.`,
    instance: `/api/skills/${skillId}`,
    code: "skill.path_outside_root",
  });
}

function skillNotFoundError(skillId: string): DomainError {
  return new DomainError({
    type: "https://der.invalid/problems/skill-not-found",
    title: "Skill not found",
    status: 404,
    detail: `Skill "${skillId}" does not exist in the catalog.`,
    instance: `/api/skills/${skillId}`,
    code: "skill.not_found",
  });
}

function splitSkillFrontmatter(
  raw: string,
): { readonly frontmatter: string; readonly body: string } | null {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(normalized);
  if (!match) {
    return null;
  }
  return {
    frontmatter: match[1] ?? "",
    body: (match[2] ?? "").trim(),
  };
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const items = value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      out[key] = String(entry);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSkillDocument(raw: string): {
  readonly frontmatter: ReturnType<typeof compiledParsers.skillFrontmatter.parse>;
  readonly body: string;
} {
  const split = splitSkillFrontmatter(raw);
  if (!split) {
    throw new Error("SKILL.md is missing a YAML frontmatter block.");
  }

  const parsedYaml = parseYaml(split.frontmatter) as unknown;
  if (typeof parsedYaml !== "object" || parsedYaml === null || Array.isArray(parsedYaml)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping.");
  }

  const record = parsedYaml as Record<string, unknown>;
  const allowedTools = parseAllowedTools(record["allowed-tools"] ?? record["allowedTools"]);
  const metadata = parseStringRecord(record["metadata"]);

  const candidate = {
    name: record["name"],
    description: record["description"],
    ...(typeof record["license"] === "string" ? { license: record["license"] } : {}),
    ...(typeof record["compatibility"] === "string"
      ? { compatibility: record["compatibility"] }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };

  const validated = compiledParsers.skillFrontmatter.safeParse(candidate);
  if (!validated.success) {
    throw new Error(`Invalid SKILL.md frontmatter: ${validated.error.message}`);
  }
  if (!VALID_SKILL_NAME.test(validated.data.name)) {
    throw new Error(
      `Skill name "${validated.data.name}" must use lowercase letters, digits, and hyphens.`,
    );
  }

  return {
    frontmatter: validated.data,
    body: split.body,
  };
}

interface InternalSkillEntry {
  readonly skill: Skill;
  readonly dirRealPath: string;
  readonly skillFileRealPath: string;
}

export class SkillCatalog {
  private readonly rootDir: string;
  private readonly maxDepth: number;

  constructor(options: SkillCatalogOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxDepth = options.maxDepth ?? MAX_SKILL_WALK_DEPTH;
  }

  private resolveRootRealPath(): string | undefined {
    if (!existsSync(this.rootDir)) {
      return undefined;
    }
    return realpathSync(this.rootDir);
  }

  private scanEntries(): {
    readonly entries: readonly InternalSkillEntry[];
    readonly rejected: readonly RejectedSkill[];
  } {
    const rootRealPath = this.resolveRootRealPath();
    if (!rootRealPath) {
      return { entries: [], rejected: [] };
    }

    const entries: InternalSkillEntry[] = [];
    const rejected: RejectedSkill[] = [];
    const seenIds = new Set<string>();

    const walk = (currentDir: string, depth: number): void => {
      if (depth > this.maxDepth) {
        return;
      }

      const dirents = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) {
          continue;
        }
        const fullPath = resolve(currentDir, dirent.name);
        const relPath = toPosixRelative(rootRealPath, fullPath);

        let entryStat;
        try {
          entryStat = lstatSync(fullPath);
        } catch {
          rejected.push({ relativePath: relPath, reason: "Unable to inspect skill path." });
          continue;
        }

        let resolvedTarget: string;
        try {
          resolvedTarget = realpathSync(fullPath);
        } catch {
          rejected.push({ relativePath: relPath, reason: "Broken symlink inside skills root." });
          continue;
        }

        if (!isInsideRoot(rootRealPath, resolvedTarget)) {
          rejected.push({
            relativePath: relPath,
            reason: "Path resolves outside configured skills root.",
          });
          continue;
        }

        const targetStat = entryStat.isSymbolicLink() ? statSync(resolvedTarget) : entryStat;
        if (!targetStat.isDirectory()) {
          continue;
        }

        const skillFilePath = resolve(resolvedTarget, SKILL_FILE);
        if (existsSync(skillFilePath)) {
          const skillRelPath = toPosixRelative(rootRealPath, resolve(fullPath, SKILL_FILE));
          let skillFileRealPath: string;
          try {
            skillFileRealPath = realpathSync(skillFilePath);
          } catch {
            rejected.push({
              relativePath: skillRelPath,
              reason: "SKILL.md symlink could not be resolved.",
            });
            continue;
          }

          if (
            !isInsideRoot(rootRealPath, skillFileRealPath) ||
            !isInsideRoot(resolvedTarget, skillFileRealPath)
          ) {
            rejected.push({
              relativePath: skillRelPath,
              reason: "SKILL.md resolves outside its skill directory.",
            });
            continue;
          }

          const raw = readFileSync(skillFileRealPath, "utf8");
          try {
            const { frontmatter } = parseSkillDocument(raw);
            if (seenIds.has(frontmatter.name)) {
              rejected.push({
                relativePath: skillRelPath,
                reason: `Duplicate skill name "${frontmatter.name}".`,
              });
              continue;
            }

            const safeSkill = compiledParsers.skill.parse({
              id: frontmatter.name,
              name: frontmatter.name,
              description: frontmatter.description,
              relativePath: skillRelPath,
              ...(frontmatter.license !== undefined ? { license: frontmatter.license } : {}),
              ...(frontmatter.compatibility !== undefined
                ? { compatibility: frontmatter.compatibility }
                : {}),
              ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
              ...(frontmatter.allowedTools !== undefined
                ? { allowedTools: frontmatter.allowedTools }
                : {}),
            });

            seenIds.add(safeSkill.id);
            entries.push({
              skill: safeSkill,
              dirRealPath: resolvedTarget,
              skillFileRealPath,
            });
          } catch (error) {
            rejected.push({
              relativePath: skillRelPath,
              reason:
                error instanceof Error ? error.message : "Failed to parse SKILL.md frontmatter.",
            });
          }
          continue;
        }

        walk(resolvedTarget, depth + 1);
      }
    };

    walk(rootRealPath, 0);
    entries.sort((a, b) => a.skill.name.localeCompare(b.skill.name));

    return { entries, rejected };
  }

  async loadCatalog(): Promise<LoadedSkillCatalog> {
    const { entries, rejected } = this.scanEntries();
    return {
      skills: entries.map((entry) => entry.skill),
      rejected,
    };
  }

  async listSkills(): Promise<readonly Skill[]> {
    const { skills } = await this.loadCatalog();
    return skills;
  }

  private findEntry(skillId: SkillId): InternalSkillEntry {
    const { entries } = this.scanEntries();
    const match = entries.find((entry) => entry.skill.id === skillId);
    if (!match) {
      throw skillNotFoundError(skillId);
    }
    return match;
  }

  async readSkillBody(skillId: SkillId): Promise<string> {
    const entry = this.findEntry(skillId);
    const raw = readFileSync(entry.skillFileRealPath, "utf8");
    return parseSkillDocument(raw).body;
  }

  async readSkillResource(skillId: SkillId, resourcePath: string): Promise<string> {
    const rootRealPath = this.resolveRootRealPath();
    if (!rootRealPath) {
      throw skillNotFoundError(skillId);
    }
    if (
      resourcePath.length === 0 ||
      resourcePath.includes("\0") ||
      resourcePath.includes("\\") ||
      resourcePath.startsWith("/") ||
      resourcePath.split("/").includes("..")
    ) {
      throw pathOutsideRootError(skillId, resourcePath);
    }
    try {
      assertSafeResourcePath(resourcePath);
    } catch {
      throw pathOutsideRootError(skillId, resourcePath);
    }

    const entry = this.findEntry(skillId);
    const candidatePath = resolve(entry.dirRealPath, resourcePath);
    if (
      !isInsideRoot(entry.dirRealPath, candidatePath) ||
      !isInsideRoot(rootRealPath, candidatePath)
    ) {
      throw pathOutsideRootError(skillId, resourcePath);
    }
    if (!existsSync(candidatePath)) {
      throw new DomainError({
        type: "https://der.invalid/problems/skill-resource-not-found",
        title: "Skill resource not found",
        status: 404,
        detail: `Resource "${resourcePath}" does not exist for skill "${skillId}".`,
        instance: `/api/skills/${skillId}`,
        code: "skill.resource_not_found",
      });
    }

    const targetRealPath = realpathSync(candidatePath);
    if (
      !isInsideRoot(entry.dirRealPath, targetRealPath) ||
      !isInsideRoot(rootRealPath, targetRealPath)
    ) {
      throw pathOutsideRootError(skillId, resourcePath);
    }

    const targetStat = statSync(targetRealPath);
    if (!targetStat.isFile()) {
      throw pathOutsideRootError(skillId, resourcePath);
    }

    return readFileSync(targetRealPath, "utf8");
  }

  toSkillSource(): SkillSource {
    return {
      list: async () => {
        const skills = await this.listSkills();
        return skills.map((entry) => ({
          name: entry.name,
          description: entry.description,
          ...(entry.license !== undefined ? { license: entry.license } : {}),
          ...(entry.compatibility !== undefined ? { compatibility: entry.compatibility } : {}),
          ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
          ...(entry.allowedTools !== undefined ? { allowedTools: [...entry.allowedTools] } : {}),
        }));
      },
      load: async (name: string) => {
        const entry = this.findEntry(name);
        return readFileSync(entry.skillFileRealPath, "utf8");
      },
      readResource: async (name: string, path: string) => this.readSkillResource(name, path),
    };
  }
}

export function createSkillCatalog(options: SkillCatalogOptions): SkillCatalog {
  return new SkillCatalog(options);
}
