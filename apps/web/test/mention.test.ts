import { describe, expect, it } from "vitest";

import {
  activeMention,
  applyMention,
  extractMentions,
  looksLikeFolder,
  rankCandidates,
} from "../src/mention.js";

describe("activeMention", () => {
  it("finds a mention being typed", () => {
    expect(activeMention("look at @src/ap", 15)).toEqual({ start: 8, query: "src/ap" });
  });

  it("finds an empty mention right after the @", () => {
    expect(activeMention("hello @", 7)).toEqual({ start: 6, query: "" });
  });

  it("is null when there is no @", () => {
    expect(activeMention("no mention here", 10)).toBeNull();
  });

  it("ignores an email address", () => {
    // The @ is mid-word, so it cannot be a mention.
    expect(activeMention("mail me at bob@example", 20)).toBeNull();
  });

  it("treats a scoped package after a space as a mention attempt", () => {
    // `@types/node` is indistinguishable from a file mention, so it opens the
    // picker and simply matches nothing. The alternative — guessing intent from
    // the words before it — would be worse.
    expect(activeMention("npm i @types/node", 17)).toEqual({ start: 6, query: "types/node" });
  });

  it("stops at whitespace, so a finished mention is no longer active", () => {
    expect(activeMention("@src/app.ts and then", 21)).toBeNull();
  });

  it("ignores an @ earlier in a previous line", () => {
    expect(activeMention("@old\nnew text", 14)).toBeNull();
  });

  it("treats an @ after a bracket as a mention", () => {
    expect(activeMention("(@src", 5)).toEqual({ start: 1, query: "src" });
  });
});

describe("applyMention", () => {
  it("replaces the token and puts the caret after it", () => {
    const mention = { start: 8, query: "src/ap" };
    const result = applyMention("look at @src/ap", mention, "src/app.ts", 15);
    expect(result.text).toBe("look at @src/app.ts ");
    expect(result.caret).toBe("look at @src/app.ts ".length);
  });

  it("keeps text that followed the caret", () => {
    const mention = { start: 0, query: "sr" };
    const result = applyMention("@sr and more", mention, "src/app.ts", 3);
    expect(result.text).toBe("@src/app.ts  and more");
  });

  it("inserts a folder mention", () => {
    const result = applyMention("@", { start: 0, query: "" }, "src/", 1);
    expect(result.text).toBe("@src/ ");
  });
});

describe("extractMentions", () => {
  it("finds mentions in a finished message", () => {
    expect(extractMentions("compare @src/app.ts with @package.json")).toEqual([
      "src/app.ts",
      "package.json",
    ]);
  });

  it("de-duplicates", () => {
    expect(extractMentions("@a.ts and @a.ts")).toEqual(["a.ts"]);
  });

  it("finds a folder mention", () => {
    expect(extractMentions("look in @src/ please")).toEqual(["src/"]);
  });

  it("finds a mention at the very start of the message", () => {
    expect(extractMentions("@src/app.ts is broken")).toEqual(["src/app.ts"]);
  });

  it("ignores an email address", () => {
    expect(extractMentions("mail bob@example.com")).toEqual([]);
  });

  it("is empty when nothing is mentioned", () => {
    expect(extractMentions("just a question")).toEqual([]);
  });
});

describe("looksLikeFolder", () => {
  it("is true for a trailing slash", () => {
    expect(looksLikeFolder("src/")).toBe(true);
  });

  it("is false for a file", () => {
    expect(looksLikeFolder("src/app.ts")).toBe(false);
  });
});

describe("rankCandidates", () => {
  const candidates = ["src/app.ts", "src/lib/util.ts", "package.json", "docs/app.md", "app.ts"];

  it("returns the first few when the query is empty", () => {
    expect(rankCandidates(candidates, "")).toHaveLength(5);
  });

  it("prefers a prefix match", () => {
    expect(rankCandidates(candidates, "app")[0]).toBe("app.ts");
  });

  it("prefers a segment match over a mid-word one", () => {
    const ranked = rankCandidates(candidates, "app");
    expect(ranked.indexOf("src/app.ts")).toBeLessThan(ranked.indexOf("docs/app.md"));
  });

  it("excludes non-matches", () => {
    expect(rankCandidates(candidates, "zzz")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(rankCandidates(candidates, "s", 2)).toHaveLength(2);
  });
});
