export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(message: string): never {
  throw new ApiError(404, "NOT_FOUND", message);
}

export function conflict(message: string): never {
  throw new ApiError(409, "CONFLICT", message);
}

