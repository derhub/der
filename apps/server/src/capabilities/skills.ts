import * as z from "zod";
import { defineCapability, id, skill } from "@der/domain";
import type { SkillCatalog } from "@der/runtime/context";
import { notFound } from "./scope";

export function skillCapabilities(skills: SkillCatalog) {
  return [
    defineCapability({
      id: "skills.list",
      description: "List the skills available to every bot, with the skill files that were rejected.",
      input: z.strictObject({}),
      output: z.object({
        skills: z.array(skill),
        rejected: z.array(z.object({ relativePath: z.string(), reason: z.string() })),
      }),
      effect: "read",
      approval: "none",
      example: "await der.skills.list({})",
      async execute() {
        const catalog = await skills.loadCatalog();
        return { skills: [...catalog.skills], rejected: [...catalog.rejected] };
      },
    }),
    defineCapability({
      id: "skills.read",
      description: "Read one skill's metadata and markdown body.",
      input: z.strictObject({ skillId: id }),
      output: z.object({ skill, body: z.string() }),
      effect: "read",
      approval: "none",
      example: 'await der.skills.read({ skillId: "ops-brief" })',
      async execute(input) {
        const listed = await skills.listSkills();
        const metadata = listed.find((entry) => entry.id === input.skillId);
        if (!metadata) {
          throw notFound(
            "skill",
            "skill.not_found",
            `Skill "${input.skillId}" does not exist in the catalog.`,
            "skills.read",
          );
        }
        return { skill: metadata, body: await skills.readSkillBody(input.skillId) };
      },
    }),
  ];
}
