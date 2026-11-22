import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@der/domain";
import { createSkillCatalog } from "../../src/context/index";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Operator-managed Agent Skills loader with root containment", () => {
  it("loads valid SKILL.md packages, validates required frontmatter, rejects malformed ones, and returns safe catalog metadata", async () => {
    const root = createTempDir("der-skills-root-");
    const validDir = join(root, "deploy-check");
    const refDir = join(validDir, "references");
    mkdirSync(refDir, { recursive: true });
    writeFileSync(
      join(validDir, "SKILL.md"),
      [
        "---",
        "name: deploy-check",
        "description: Verify release checklist before deployment.",
        "license: MIT",
        "compatibility: bun>=1.4",
        "allowed-tools: notes.search_notes docker.execute",
        "metadata:",
        "  owner: ops",
        "---",
        "# Deploy Check",
        "",
        "Confirm migrations before rollout.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(refDir, "checklist.md"), "- Check WAL mode\n", "utf8");

    const invalidMissingDesc = join(root, "missing-desc");
    mkdirSync(invalidMissingDesc, { recursive: true });
    writeFileSync(
      join(invalidMissingDesc, "SKILL.md"),
      ["---", "name: missing-desc", "---", "Body without description."].join("\n"),
      "utf8",
    );

    const invalidNoFrontmatter = join(root, "no-frontmatter");
    mkdirSync(invalidNoFrontmatter, { recursive: true });
    writeFileSync(join(invalidNoFrontmatter, "SKILL.md"), "# Plain markdown only\n", "utf8");

    const catalog = createSkillCatalog({ rootDir: root });
    const loaded = await catalog.loadCatalog();

    expect(loaded.skills).toEqual([
      {
        id: "deploy-check",
        name: "deploy-check",
        description: "Verify release checklist before deployment.",
        relativePath: "deploy-check/SKILL.md",
        license: "MIT",
        compatibility: "bun>=1.4",
        metadata: { owner: "ops" },
        allowedTools: ["notes.search_notes", "docker.execute"],
      },
    ]);
    expect(loaded.rejected).toHaveLength(2);
    for (const issue of loaded.rejected) {
      expect(issue.relativePath).not.toContain(root);
    }

    const body = await catalog.readSkillBody("deploy-check");
    expect(body).toContain("Confirm migrations before rollout.");
    expect(body).not.toContain("name: deploy-check");

    const resource = await catalog.readSkillResource("deploy-check", "references/checklist.md");
    expect(resource).toBe("- Check WAL mode\n");
  });

  it("blocks path traversal and symlink escapes outside the configured skills root", async () => {
    const outer = createTempDir("der-skills-escape-");
    const root = join(outer, "skills");
    const secretFile = join(outer, "secret.txt");
    const outsideSkillDir = join(outer, "outside-skill");
    mkdirSync(join(root, "safe-skill", "references"), { recursive: true });
    mkdirSync(outsideSkillDir, { recursive: true });

    writeFileSync(secretFile, "TOP_SECRET_CREDENTIAL", "utf8");
    writeFileSync(
      join(outsideSkillDir, "SKILL.md"),
      "---\nname: outside-skill\ndescription: Escaped skill.\n---\nSecret body.",
      "utf8",
    );
    writeFileSync(
      join(root, "safe-skill", "SKILL.md"),
      "---\nname: safe-skill\ndescription: Contained skill.\n---\nSafe body.",
      "utf8",
    );

    symlinkSync(outsideSkillDir, join(root, "linked-outside"), "dir");
    symlinkSync(secretFile, join(root, "safe-skill", "references", "leak.txt"), "file");

    const catalog = createSkillCatalog({ rootDir: root });
    const loaded = await catalog.loadCatalog();

    expect(loaded.skills.map((item) => item.id)).toEqual(["safe-skill"]);
    expect(loaded.rejected.some((issue) => issue.relativePath === "linked-outside")).toBe(true);

    for (const badPath of [
      "../secret.txt",
      "../../secret.txt",
      "/etc/passwd",
      "references\\leak.txt",
      "references/leak.txt",
    ]) {
      let caught: unknown;
      try {
        await catalog.readSkillResource("safe-skill", badPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe("skill.path_outside_root");
    }
  });
});
