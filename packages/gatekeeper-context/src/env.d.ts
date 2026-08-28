// Project-specific Env/ctx.exports augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // Public-collections snapshot KV.
    CONTEXT_COLLECTIONS: KVNamespace;
    // Authenticates public GitHub API reads used by the skill importer.
    GITHUB_PUBLIC_API_TOKEN: string;
    // Optional Git-compatible backing repos for artifact-backed context collections.
    ARTIFACTS?: Artifacts;
  }

  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./index.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces:
      | "ContextCollectionDurableObject"
      | "UserLibraryDurableObject"
      | "LibraryRegistryDurableObject"
      | "ContextGatekeeper";
  }
}
