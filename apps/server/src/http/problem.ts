import { DomainError, PROBLEM_DETAILS_MEDIA_TYPE, type ProblemDetails } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";

export function problemResponse(details: ProblemDetails): Response {
  const validated = compiledParsers.problemDetails.parse(details);
  return new Response(JSON.stringify(validated), {
    status: validated.status,
    headers: {
      "content-type": PROBLEM_DETAILS_MEDIA_TYPE,
    },
  });
}

export function errorToProblemResponse(error: unknown, instance: string): Response {
  if (error instanceof DomainError) {
    return problemResponse(error.toProblemDetails());
  }

  return problemResponse({
    type: "https://der.invalid/problems/internal-error",
    title: "Internal server error",
    status: 500,
    detail: error instanceof Error ? error.message : "Unexpected server failure.",
    instance,
    code: "server.internal_error",
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function enforceSameOrigin(
  request: Request,
  allowedOrigins: readonly string[],
  instance: string,
): Response | undefined {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const origin = request.headers.get("origin");
  if (origin === null) {
    return undefined;
  }
  if (!allowedOrigins.includes(origin)) {
    return problemResponse({
      type: "https://der.invalid/problems/origin-forbidden",
      title: "Origin not allowed",
      status: 403,
      detail: `Origin "${origin}" is not permitted for mutating requests.`,
      instance,
      code: "http.origin_forbidden",
    });
  }
  return undefined;
}

export async function parseJsonBody(request: Request, instance: string): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim().length === 0) {
    throw new DomainError({
      type: "https://der.invalid/problems/invalid-json",
      title: "Empty JSON body",
      status: 400,
      detail: "Request body must be valid JSON.",
      instance,
      code: "http.invalid_json",
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DomainError({
      type: "https://der.invalid/problems/invalid-json",
      title: "Malformed JSON body",
      status: 400,
      detail: "Request body could not be parsed as JSON.",
      instance,
      code: "http.invalid_json",
    });
  }
}
