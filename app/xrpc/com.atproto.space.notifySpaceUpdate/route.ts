import { forwardToSync } from "@/lib/sync/forward";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return forwardToSync(request, "/xrpc/com.atproto.space.notifySpaceUpdate");
}
