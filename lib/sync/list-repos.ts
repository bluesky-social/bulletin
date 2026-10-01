import type { com } from "../lexicons";

type Repo = com.atproto.space.listRepos.Repo;
type Page = { repos: Repo[]; cursor?: string };

/** Visit latest writer states through the terminating empty page. */
export async function walkSpaceRepos(
  list: (cursor?: string) => Promise<Page>,
  visit: (repo: Repo) => Promise<void>,
  cursor?: string,
): Promise<{ cursor?: string; dids: Set<string> }> {
  const dids = new Set<string>();
  while (true) {
    const page = await list(cursor);
    // Empty responses omit cursor; retain the last safely processed revision.
    if (page.repos.length === 0) return { cursor, dids };
    const last = page.repos.at(-1)!;
    if (page.cursor !== last.spaceRev) {
      throw new Error("Invalid listRepos checkpoint");
    }
    for (const repo of page.repos) {
      if (cursor && repo.spaceRev <= cursor) {
        throw new Error("Unordered listRepos response");
      }
      // A writer may reappear on another page. Its newest state still needs work.
      await visit(repo);
      dids.add(repo.did);
      cursor = repo.spaceRev;
    }
  }
}
