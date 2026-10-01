import { LexError } from "@atproto/lex-data";

export class WatchInvalidatedError extends Error {
  constructor() {
    super("Board subscription was invalidated");
    this.name = "WatchInvalidatedError";
  }
}

export function isSpaceDeletedError(error: unknown): boolean {
  return error instanceof LexError && error.error === "SpaceDeleted";
}

export function isCredentialRejectedError(error: unknown): boolean {
  return (
    error instanceof LexError &&
    (error.error === "CredentialRevoked" || error.error === "JwtExpired")
  );
}

export function isSpaceNotFoundError(error: unknown): boolean {
  return error instanceof LexError && error.error === "SpaceNotFound";
}

export function isSpaceAccessDeniedError(error: unknown): boolean {
  return (
    error instanceof LexError &&
    (error.error === "UserNotAuthorized" || error.error === "NotAuthorized")
  );
}

export function isBoardAbsentError(error: unknown): boolean {
  return (
    error instanceof WatchInvalidatedError ||
    isSpaceDeletedError(error) ||
    isSpaceNotFoundError(error)
  );
}
