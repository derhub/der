import { DomainError, type ProblemDetails } from "@der/domain";

export function storageError(input: ProblemDetails): DomainError {
  return new DomainError(input);
}

export function notFoundError(
  code: string,
  title: string,
  detail: string,
  instance: string,
): DomainError {
  return storageError({
    type: `https://der.invalid/problems/${code.replaceAll(".", "-")}`,
    title,
    status: 404,
    detail,
    instance,
    code,
  });
}

export function conflictError(
  code: string,
  title: string,
  detail: string,
  instance: string,
): DomainError {
  return storageError({
    type: `https://der.invalid/problems/${code.replaceAll(".", "-")}`,
    title,
    status: 409,
    detail,
    instance,
    code,
  });
}

export function validationError(
  code: string,
  title: string,
  detail: string,
  instance: string,
): DomainError {
  return storageError({
    type: `https://der.invalid/problems/${code.replaceAll(".", "-")}`,
    title,
    status: 400,
    detail,
    instance,
    code,
  });
}
