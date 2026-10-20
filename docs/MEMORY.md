# Optional memory provider

Luma works without an external memory service. The public release contains ordinary local conversations, scoped context assembly and saved memory interfaces, but no external memory product, model download, account, database, private index or original user's memory implementation.

To attach your own memory library, set `LUMA_MEMORY_PLUGIN` to an absolute, trusted local CommonJS module path before starting the host. The host loads it once. A model response, mobile request or imported document cannot select a different module.

```js
// /absolute/path/my-memory.cjs — owner-provided trusted code
module.exports.createMemoryProvider = async ({store, userData}) => ({
  async start() {},
  async prepare(params) {
    // Query only the data authorized for this agent and conversation.
    // Return existing authorized source IDs or bounded notes with provenance.
    return {memoryIds: [], messageIds: [], notes: [], diagnostics: []};
  },
  async delivered(params, receipt) {},
  async continuity(params) { return []; },
  async stop() {}
});
```

`prepare` is the required method. `start`, `stop`, `delivered` and `continuity` are optional lifecycle hooks. Optional `gardenCatalog`, `gardenDetail` and `gardenRelated` methods support the memory viewer; if absent, the UI must report that the provider is not configured rather than fabricate records.

The adapter receives current turn parameters, including agent/conversation identity and exclusion/cutoff information. Use `memoryManager.cjs`'s authorization helpers to constrain recall. Cross-member private chats are not public context. Deleted/tombstoned sources must not be recalled; stale or unverified sources must not become authorization instructions.

Validate your provider's actual notes/source contract against the `externalMemoryContext` branch in `memoryManager.cjs`; the minimal example intentionally returns no invented memory. A startup/recall failure degrades to ordinary local context. Do not claim semantic retrieval succeeded just because a plugin loaded.

The plugin is trusted host code. It must manage its own credentials, storage, synchronization and backups. Do not make it a second writer to Luma's main JSON file. Use the authority's serialized mutation interface if a feature truly needs to save to Luma, and verify preservation under concurrent saves.
