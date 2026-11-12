import { com } from "../lexicons";

type Page = com.atproto.space.listWriters.$OutputBody;

/** The latest state of a repo in the writer set. */
export type Writer =
  | { removed: false; repo: string; repoRev: string; spaceRev: string }
  | { removed: true; repo: string; spaceRev: string };

/**
 * Visit latest writer states through the terminating empty page. `dids` holds
 * the repos still in the writer set, so a full listing leaves out removed ones.
 */
export async function walkSpaceRepos(
  list: (cursor?: string) => Promise<Page>,
  visit: (writer: Writer) => Promise<void>,
  cursor?: string,
): Promise<{ cursor?: string; dids: Set<string> }> {
  const dids = new Set<string>();
  while (true) {
    const page = await list(cursor);
    // Empty responses omit cursor; retain the last safely processed revision.
    if (page.repos.length === 0) return { cursor, dids };
    const writers = page.repos.map(parseWriter);
    if (page.cursor !== writers.at(-1)!.spaceRev) {
      throw new Error("Invalid listWriters checkpoint");
    }
    for (const writer of writers) {
      if (cursor && writer.spaceRev <= cursor) {
        throw new Error("Unordered listWriters response");
      }
      // A writer may reappear on another page. Its newest state still needs work.
      await visit(writer);
      if (writer.removed) dids.delete(writer.repo);
      else dids.add(writer.repo);
      cursor = writer.spaceRev;
    }
  }
}

function parseWriter(entry: Page["repos"][number]): Writer {
  const { repoWrite, repoRemoved } = com.atproto.space.defs;
  if (entry.$type === repoWrite.$type) {
    const { repo, repoRev, spaceRev } = entry as com.atproto.space.defs.RepoWrite;
    return { removed: false, repo, repoRev, spaceRev };
  }
  if (entry.$type === repoRemoved.$type) {
    const { repo, spaceRev } = entry as com.atproto.space.defs.RepoRemoved;
    return { removed: true, repo, spaceRev };
  }
  throw new Error(`Unsupported listWriters entry ${String(entry.$type)}`);
}
