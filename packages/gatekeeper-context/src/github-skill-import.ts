import {
  MAX_DOCUMENT_BODY_BYTES, contentTypeFromPath, isTextContentType,
  type GitHubSkillImportCandidate, type GitHubSkillImportPreview,
  type GitHubSkillImportRequest,
} from "./context-types.js";
import { extractDescription } from "./description-extractors.js";
import { parseSkillManifest } from "./skill-manifest.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";
const MAX_GITHUB_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;
const MAX_DISCOVERED_MANIFESTS = 20;
const MAX_IMPORTED_FILES = 200;
const MAX_IMPORTED_BYTES = 10 * 1024 * 1024;
const MAX_IMPORTABLE_FILE_BYTES = MAX_DOCUMENT_BODY_BYTES - 16 * 1024;

type Fetcher = typeof fetch;

type ParsedGitHubSource = {
  sourceUrl: string;
  owner: string;
  repository: string;
  ref?: string;
  selectedPath: string;
};

type GitHubTreeBlob = {
  path: string;
  sha: string;
  size: number;
};

type GitHubSnapshot = {
  source: ParsedGitHubSource;
  ref: string;
  revision: string;
  treeSha: string;
  blobs: GitHubTreeBlob[];
};

type LoadedCandidate = GitHubSkillImportCandidate & {
  rootPath: string;
  files: GitHubTreeBlob[];
};

/** One validated document ready for an atomic Context collection import. */
export type GitHubImportedContextDocument = {
  path: string;
  description: string;
  body: string;
  contentType: string;
};

/** GitHub provenance retained inside a Context collection for future update checks. */
export type GitHubSkillImportSourceRecord = {
  schemaVersion: 1;
  skillName: string;
  destinationManifestPath: string;
  sourceUrl: string;
  repositoryUrl: string;
  ref: string;
  revision: string;
  sourceManifestPath: string;
  importedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  let value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return value;
}

function normalizeRepositoryPath(path: string): string {
  let parts = path.split("/").filter(Boolean);
  // eslint-disable-next-line no-control-regex
  if (parts.some(part => part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error("GitHub URL contains an invalid repository path.");
  }
  return parts.join("/");
}

function decodePathSegments(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    throw new Error("GitHub URL contains invalid path encoding.");
  }
}

/** Parse the public GitHub repository, directory, or SKILL.md URLs accepted by the importer. */
export function parseGitHubSkillSource(sourceUrl: string): ParsedGitHubSource {
  let url: URL;
  try {
    url = new URL(sourceUrl.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL.");
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
      url.username || url.password) {
    throw new Error("Only public https://github.com URLs are supported.");
  }

  let segments = decodePathSegments(url.pathname);
  if (segments.length < 2) throw new Error("GitHub URL must identify a repository.");
  let [owner, rawRepository, kind, ref, ...rest] = segments;
  let repository = rawRepository.replace(/\.git$/, "");
  let repositoryPart = /^[A-Za-z0-9_.-]+$/;
  if (!repositoryPart.test(owner) || !repositoryPart.test(repository)) {
    throw new Error("GitHub repository owner or name is invalid.");
  }

  let selectedPath = "";
  if (kind !== undefined) {
    if ((kind !== "tree" && kind !== "blob") || !ref) {
      throw new Error("Use a GitHub repository, directory, or SKILL.md URL.");
    }
    selectedPath = normalizeRepositoryPath(rest.join("/"));
    if (kind === "blob") {
      if (selectedPath.split("/").at(-1) !== "SKILL.md") {
        throw new Error("GitHub file URLs must point to SKILL.md.");
      }
      selectedPath = selectedPath.split("/").slice(0, -1).join("/");
    }
  }

  url.hostname = "github.com";
  url.search = "";
  url.hash = "";
  url.pathname = `/${owner}/${repository}` +
    (kind ? `/${kind}/${encodeURIComponent(ref!)}` +
      (rest.length ? `/${rest.map(segment => encodeURIComponent(segment)).join("/")}` : "") : "");

  return {
    sourceUrl: url.toString(), owner, repository, ref,
    selectedPath,
  };
}

function apiUrl(source: ParsedGitHubSource, suffix: string): string {
  return `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(source.owner)}/` +
    `${encodeURIComponent(source.repository)}${suffix}`;
}

function rawUrl(source: ParsedGitHubSource, revision: string, path: string): string {
  return `${GITHUB_RAW_ORIGIN}/${encodeURIComponent(source.owner)}/` +
    `${encodeURIComponent(source.repository)}/${revision}/` +
    path.split("/").map(segment => encodeURIComponent(segment)).join("/");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  let declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`GitHub response is too large (max ${maxBytes} bytes).`);
  }
  if (!response.body) return new Uint8Array();

  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`GitHub response is too large (max ${maxBytes} bytes).`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let result = new Uint8Array(total);
  let offset = 0;
  for (let chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function githubRequestError(response: Response): Error {
  if ((response.status === 403 || response.status === 429) &&
      response.headers.get("x-ratelimit-remaining") === "0") {
    let reset = Number(response.headers.get("x-ratelimit-reset"));
    let suffix = Number.isFinite(reset) ? ` Try again after ${new Date(reset * 1000).toISOString()}.` : "";
    return new Error(`GitHub's public API rate limit was reached.${suffix}`);
  }
  if (response.status === 404) {
    return new Error("GitHub repository or revision was not found. Only public repositories are supported.");
  }
  return new Error(`GitHub request failed (${response.status}).`);
}

async function fetchGitHubBytes(
  fetcher: Fetcher, url: string, maxBytes: number, accept: string,
): Promise<Uint8Array> {
  let response = await fetcher(url, {
    headers: { Accept: accept, "User-Agent": "cloudflare-os-context" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw githubRequestError(response);
  }
  return readBoundedBody(response, maxBytes);
}

async function fetchGitHubJson(
  fetcher: Fetcher, url: string, maxBytes: number = MAX_GITHUB_JSON_BYTES,
): Promise<unknown> {
  let bytes = await fetchGitHubBytes(fetcher, url, maxBytes, "application/vnd.github+json");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("GitHub returned invalid JSON.");
  }
}

async function resolveSnapshot(
  sourceUrl: string, expectedRevision: string | undefined, fetcher: Fetcher,
): Promise<GitHubSnapshot> {
  let source = parseGitHubSkillSource(sourceUrl);
  let ref = source.ref;
  if (!ref) {
    let repoJson = await fetchGitHubJson(fetcher, apiUrl(source, ""), 1024 * 1024);
    if (!isRecord(repoJson)) throw new Error("GitHub returned invalid repository metadata.");
    ref = requiredString(repoJson, "default_branch", "default branch");
  }

  if (expectedRevision !== undefined && !/^[0-9a-f]{40}$/i.test(expectedRevision)) {
    throw new Error("GitHub preview revision is invalid. Inspect the URL again.");
  }
  let commitJson = await fetchGitHubJson(
    fetcher, apiUrl(source, `/commits/${encodeURIComponent(ref)}`), 1024 * 1024,
  );
  if (!isRecord(commitJson)) throw new Error("GitHub returned invalid commit metadata.");
  let revision = requiredString(commitJson, "sha", "commit revision");
  let commit = commitJson.commit;
  if (!isRecord(commit) || !isRecord(commit.tree)) {
    throw new Error("GitHub returned invalid commit tree metadata.");
  }
  let treeSha = requiredString(commit.tree, "sha", "tree revision");
  if (expectedRevision !== undefined && revision.toLowerCase() !== expectedRevision.toLowerCase()) {
    throw new Error("The GitHub source changed after preview. Inspect it again before importing.");
  }

  let treeJson = await fetchGitHubJson(
    fetcher, apiUrl(source, `/git/trees/${encodeURIComponent(treeSha)}?recursive=1`),
  );
  if (!isRecord(treeJson) || !Array.isArray(treeJson.tree)) {
    throw new Error("GitHub returned an invalid repository tree.");
  }
  if (treeJson.truncated === true) {
    throw new Error("GitHub repository tree is too large to inspect safely.");
  }

  let blobs: GitHubTreeBlob[] = [];
  for (let value of treeJson.tree) {
    if (!isRecord(value) || value.type !== "blob") continue;
    let path = requiredString(value, "path", "file path");
    let sha = requiredString(value, "sha", "file revision");
    let size = value.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("GitHub returned an invalid file size.");
    }
    normalizeRepositoryPath(path);
    blobs.push({ path, sha, size });
  }

  return { source, ref, revision, treeSha, blobs };
}

function isWithinPath(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

function relativeTo(path: string, root: string): string {
  return root === "" ? path : path.slice(root.length + 1);
}

function dirName(path: string): string {
  let slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

async function loadCandidates(snapshot: GitHubSnapshot, fetcher: Fetcher): Promise<{
  candidates: LoadedCandidate[];
  invalidManifests: GitHubSkillImportPreview["invalidManifests"];
}> {
  let manifests = snapshot.blobs.filter(blob =>
    isWithinPath(blob.path, snapshot.source.selectedPath) && blob.path.split("/").at(-1) === "SKILL.md");
  if (manifests.length === 0) {
    throw new Error("No SKILL.md files were found under this GitHub path.");
  }
  if (manifests.length > MAX_DISCOVERED_MANIFESTS) {
    throw new Error(
      `This path contains more than ${MAX_DISCOVERED_MANIFESTS} skills. Use a narrower GitHub directory URL.`,
    );
  }

  let roots = manifests.map(manifest => dirName(manifest.path));
  let loaded = await Promise.all(manifests.map(async (manifest, index) => {
    if (manifest.size > MAX_SKILL_MANIFEST_BYTES) {
      return { manifest, error: `SKILL.md is too large (max ${MAX_SKILL_MANIFEST_BYTES} bytes).` };
    }
    try {
      let bytes = await fetchGitHubBytes(
        fetcher, rawUrl(snapshot.source, snapshot.revision, manifest.path),
        MAX_SKILL_MANIFEST_BYTES, "text/plain",
      );
      if (bytes.byteLength !== manifest.size) {
        throw new Error("GitHub file size changed unexpectedly.");
      }
      let metadata = parseSkillManifest(manifest.path, new TextDecoder().decode(bytes));
      let rootPath = roots[index];
      let nestedRoots = roots.filter((root, otherIndex) =>
        otherIndex !== index && root !== "" && isWithinPath(root, rootPath));
      let files = snapshot.blobs.filter(blob =>
        isWithinPath(blob.path, rootPath) &&
        !nestedRoots.some(nestedRoot => isWithinPath(blob.path, nestedRoot)));
      return {
        manifest,
        candidate: {
          manifestPath: manifest.path,
          name: metadata.name,
          description: metadata.description,
          fileCount: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          rootPath,
          files,
        } satisfies LoadedCandidate,
      };
    } catch (error) {
      return {
        manifest,
        error: error instanceof Error ? error.message.slice(0, 500) : "SKILL.md is invalid.",
      };
    }
  }));

  return {
    candidates: loaded.flatMap(item => item.candidate ? [item.candidate] : []),
    invalidManifests: loaded.flatMap(item => item.error ? [{
      path: item.manifest.path,
      error: item.error,
    }] : []),
  };
}

function pluginComponents(snapshot: GitHubSnapshot, candidates: LoadedCandidate[]): string[] {
  let components = new Set<string>();
  for (let blob of snapshot.blobs) {
    if (!isWithinPath(blob.path, snapshot.source.selectedPath)) continue;
    if (candidates.some(candidate => isWithinPath(blob.path, candidate.rootPath))) continue;
    let relative = relativeTo(blob.path, snapshot.source.selectedPath);
    let segments = relative.split("/");
    if (segments.includes(".claude-plugin")) components.add("Claude plugin manifest");
    if (segments.includes("commands")) components.add("Claude commands");
    if (segments.includes("agents")) components.add("Claude agents");
    if (segments.includes("hooks")) components.add("Claude hooks");
    if (segments.at(-1) === ".mcp.json") components.add("Claude MCP configuration");
  }
  return [...components].toSorted();
}

function licenseUrl(snapshot: GitHubSnapshot): string | undefined {
  let license = snapshot.blobs.find(blob =>
    !blob.path.includes("/") && /^(?:LICENSE|LICENCE|COPYING)(?:\..+)?$/i.test(blob.path));
  if (!license) return undefined;
  return `https://github.com/${encodeURIComponent(snapshot.source.owner)}/` +
    `${encodeURIComponent(snapshot.source.repository)}/blob/${snapshot.revision}/` +
    encodeURIComponent(license.path);
}

function previewFrom(
  snapshot: GitHubSnapshot,
  loaded: Awaited<ReturnType<typeof loadCandidates>>,
): GitHubSkillImportPreview {
  return {
    sourceUrl: snapshot.source.sourceUrl,
    repositoryUrl: `https://github.com/${encodeURIComponent(snapshot.source.owner)}/` +
      encodeURIComponent(snapshot.source.repository),
    ref: snapshot.ref,
    revision: snapshot.revision,
    selectedPath: snapshot.source.selectedPath,
    licenseUrl: licenseUrl(snapshot),
    skills: loaded.candidates.map(({ rootPath: _rootPath, files: _files, ...candidate }) => candidate),
    invalidManifests: loaded.invalidManifests,
    unsupportedPluginComponents: pluginComponents(snapshot, loaded.candidates),
  };
}

/** Inspect a public GitHub URL and return valid skills without modifying Context storage. */
export async function previewGitHubSkillImport(
  sourceUrl: string, fetcher: Fetcher = fetch,
): Promise<GitHubSkillImportPreview> {
  let snapshot = await resolveSnapshot(sourceUrl, undefined, fetcher);
  return previewFrom(snapshot, await loadCandidates(snapshot, fetcher));
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(result);
}

/** Download selected skills from the exact revision shown in a preview. */
export async function prepareGitHubSkillImport(
  request: GitHubSkillImportRequest, fetcher: Fetcher = fetch,
): Promise<{
  preview: GitHubSkillImportPreview;
  importedSkills: string[];
  documents: GitHubImportedContextDocument[];
  sources: GitHubSkillImportSourceRecord[];
}> {
  if (request.manifestPaths.length === 0) throw new Error("Select at least one skill to import.");
  if (request.manifestPaths.length > MAX_DISCOVERED_MANIFESTS) {
    throw new Error(`Import at most ${MAX_DISCOVERED_MANIFESTS} skills at once.`);
  }
  let selectedPaths = new Set(request.manifestPaths);
  if (selectedPaths.size !== request.manifestPaths.length) {
    throw new Error("Selected skill paths must be unique.");
  }

  let snapshot = await resolveSnapshot(request.sourceUrl, request.expectedRevision, fetcher);
  let loaded = await loadCandidates(snapshot, fetcher);
  let preview = previewFrom(snapshot, loaded);
  let byPath = new Map(loaded.candidates.map(candidate => [candidate.manifestPath, candidate]));
  let selected = request.manifestPaths.map(path => {
    let candidate = byPath.get(path);
    if (!candidate) throw new Error(`Selected skill is no longer available: ${path}`);
    return candidate;
  });
  let names = new Set(selected.map(candidate => candidate.name));
  if (names.size !== selected.length) {
    throw new Error("Selected skills must have unique names.");
  }

  let fileCount = selected.reduce((sum, candidate) => sum + candidate.fileCount, 0);
  let totalBytes = selected.reduce((sum, candidate) => sum + candidate.totalBytes, 0);
  if (fileCount > MAX_IMPORTED_FILES) {
    throw new Error(`Selected skills contain too many files (max ${MAX_IMPORTED_FILES}).`);
  }
  if (totalBytes > MAX_IMPORTED_BYTES) {
    throw new Error(`Selected skills are too large (max ${MAX_IMPORTED_BYTES} bytes).`);
  }
  for (let candidate of selected) {
    let oversized = candidate.files.find(file => file.size > MAX_IMPORTABLE_FILE_BYTES);
    if (oversized) {
      throw new Error(`Skill file is too large to import: ${oversized.path}`);
    }
  }

  let documents: GitHubImportedContextDocument[] = [];
  for (let candidate of selected) {
    for (let file of candidate.files) {
      let bytes = await fetchGitHubBytes(
        fetcher, rawUrl(snapshot.source, snapshot.revision, file.path),
        MAX_IMPORTABLE_FILE_BYTES, "application/octet-stream",
      );
      if (bytes.byteLength !== file.size) {
        throw new Error(`GitHub file size changed unexpectedly: ${file.path}`);
      }
      let relativePath = relativeTo(file.path, candidate.rootPath);
      let contentType = contentTypeFromPath(relativePath);
      let text = isTextContentType(contentType) ? new TextDecoder().decode(bytes) : undefined;
      documents.push({
        path: `${candidate.name}/${relativePath}`,
        description: text === undefined ? "" : extractDescription(contentType, text) ?? "",
        body: text ?? bytesToBase64(bytes),
        contentType,
      });
    }
  }

  let importedAt = new Date().toISOString();
  let sources = selected.map(candidate => ({
    schemaVersion: 1 as const,
    skillName: candidate.name,
    destinationManifestPath: `${candidate.name}/SKILL.md`,
    sourceUrl: preview.sourceUrl,
    repositoryUrl: preview.repositoryUrl,
    ref: preview.ref,
    revision: preview.revision,
    sourceManifestPath: candidate.manifestPath,
    importedAt,
  }));
  return {
    preview,
    importedSkills: selected.map(candidate => candidate.name),
    documents,
    sources,
  };
}
