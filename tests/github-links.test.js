import assert from "node:assert/strict";
import test from "node:test";

import {
  githubReferenceSegments,
  MAX_RELATED_GITHUB_LINKS,
  normalizeGitHubRepository,
  referenceSegments,
  taskGitHubProjection,
} from "../src/dashboard/github-links.js";

function links(segments) {
  return segments.filter(({ kind }) => kind === "link");
}

test("normalizes advertised GitHub repositories and rejects non-repository URLs", () => {
  assert.equal(normalizeGitHubRepository("https://github.com/Owner/Repo.git/"), "owner/repo");
  assert.equal(normalizeGitHubRepository("https://www.github.com/Owner/Repo"), "owner/repo");
  assert.equal(normalizeGitHubRepository("owner/repo"), "owner/repo");
  assert.equal(normalizeGitHubRepository("https://example.com/owner/repo"), null);
  assert.equal(normalizeGitHubRepository("https://github.com/owner/repo/issues"), null);
  assert.equal(normalizeGitHubRepository("https://github.com/owner/.."), null);
});

test("rejects dot-segment repositories without contaminating task context", () => {
  for (const instruction of [
    "Ignore acme/..#12 and leave #13 ambiguous.",
    "Ignore https://github.com/acme/../issues/12 and leave #13 ambiguous.",
  ]) {
    const segments = githubReferenceSegments(instruction);
    assert.equal(links(segments).length, 0);
    assert.equal(segments.find(({ kind }) => kind === "ambiguous")?.text, "#13");
    const projection = taskGitHubProjection({
      instruction,
      project: { githubRepos: [] },
      turns: [{ requestSummary: "Follow up on #14.", result: null }],
    });
    assert.equal(projection.relatedGitHubRepository, null);
    assert.deepEqual(projection.relatedGitHubLinks, []);
  }
});

test("bounds high-cardinality task projections and reports truncation", () => {
  const references = Array.from(
    { length: MAX_RELATED_GITHUB_LINKS + 100 },
    (_, index) => `#${index + 1}`,
  ).join(" ");
  const projection = taskGitHubProjection({
    instruction: references,
    project: { githubRepos: ["https://github.com/acme/app"] },
    turns: [],
  });
  assert.equal(projection.relatedGitHubLinks.length, MAX_RELATED_GITHUB_LINKS);
  assert.equal(projection.relatedGitHubLinks[0].number, "1");
  assert.equal(projection.relatedGitHubLinks.at(-1).number, String(MAX_RELATED_GITHUB_LINKS));
  assert.equal(projection.relatedGitHubLinksTruncated, true);
});

test("retains explicit issue and pull URL types while preserving surrounding punctuation", () => {
  const text = "See (https://www.github.com/Acme/App/Issues/12), then https://github.com/Acme/App/PULL/13.";
  const segments = githubReferenceSegments(text);
  assert.deepEqual(links(segments).map(({ type, url }) => ({ type, url })), [
    { type: "issue", url: "https://github.com/acme/app/issues/12" },
    { type: "pull", url: "https://github.com/acme/app/pull/13" },
  ]);
  assert.deepEqual(links(segments).map(({ label }) => label), [
    "acme/app#12",
    "acme/app#13",
  ]);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
});

test("links canonical repository URLs and uses them as bare-reference context", () => {
  const text = "Work in (https://github.com/Acme/App), then ship #14.";
  const segments = githubReferenceSegments(text, {
    projectRepositories: [
      "https://github.com/acme/app",
      "https://github.com/acme/workspace",
    ],
  });
  assert.deepEqual(links(segments).map(({ type, url }) => ({ type, url })), [
    { type: "repository", url: "https://github.com/acme/app" },
    { type: "generic", url: "https://github.com/acme/app/issues/14" },
  ]);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
});

test("keeps safe repository fragments behind the canonical repository label", () => {
  const text = "Read https://github.com/Acme/App#readme.";
  const segments = referenceSegments(text);
  assert.deepEqual(links(segments).map(({ label, type, url }) => ({ label, type, url })), [{
    label: "acme/app",
    type: "repository",
    url: "https://github.com/acme/app#readme",
  }]);
  const projection = taskGitHubProjection({
    instruction: text,
    project: { githubRepos: [] },
    turns: [],
  });
  assert.equal(projection.relatedGitHubRepository, "acme/app");
  assert.deepEqual(projection.relatedGitHubLinks, []);
});

test("preserves dotted repository names without consuming sentence punctuation", () => {
  const text = "Work in https://github.com/Acme/App.github.io. Then fix #15.";
  const segments = githubReferenceSegments(text);
  assert.deepEqual(links(segments).map(({ url }) => url), [
    "https://github.com/acme/app.github.io",
    "https://github.com/acme/app.github.io/issues/15",
  ]);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);

  const projection = taskGitHubProjection({
    instruction: text,
    project: { githubRepos: [] },
    turns: [],
  });
  assert.equal(projection.relatedGitHubRepository, "acme/app.github.io");
  assert.deepEqual(projection.relatedGitHubLinks.map(({ label }) => label), [
    "acme/app.github.io#15",
  ]);
});

test("projects workspace and child repository links alongside their pull requests", () => {
  const projection = taskGitHubProjection({
    instruction: "Change https://github.com/acme/child.",
    project: {
      githubRepos: [
        "https://github.com/acme/child",
        "https://github.com/acme/workspace",
      ],
    },
    turns: [{
      requestSummary: "Prepare delivery in https://github.com/acme/child.",
      result: {
        summary: "Merged https://github.com/acme/child/pull/12 and https://github.com/acme/workspace/pull/34.",
      },
    }],
  });
  assert.deepEqual(projection.relatedGitHubLinks.map(({ label, type, url }) => ({ label, type, url })), [
    { label: "acme/child#12", type: "pull", url: "https://github.com/acme/child/pull/12" },
    { label: "acme/workspace#34", type: "pull", url: "https://github.com/acme/workspace/pull/34" },
  ]);
});

test("does not link numeric prefixes inside malformed issue-like identifiers", () => {
  for (const text of [
    "Do not link #12abc.",
    "Do not link acme/app#12abc.",
    "Do not link https://github.com/acme/app/issues/12abc.",
  ]) {
    const segments = githubReferenceSegments(text, {
      projectRepositories: ["https://github.com/acme/app"],
    });
    assert.deepEqual(segments, [{ kind: "text", text }]);
  }
});

test("resolves canonical and bare references from one explicit source repository", () => {
  const segments = githubReferenceSegments("Ship Acme/App#21 and close #22.");
  assert.deepEqual(links(segments).map(({ url }) => url), [
    "https://github.com/acme/app/issues/21",
    "https://github.com/acme/app/issues/22",
  ]);
});

test("resolves a bare reference for exactly one advertised project repository", () => {
  const [reference] = links(githubReferenceSegments("Fix #31.", {
    projectRepositories: ["https://github.com/Acme/App"],
  }));
  assert.equal(reference.url, "https://github.com/acme/app/issues/31");
  assert.equal(reference.label, "acme/app#31");
});

test("uses a unique task-wide explicit repository for a later bare turn reference", () => {
  const task = {
    instruction: "Work in acme/app#40.",
    project: {
      githubRepos: ["https://github.com/acme/app", "https://github.com/acme/api"],
    },
    turns: [{ requestSummary: "Follow up on #41.", result: null }],
  };
  const projection = taskGitHubProjection(task);
  assert.equal(projection.relatedGitHubRepository, "acme/app");
  assert.deepEqual(projection.relatedGitHubLinks.map(({ url }) => url), [
    "https://github.com/acme/app/issues/40",
    "https://github.com/acme/app/issues/41",
  ]);
});

test("keeps bare references ambiguous in multi-repository text without unique context", () => {
  const segments = githubReferenceSegments("Investigate #51.", {
    projectRepositories: ["https://github.com/acme/app", "https://github.com/acme/api"],
  });
  const ambiguous = segments.find(({ kind }) => kind === "ambiguous");
  assert.equal(ambiguous.text, "#51");
  assert.match(ambiguous.reason, /repository is ambiguous/);
  assert.equal(links(segments).length, 0);
});

test("a turn with multiple explicit repositories does not guess for its bare reference", () => {
  const segments = githubReferenceSegments("Compare acme/app#60 with acme/api#61 and #62.");
  assert.deepEqual(links(segments).map(({ number }) => number), ["60", "61"]);
  assert.equal(segments.find(({ kind }) => kind === "ambiguous")?.text, "#62");
});

test("task projection deduplicates canonical URLs in first-seen order and adds repository labels", () => {
  const projection = taskGitHubProjection({
    instruction: "Start acme/app#70, acme/api#71, and https://github.com/acme/app/issues/70.",
    project: { githubRepos: [] },
    turns: [{
      requestSummary: "Review https://github.com/acme/api/pull/72.",
      result: { summary: "Closed acme/api#71." },
    }],
  });
  assert.deepEqual(projection.relatedGitHubLinks.map(({ label, url }) => ({ label, url })), [
    { label: "acme/app#70", url: "https://github.com/acme/app/issues/70" },
    { label: "acme/api#71", url: "https://github.com/acme/api/issues/71" },
    { label: "acme/api#72", url: "https://github.com/acme/api/pull/72" },
  ]);
});

test("keeps explicit issue and pull targets in text while deduplicating their task-level label", () => {
  const segments = referenceSegments(
    "Issue https://github.com/Acme/App/issues/12 and pull https://github.com/acme/app/pull/12.",
  );
  assert.deepEqual(links(segments).map(({ label, type, url }) => ({ label, type, url })), [
    { label: "acme/app#12", type: "issue", url: "https://github.com/acme/app/issues/12" },
    { label: "acme/app#12", type: "pull", url: "https://github.com/acme/app/pull/12" },
  ]);
  const projection = taskGitHubProjection({
    instruction: segments.map(({ text }) => text).join(""),
    project: { githubRepos: [] },
    turns: [],
  });
  assert.deepEqual(projection.relatedGitHubLinks.map(({ label, type, url }) => ({ label, type, url })), [{
    label: "acme/app#12",
    type: "issue",
    url: "https://github.com/acme/app/issues/12",
  }]);
});

test("omits repository roots and deduplicates issue-pull aliases in related links", () => {
  const projection = taskGitHubProjection({
    instruction: "Work in https://github.com/favoyang/taskchef via https://github.com/favoyang/taskchef/pull/79 and https://github.com/favoyang/taskchef/issues/79.",
    project: { githubRepos: ["https://github.com/favoyang/taskchef"] },
    turns: [{
      requestSummary: "Follow up in https://github.com/favoyang/taskchef/pull/80.",
    }],
  });
  assert.equal(projection.relatedGitHubRepository, "favoyang/taskchef");
  assert.deepEqual(projection.relatedGitHubLinks.map(({ label, type, url }) => ({ label, type, url })), [
    {
      label: "favoyang/taskchef#79",
      type: "pull",
      url: "https://github.com/favoyang/taskchef/pull/79",
    },
    {
      label: "favoyang/taskchef#80",
      type: "pull",
      url: "https://github.com/favoyang/taskchef/pull/80",
    },
  ]);
});

test("preserves safe GitHub issue and pull URL suffixes behind compact labels", () => {
  const text = "Open https://github.com/acme/app/issues/12?view=1#issuecomment-2 and https://github.com/acme/app/pull/13/files.";
  const segments = referenceSegments(text);
  assert.deepEqual(links(segments).map(({ label, type, url }) => ({ label, type, url })), [
    {
      label: "acme/app#12",
      type: "issue",
      url: "https://github.com/acme/app/issues/12?view=1#issuecomment-2",
    },
    {
      label: "acme/app#13",
      type: "pull",
      url: "https://github.com/acme/app/pull/13/files",
    },
  ]);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
  const projection = taskGitHubProjection({
    instruction: text,
    project: { githubRepos: [] },
    turns: [],
  });
  assert.deepEqual(projection.relatedGitHubLinks.map(({ url }) => url), [
    "https://github.com/acme/app/issues/12?view=1#issuecomment-2",
    "https://github.com/acme/app/pull/13/files",
  ]);
});

test("deduplicates task-level links by visible numeric identity despite target suffixes", () => {
  const projection = taskGitHubProjection({
    instruction: "Compare https://github.com/acme/app/issues/12?view=A with https://github.com/acme/app/issues/12?view=a.",
    project: { githubRepos: [] },
    turns: [],
  });
  assert.deepEqual(projection.relatedGitHubLinks.map(({ url }) => url), [
    "https://github.com/acme/app/issues/12?view=A",
  ]);
});

test("linkifies safe non-GitHub HTTP(S) URLs with deterministic literal labels", () => {
  const text = "Read (https://example.com/docs?q=one), then http://127.0.0.1:3210/path.";
  const segments = referenceSegments(text);
  assert.deepEqual(links(segments).map(({ label, provider, url }) => ({ label, provider, url })), [
    {
      label: "https://example.com/docs?q=one",
      provider: "web",
      url: "https://example.com/docs?q=one",
    },
    {
      label: "http://127.0.0.1:3210/path",
      provider: "web",
      url: "http://127.0.0.1:3210/path",
    },
  ]);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
});

test("keeps numeric fragments on non-GitHub URLs instead of inventing GitHub targets", () => {
  for (const options of [
    {},
    { projectRepositories: ["https://github.com/acme/app"] },
  ]) {
    const text = "See https://example.com/path#12 and https://docs.example.net/acme/app#13.";
    const segments = referenceSegments(text, options);
    assert.deepEqual(links(segments).map(({ label, provider, url }) => ({ label, provider, url })), [
      {
        label: "https://example.com/path#12",
        provider: "web",
        url: "https://example.com/path#12",
      },
      {
        label: "https://docs.example.net/acme/app#13",
        provider: "web",
        url: "https://docs.example.net/acme/app#13",
      },
    ]);
  }
  const projection = taskGitHubProjection({
    instruction: "See https://example.com/path#12.",
    project: { githubRepos: ["https://github.com/acme/app"] },
    turns: [],
  });
  assert.deepEqual(projection.relatedGitHubLinks, []);
});

test("keeps embedded GitHub URLs inside outer non-GitHub URL tokens", () => {
  const text = "Open https://example.com/?next=https://github.com/acme/app/pull/12 then #13.";
  const segments = referenceSegments(text, {
    projectRepositories: [
      "https://github.com/acme/app",
      "https://github.com/acme/api",
    ],
  });
  assert.deepEqual(links(segments).map(({ label, provider, url }) => ({ label, provider, url })), [{
    label: "https://example.com/?next=https://github.com/acme/app/pull/12",
    provider: "web",
    url: "https://example.com/?next=https://github.com/acme/app/pull/12",
  }]);
  assert.equal(segments.find(({ kind }) => kind === "ambiguous")?.text, "#13");
  const projection = taskGitHubProjection({
    instruction: text,
    project: {
      githubRepos: [
        "https://github.com/acme/app",
        "https://github.com/acme/api",
      ],
    },
    turns: [],
  });
  assert.equal(projection.relatedGitHubRepository, null);
  assert.deepEqual(projection.relatedGitHubLinks, []);
});

test("preserves punctuation outside URLs across nested closing delimiters", () => {
  const text = "Read (https://example.com/docs.), [https://example.net/help!], and {https://example.org/guide;}.";
  const segments = referenceSegments(text);
  assert.deepEqual(links(segments).map(({ label }) => label), [
    "https://example.com/docs",
    "https://example.net/help",
    "https://example.org/guide",
  ]);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
});

test("keeps unsafe or unsupported URL-like text inert", () => {
  const text = String.raw`Do not link javascript:alert(1), www.example.com, https://user:secret@example.com/path, https://example.com/a/.%2e/admin, https://example.com/a/%2e./admin, https://example.com/a\..\admin, or https://github.com/acme/../issues/12.`;
  const segments = referenceSegments(text);
  assert.deepEqual(links(segments), []);
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
});

test("XSS-like input remains inert text around narrowly recognized GitHub references", () => {
  const text = '<img src=x onerror=alert(1)> #80 <script>bad()</script>';
  const segments = githubReferenceSegments(text, {
    projectRepositories: ["https://github.com/acme/app"],
  });
  assert.equal(segments.map(({ text: value }) => value).join(""), text);
  assert.equal(links(segments)[0].url, "https://github.com/acme/app/issues/80");
  assert.equal(segments.filter(({ kind }) => kind === "text").some(({ text: value }) => (
    value.includes("<img") && value.includes("<script>")
  )), false);
  assert.match(segments[0].text, /<img/);
  assert.match(segments.at(-1).text, /<script>/);

  const linked = referenceSegments(
    '<img src=x onerror=alert(1)> https://example.com/path <script>bad()</script>',
  );
  assert.equal(links(linked)[0].label, "https://example.com/path");
  assert.equal(linked.some(({ kind, text: value }) => kind === "text" && value.includes("<img")), true);
  assert.equal(linked.some(({ kind, text: value }) => kind === "text" && value.includes("<script>")), true);
});
