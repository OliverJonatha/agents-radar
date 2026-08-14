import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRecentDiscussions } from "../github.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface NodeOverrides {
  number?: number;
  updatedAt?: string;
  upvoteCount?: number;
  comments?: number;
  category?: { name: string } | null;
  author?: { login: string } | null;
  answer?: { id: string } | null;
  body?: string | null;
}

function makeNode(o: NodeOverrides = {}) {
  return {
    number: o.number ?? 1,
    title: "Discussion title",
    body: o.body === undefined ? "Discussion body" : o.body,
    createdAt: "2026-03-09T00:00:00Z",
    updatedAt: o.updatedAt ?? "2026-03-09T12:00:00Z",
    upvoteCount: o.upvoteCount ?? 3,
    url: `https://github.com/org/repo/discussions/${o.number ?? 1}`,
    answer: o.answer === undefined ? null : o.answer,
    category: o.category === undefined ? { name: "Ideas" } : o.category,
    author: o.author === undefined ? { login: "alice" } : o.author,
    comments: { totalCount: o.comments ?? 5 },
  };
}

function mockGraphql(pages: { nodes: unknown[]; hasNextPage?: boolean; endCursor?: string | null }[]) {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    const page = pages[Math.min(call, pages.length - 1)];
    call++;
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            repository: {
              discussions: {
                pageInfo: {
                  hasNextPage: page?.hasNextPage ?? false,
                  endCursor: page?.endCursor ?? null,
                },
                nodes: page?.nodes ?? [],
              },
            },
          },
        }),
    } as Response);
  });
}

const SINCE = new Date("2026-03-09T00:00:00Z");

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fetchRecentDiscussions
// ---------------------------------------------------------------------------

describe("fetchRecentDiscussions", () => {
  it("maps GraphQL nodes to GitHubDiscussion", async () => {
    mockGraphql([{ nodes: [makeNode()] }]);
    const result = await fetchRecentDiscussions("org/repo", SINCE);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      number: 1,
      title: "Discussion title",
      category: "Ideas",
      author: "alice",
      comments: 5,
      upvotes: 3,
      answered: false,
      html_url: "https://github.com/org/repo/discussions/1",
    });
  });

  it("marks threads with an accepted answer", async () => {
    mockGraphql([{ nodes: [makeNode({ answer: { id: "a1" } })] }]);
    const result = await fetchRecentDiscussions("org/repo", SINCE);
    expect(result[0]?.answered).toBe(true);
  });

  it("falls back for missing category and deleted authors", async () => {
    mockGraphql([{ nodes: [makeNode({ category: null, author: null })] }]);
    const result = await fetchRecentDiscussions("org/repo", SINCE);
    expect(result[0]?.category).toBe("General");
    expect(result[0]?.author).toBe("ghost");
  });

  it("drops nodes older than since", async () => {
    mockGraphql([
      {
        nodes: [
          makeNode({ number: 1, updatedAt: "2026-03-09T12:00:00Z" }),
          makeNode({ number: 2, updatedAt: "2026-03-01T00:00:00Z" }),
        ],
      },
    ]);
    const result = await fetchRecentDiscussions("org/repo", SINCE);
    expect(result.map((d) => d.number)).toEqual([1]);
  });

  it("stops paginating once a page ends before since", async () => {
    const spy = mockGraphql([
      {
        nodes: [makeNode({ number: 1 }), makeNode({ number: 2, updatedAt: "2026-03-01T00:00:00Z" })],
        hasNextPage: true,
        endCursor: "cursor1",
      },
      { nodes: [makeNode({ number: 3 })] },
    ]);
    const result = await fetchRecentDiscussions("org/repo", SINCE);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.map((d) => d.number)).toEqual([1]);
  });

  it("follows the cursor while pages stay within the window", async () => {
    const spy = mockGraphql([
      { nodes: [makeNode({ number: 1 })], hasNextPage: true, endCursor: "cursor1" },
      { nodes: [makeNode({ number: 2 })], hasNextPage: false },
    ]);
    const result = await fetchRecentDiscussions("org/repo", SINCE);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.map((d) => d.number)).toEqual([1, 2]);
    const secondBody = JSON.parse(String(spy.mock.calls[1]?.[1]?.body)) as { variables: { after: string } };
    expect(secondBody.variables.after).toBe("cursor1");
  });

  it("throws on GraphQL errors returned with HTTP 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ errors: [{ message: "Discussions disabled" }] }),
    } as Response);

    await expect(fetchRecentDiscussions("org/repo", SINCE)).rejects.toThrow("Discussions disabled");
  });

  it("throws on a non-OK HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Bad credentials"),
    } as Response);

    await expect(fetchRecentDiscussions("org/repo", SINCE)).rejects.toThrow("401");
  });

  it("rejects a malformed repo slug", async () => {
    await expect(fetchRecentDiscussions("not-a-slug", SINCE)).rejects.toThrow("Invalid repo slug");
  });
});
