import { getRelationship } from "@/lib/atproto/follows";
import { requireSession } from "@/lib/auth/session";
import { boardUri } from "@/lib/config";
import { getReferencedSpaceBlob } from "@/lib/db/queries";
import { isNoteImageMime } from "@/lib/note-constraints";
import { readBlobFile } from "@/lib/blob-store";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  let viewerDid: string;
  try {
    viewerDid = (await requireSession()).did;
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const space = request.nextUrl.searchParams.get("space");
  const repoDid = request.nextUrl.searchParams.get("repo");
  const cid = request.nextUrl.searchParams.get("cid");
  const ownerDid = space?.match(/^at:space\/(did:[^/]+)\//)?.[1];
  if (
    !space ||
    !ownerDid ||
    space !== boardUri(ownerDid) ||
    !repoDid?.startsWith("did:") ||
    !cid
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (viewerDid !== ownerDid) {
    try {
      if (!(await getRelationship(viewerDid, ownerDid)).follows) {
        return new NextResponse("Forbidden", { status: 403 });
      }
    } catch (error) {
      console.error("Could not check image access", error);
      return new NextResponse("Access check unavailable", { status: 503 });
    }
  }

  const blob = await getReferencedSpaceBlob(space, repoDid, cid);
  if (!blob || !isNoteImageMime(blob.mimeType)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const bytes = readBlobFile(cid);
  if (!bytes || bytes.length !== blob.size) {
    return new NextResponse("Not found", { status: 404 });
  }
  const body = new ArrayBuffer(bytes.length);
  new Uint8Array(body).set(bytes);

  return new NextResponse(body, {
    headers: {
      "Content-Type": blob.mimeType,
      "Content-Length": String(blob.size),
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
