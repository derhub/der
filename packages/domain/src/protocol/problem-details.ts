import * as z from "zod";

export const PROBLEM_DETAILS_MEDIA_TYPE = "application/problem+json" as const;

const URI_REFERENCE_PATTERN = /^[^\s\p{Cc}]+$/u;
const PROBLEM_CODE_PATTERN = /^[a-z][a-z0-9._-]*$/;

const uriReference = z
  .string()
  .min(1)
  .regex(
    URI_REFERENCE_PATTERN,
    "value must be a URI reference without whitespace or control characters",
  );

export const problemDetails = z.strictObject({
  type: uriReference,
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1),
  instance: uriReference,
  code: z
    .string()
    .min(1)
    .regex(PROBLEM_CODE_PATTERN, "code must be a lowercase machine-readable identifier"),
});

export type ProblemDetails = z.infer<typeof problemDetails>;

export function createProblemDetails(input: ProblemDetails): ProblemDetails {
  return problemDetails.parse(input);
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly instance: string;

  constructor(input: ProblemDetails) {
    const validated = createProblemDetails(input);
    super(validated.detail);
    this.name = "DomainError";
    this.code = validated.code;
    this.status = validated.status;
    this.type = validated.type;
    this.title = validated.title;
    this.instance = validated.instance;
  }

  toProblemDetails(): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      detail: this.message,
      instance: this.instance,
      code: this.code,
    };
  }
}
