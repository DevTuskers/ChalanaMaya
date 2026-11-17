/** An error with an HTTP status and a stable code; every /api error body is {error: {code, message}}. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = () =>
  new ServiceError(404, "session_not_found", "This board does not exist (or was deleted).");

export const storageFull = (what: string) =>
  new ServiceError(
    507,
    "storage_full",
    `The ChalanaMaya server is full (${what}). Ask its owner to free space.`,
  );
