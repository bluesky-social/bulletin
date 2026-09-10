import type { Relationship } from "./follows";

export type BoardAccess = "read" | "write";

export function isBoardAccessAuthorized(
  relationship: Relationship,
  access: BoardAccess,
): boolean {
  return (
    relationship.follows && (access === "read" || relationship.followedBy)
  );
}
