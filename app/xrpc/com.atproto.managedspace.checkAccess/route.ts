import { getRelationship } from "@/lib/atproto/follows";
import { isBoardAccessAuthorized } from "@/lib/atproto/board-access";
import { verifyManagingAppRequest } from "@/lib/atproto/service-auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const space = request.nextUrl.searchParams.get("space");
  const repo = request.nextUrl.searchParams.get("repo");
  const authority = space?.match(/^at:\/\/(did:[^/]+)\/space\//)?.[1];
  if (!space || !authority || (repo !== null && !repo.startsWith("did:"))) {
    return NextResponse.json({ error: "InvalidRequest" }, { status: 400 });
  }

  try {
    await verifyManagingAppRequest(
      request.headers.get("authorization"),
      authority,
    );
    // Without a repo the request has no delegation token. Boards are only
    // readable by followers, so anonymous access is always denied.
    if (!repo) return NextResponse.json({ read: false, write: false });
    const relationship = await getRelationship(repo, authority);
    return NextResponse.json({
      read: isBoardAccessAuthorized(relationship, "read"),
      write: isBoardAccessAuthorized(relationship, "write"),
    });
  } catch (error) {
    console.error("managing-app access check failed", error);
    return NextResponse.json({ error: "AuthRequired" }, { status: 401 });
  }
}
