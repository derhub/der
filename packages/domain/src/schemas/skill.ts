import * as z from "zod";

export const skillFrontmatter = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
});
export type SkillFrontmatter = z.infer<typeof skillFrontmatter>;

export const skill = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  relativePath: z.string().min(1),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
});
export type Skill = z.infer<typeof skill>;
