import { describe, expect, it } from "vitest";
import {
  parseGitHubSkillSource, prepareGitHubSkillImport, previewGitHubSkillImport,
} from "../src/github-skill-import.js";

const REVISION = "1111111111111111111111111111111111111111";
const TREE_SHA = "2222222222222222222222222222222222222222";
const SKILL = `---
name: frontend-design
description: Build distinctive frontend interfaces.
---
# Frontend design
`;
const REFERENCE = "# Review\n\nCheck the finished interface.\n";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function githubFixture(options: {
  revision?: string;
  invalidManifest?: boolean;
  onRequest?: (url: URL, init: RequestInit | undefined) => void;
} = {}): typeof fetch {
  let revision = options.revision ?? REVISION;
  let manifestBody = options.invalidManifest ? "# Missing frontmatter" : SKILL;
  return async (input, init) => {
    let url = new URL(typeof input === "string" ? input : input.url);
    options.onRequest?.(url, init);
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/commits/main")) {
      return json({ sha: revision, commit: { tree: { sha: TREE_SHA } } });
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/git/trees/")) {
      return json({
        sha: TREE_SHA,
        truncated: false,
        tree: [
          { path: "LICENSE.md", type: "blob", sha: "a".repeat(40), size: 100 },
          {
            path: "plugins/frontend-design/.claude-plugin/plugin.json",
            type: "blob",
            sha: "b".repeat(40),
            size: 40,
          },
          {
            path: "plugins/frontend-design/commands/example.md",
            type: "blob",
            sha: "c".repeat(40),
            size: 40,
          },
          {
            path: "plugins/frontend-design/skills/frontend-design/SKILL.md",
            type: "blob",
            sha: "d".repeat(40),
            size: manifestBody.length,
          },
          {
            path: "plugins/frontend-design/skills/frontend-design/references/review.md",
            type: "blob",
            sha: "e".repeat(40),
            size: REFERENCE.length,
          },
        ],
      });
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/SKILL.md")) {
      return new Response(manifestBody);
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/references/review.md")) {
      return new Response(REFERENCE);
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
}

describe("parseGitHubSkillSource", () => {
  it("accepts a GitHub plugin directory URL", () => {
    expect(parseGitHubSkillSource(
      "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
    )).toEqual({
      sourceUrl: "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
      owner: "anthropics",
      repository: "claude-code",
      ref: "main",
      selectedPath: "plugins/frontend-design",
    });
  });

  it("rejects non-GitHub and non-SKILL.md file URLs", () => {
    expect(() => parseGitHubSkillSource("https://example.com/org/repo"))
      .toThrow("Only public https://github.com URLs are supported.");
    expect(() => parseGitHubSkillSource("https://github.com/org/repo/blob/main/README.md"))
      .toThrow("GitHub file URLs must point to SKILL.md.");
  });
});

describe("previewGitHubSkillImport", () => {
  it("finds nested skills and reports unsupported plugin components", async () => {
    let preview = await previewGitHubSkillImport(
      "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
      { fetcher: githubFixture() },
    );

    expect(preview.skills).toEqual([{
      manifestPath: "plugins/frontend-design/skills/frontend-design/SKILL.md",
      name: "frontend-design",
      description: "Build distinctive frontend interfaces.",
      fileCount: 2,
      totalBytes: SKILL.length + REFERENCE.length,
    }]);
    expect(preview.unsupportedPluginComponents).toEqual([
      "Claude commands", "Claude plugin manifest",
    ]);
    expect(preview.licenseUrl).toContain(`/blob/${REVISION}/LICENSE.md`);
  });

  it("reports an invalid manifest without treating it as a skill", async () => {
    let preview = await previewGitHubSkillImport(
      "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
      { fetcher: githubFixture({ invalidManifest: true }) },
    );
    expect(preview.skills).toEqual([]);
    expect(preview.invalidManifests[0]).toMatchObject({
      path: "plugins/frontend-design/skills/frontend-design/SKILL.md",
      error: "Skill manifest must start with YAML frontmatter.",
    });
  });

  it("sends authentication only to the GitHub API origin", async () => {
    let requests: { hostname: string; authorization: string | null }[] = [];
    await previewGitHubSkillImport(
      "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
      {
        apiToken: "test-token",
        fetcher: githubFixture({
          onRequest(url, init) {
            requests.push({
              hostname: url.hostname,
              authorization: new Headers(init?.headers).get("Authorization"),
            });
          },
        }),
      },
    );

    expect(requests.filter(request => request.hostname === "api.github.com")
      .every(request => request.authorization === "Bearer test-token")).toBe(true);
    expect(requests.filter(request => request.hostname === "raw.githubusercontent.com")
      .every(request => request.authorization === null)).toBe(true);
  });
});

describe("prepareGitHubSkillImport", () => {
  it("preserves skill-relative files and records internal immutable source metadata", async () => {
    let result = await prepareGitHubSkillImport({
      sourceUrl: "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
      expectedRevision: REVISION,
      manifestPaths: ["plugins/frontend-design/skills/frontend-design/SKILL.md"],
    }, { fetcher: githubFixture() });

    expect(result.importedSkills).toEqual(["frontend-design"]);
    expect(result.documents.map(document => document.path)).toEqual([
      "frontend-design/SKILL.md",
      "frontend-design/references/review.md",
    ]);
    expect(result.sources).toEqual([expect.objectContaining({
      schemaVersion: 1,
      skillName: "frontend-design",
      destinationManifestPath: "frontend-design/SKILL.md",
      revision: REVISION,
      sourceManifestPath: "plugins/frontend-design/skills/frontend-design/SKILL.md",
    })]);
  });

  it("fails closed when the source revision changed after preview", async () => {
    await expect(prepareGitHubSkillImport({
      sourceUrl: "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design",
      expectedRevision: REVISION,
      manifestPaths: ["plugins/frontend-design/skills/frontend-design/SKILL.md"],
    }, { fetcher: githubFixture({ revision: "3".repeat(40) }) })).rejects.toThrow(
      "The GitHub source changed after preview",
    );
  });
});
