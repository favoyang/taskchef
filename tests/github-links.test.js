import assert from "node:assert/strict";
import test from "node:test";

import {
  githubReferenceSegments,
  MAX_RELATED_GITHUB_LINKS,
  normalizeGitHubRepository,
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
  assert.equal(projection.relatedGitHubLinks[0].label, "acme/app.github.io");
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
    { label: "acme/child", type: "repository", url: "https://github.com/acme/child" },
    { label: "child PR #12", type: "pull", url: "https://github.com/acme/child/pull/12" },
    { label: "workspace PR #34", type: "pull", url: "https://github.com/acme/workspace/pull/34" },
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
    { label: "app #70", url: "https://github.com/acme/app/issues/70" },
    { label: "api #71", url: "https://github.com/acme/api/issues/71" },
    { label: "api PR #72", url: "https://github.com/acme/api/pull/72" },
  ]);
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
});
