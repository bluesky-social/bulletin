import type { OAuthSession } from "@atproto/oauth-client-node";
import { ScopePermissions } from "@atproto/oauth-scopes";
import { asStringFormat } from "@atproto/lex-schema";
import {
  BOARD_SKEY,
  POST_COLLECTION,
  SPACE_TYPE,
} from "../config";

export type BulletinCapabilities = {
  canCreateBoard: boolean;
  canCreateNote: boolean;
};

export async function getBulletinCapabilities(
  session: OAuthSession,
  ownerDid: string,
): Promise<BulletinCapabilities> {
  const { scope } = await session.getTokenInfo(false);
  return bulletinCapabilitiesFromScope(scope, session.did, ownerDid);
}

export function bulletinCapabilitiesFromScope(
  scope: string,
  viewerDid: string,
  ownerDid: string,
): BulletinCapabilities {
  const permissions = new ScopePermissions(scope);
  const board = (did: string) => ({
    spaceDid: asStringFormat(did, "did"),
    spaceType: asStringFormat(SPACE_TYPE, "nsid"),
    skey: asStringFormat(BOARD_SKEY, "record-key"),
  });
  return {
    canCreateBoard:
      viewerDid === ownerDid &&
      permissions.allowsSpace(board(viewerDid), { manage: "create" }),
    canCreateNote: permissions.allowsSpace(board(ownerDid), {
      collection: asStringFormat(POST_COLLECTION, "nsid"),
      action: "create",
    }),
  };
}
