import { getRelationship } from "@/lib/atproto/follows";
import { isBoardAccessAuthorized } from "@/lib/atproto/board-access";
import { verifyManagingAppRequest } from "@/lib/atproto/service-auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const space = request.nextUrl.searchParams.get("space");
  const user = request.nextUrl.searchParams.get("user");
  const access = request.nextUrl.searchParams.get("access");
  const authority = space?.match(/^at:\/\/(did:[^/]+)\/space\//)?.[1];
  if (
    !space ||
    !user ||
    !authority ||
    (access !== "read" && access !== "write")
  ) {
    return NextResponse.json({ error: "InvalidRequest" }, { status: 400 });
  }

  try {
    await verifyManagingAppRequest(
      request.headers.get("authorization"),
      authority,
    );
    const relationship = await getRelationship(user, authority);
    return NextResponse.json({
      authorized: isBoardAccessAuthorized(relationship, access),
    });
  } catch (error) {
    console.error("managing-app access check failed", error);
    return NextResponse.json({ error: "AuthRequired" }, { status: 401 });
  }
}
