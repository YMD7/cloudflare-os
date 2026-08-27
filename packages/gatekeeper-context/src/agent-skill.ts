import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import type { AgentCatalog, SlashCommandDescriptor } from "@gadgets/workshop-shared/gatekeeper";
import type { EnabledCollectionInfo } from "./context-types.js";
import { docIdRoot, encodeDocId } from "./context-types.js";
export {
  isSkillManifestPath, parseSkillManifest, type SkillManifestMetadata,
} from "./skill-manifest.js";

/**
 * How many skills the catalog advertises. Skills are the one item class here that grows without
 * limit (one git-backed collection can import hundreds), so they get their own cap well under
 * AGENT_CATALOG_MAX_ENTRIES. That leaves the shared ceiling as headroom for collections, which are
 * the agent's entry points and must not be dropped. Skills past the cap stay reachable through the
 * session's list()/search().
 */
export const AGENT_SKILL_CATALOG_MAX_ENTRIES = 150;

export type SkillIndexEntry = {
  path: string;
  skillName: string;
  description: string;
};

/** Skills grouped by collection. */
export type CollectionSkills = {
  collection: EnabledCollectionInfo;
  skills: SkillIndexEntry[];
};

/** Build slash command entries for the picker. */
export function buildAgentSkillCommands(
    loaded: CollectionSkills[]): SlashCommandDescriptor[] {
  let commands: SlashCommandDescriptor[] = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      let id = encodeDocId(collection.id, skill.path);
      commands.push({
        id,
        name: skill.skillName,
        description: skill.description,
        resourceLabel: `${collection.title} · ${skill.path}`,
      });
    }
  }
  return commands;
}

/** Build Agent Catalog entries. Their IDs can be passed to ContextLibrary.read(). */
export function buildAgentSkillCatalogEntries(
    loaded: CollectionSkills[]): Array<{id: string, title: string, description: string}> {
  let entries: Array<{id: string, title: string, description: string}> = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      entries.push({
        id: encodeDocId(collection.id, skill.path),
        title: skill.skillName,
        description: `Agent Skill. Read with env[N].read(id) and ` +
          `console.log(document.content). ${skill.description}`,
      });
    }
  }
  return entries.toSorted((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

/**
 * The catalog the library advertises: collections first, then up to
 * AGENT_SKILL_CATALOG_MAX_ENTRIES skills. Collections get the shared 1000-entry ceiling before any
 * skill, so a large skill set cannot displace them. The merged list stays unsorted because the
 * Workshop sorts the survivors; sorting here would only decide alphabetically which entries lose.
 */
export function buildContextCatalog(
    collections: EnabledCollectionInfo[], loaded: CollectionSkills[]): AgentCatalog {
  let collectionEntries = collections
      .map(collection => ({
        id: collection.id,
        title: collection.title,
        description: collection.description,
      }))
      .toSorted((left, right) =>
        left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  let skillEntries = buildAgentSkillCatalogEntries(loaded);
  let catalog = boundAgentCatalog([
    ...collectionEntries,
    ...skillEntries.slice(0, AGENT_SKILL_CATALOG_MAX_ENTRIES),
  ]);
  if (skillEntries.length > AGENT_SKILL_CATALOG_MAX_ENTRIES) catalog.truncated = true;
  return catalog;
}

/**
 * Context builds this complete message. Workshop stores it as normal chat text.
 * $ARGUMENT uses the raw command text. If missing, the text is appended after the skill.
 *
 * The slash-command record is display-only, so this message is the agent's only input: it names the
 * document the skill came from, because otherwise the paths the skill cites resolve to nothing. The
 * name is prose rather than an element attribute since a document path may contain quotes.
 */
export function buildAgentSkillMessage(docId: string, content: string, args: string): string {
  let usesArgument = /\$ARGUMENT(?![A-Za-z0-9_[])/.test(content);
  let expanded = content.replace(/\$ARGUMENT(?![A-Za-z0-9_[])/g, () => args);
  let message = `<agent_skill>\n${expanded}\n</agent_skill>\n\n` +
    `skill root: ${docIdRoot(docId)} — read the documents it references ` +
    `before following it: prefix skill-local paths with this root, shared paths with the ` +
    `collection ID alone. Read by ID.`;
  return !usesArgument && args ? `${message}\n\nARGUMENT: ${args}` : message;
}
