# Portable RPG World — version 1

Portable RPG World is a transport-independent format for **authored RPG world content**. It is not a database dump, executable game engine, hosted-service scraper or guarantee that a world is playable. The reference implementation and this specification are MIT licensed. Binary assets have their own rights; this license does not license imported content.

## Container and envelope

A neutral archive is an ordinary ZIP containing UTF-8 `world.json` at its root and optional `assets/<sha256>.<extension>` members. No other files are permitted. Directory markers are tolerated but are subject to the same path and ambiguity checks. Bare neutral JSON is accepted for text-only interchange; missing manifest binaries become omissions, not fabricated media.

```json
{
  "format": "portable-rpg-world",
  "version": 1,
  "world": { "id": "world:beacon", "title": "Beacon", "extensions": {} },
  "entities": [
    {
      "id": "place:quay",
      "kind": "place",
      "name": "Quay",
      "relations": [],
      "extensions": {}
    },
    {
      "id": "person:watch",
      "kind": "person",
      "name": "Watch",
      "relations": [{ "type": "locatedAt", "target": "place:quay" }],
      "extensions": {}
    }
  ],
  "assets": [],
  "omissions": [],
  "extensions": {}
}
```

The JSON Schema is `schema/world-v1.schema.json`, identified by `urn:portable-rpg-world:schema:1`. The `portableGraph: true` schema vocabulary additionally requires the graph, canonical asset-path, safe-URL and rights invariants below. Ordinary JSON Schema validators validate structural constraints only; call the exported `parsePortableWorld` to apply **the same published structural schema plus all portableGraph invariants**. The reference structural validator interprets the published schema rather than maintaining a second field registry. The tests compare the released schema and runtime schema exactly. Content hashes and detected MIME require bytes and are checked by `parseWorldFile` and `encodeWorldArchive`, not JSON-only validation.

Unknown core fields are rejected: put future/vendor fields in extensions. All required arrays and extension objects must exist, including on incomplete worlds. Empty names/titles are valid incomplete authored values. Unsupported neutral versions are rejected, never guessed as another format. The current major version is integer `1`.

## Core entities and identity

Kinds are `place`, `person`, `item`, `group`, `lore`, `objective`, and `event`. Every entity has required `id`, `kind`, `name`, `relations`, `extensions`; optional `description` and `assetIds`. The world has required `id`, `title`, `extensions`, with optional `description` and `assetIds`. `group` can describe geography or factions without implying mechanics; `objective` is a descriptive goal, not an executable quest graph; `event` is an authored beat, not play history.

IDs are opaque strings unique **across the world, entities and assets in one document**. They have 1–1024 characters and no control characters. Never identify entities by fuzzy name matching. Use stable source IDs when available; otherwise use the exact source-map key or record path. A source snapshot with renamed name-keyed records has no promised continuity across those renames. A portable ID is not a foreign key into the importing application's database.

Relations are `{ "type": "locatedAt", "target": "place:quay" }`. Common types are `locatedAt`, `contains`, `connectsTo`, `belongsTo`, `requires`, and `involves`. Unknown nonempty relation types are allowed, including source-specific `cdf:<fileTypeSlug>`, `cdf:file`, and `vvd:<link-kind>`. Targets must identify this document's world or an entity, never an asset or external database row. Adapters retain unresolved original references in source payloads and report an omission; they do not emit dangling live edges. `assetIds` must resolve to manifest IDs and contain no duplicates.

## Namespaced extensions and authored provenance

`extensions` is an object whose keys are lowercase reverse-DNS namespaces. Each value is an arbitrary JSON object with an explicit positive integer `version`. Safe unknown fields, arrays, strings, numeric values, embedded keys and original identities are preserved without interpretation. JSON property order, object prototypes and ZIP layout are not significant.

Source extensions use `sourceFormat`, `sourceIdentity`, `sourcePath`, and `rawData`; optional source descriptors and media bindings associate preserved records with manifested assets. The adapters use these namespaces:

| Source           | Namespace                  |
| ---------------- | -------------------------- |
| AI Dungeon       | `com.aidungeon.storycards` |
| Craft / F&F CDF  | `io.craftrpgs.cdf`         |
| Voyage           | `io.voyage.export`         |
| vvd              | `world.vvd.export`         |
| LegendKeeper     | `com.legendkeeper.export`  |
| Kanka            | `io.kanka.export`          |
| CCv3             | `org.character-card.v3`    |
| World Anvil HTML | `com.worldanvil.html`      |

Native applications can publish a versioned extension in their namespace. Reserved `ai.believein.studio` version 1 uses `{ "version": 1, "sections": {}, "records": [{ "id": "...", "kind": "...", "fields": {} }] }` with portable references and unchanged stat/tile keys. The independent format library treats this payload as inert JSON; it does not import that application's Prisma schema, validate executable mechanics, or invoke database mutations. Unknown native fields remain opaque.

Preserved source evidence is immutable. Editing the core entity name does **not** rewrite `rawData`. A reader should distinguish current mapped values from original source provenance. Uninterpreted data is not lost, but neither is it magically equivalent to the destination's mechanics. Source modules, software packages, sync snapshots, account information, permissions, credentials, tracking and export-run identifiers are not authored content. Adapters exclude recognized private fields recursively and report their source paths. URL userinfo is removed; query/fragment data is stripped with an omission. Prompt text, rich-editor content, HTML/Markdown and safe scripts retained within authored fields are inert strings. Consumers must never execute them, resolve includes, mount imported modules, render raw HTML as trusted markup, or let them control parser behavior. Unknown data should be displayed as escaped text. The library does not assert that generic sanitization replaces a destination's privacy review.

Neutral input is filtered by the same privacy policy on archive-, world-, and entity-level extensions, with exact field-path omissions. `parsePortableWorld` returns the filtered document without mutating the caller; consumers must use its return value. Native `ai.believein.studio` authored minigame `source` strings remain byte-for-byte inert code rather than silently rewriting URL literals and mechanics; private sibling metadata is still stripped. Safe unknown extension data remains unchanged. Revalidating filtered data does not duplicate privacy omissions.

The privacy policy distinguishes source workspace/sync `containerId` metadata from declared native authored references. In `ai.believein.studio.records`, `itemInstance.fields.containerId` and `startEvent.fields.displayData.containerId` for `CONTAINER_REVEAL` retain their string/null portable IDs. This does not exempt nested metadata, unknown record kinds, sibling private fields, or foreign source namespaces from filtering.

## Assets and rights

Each manifest entry requires:

- `id`, `role`, `mediaType`, `sha256` (lowercase 64-hex digest), `byteLength` (positive integer), `path`;
- `rights: { "basis": "creator-owned", "attribution": "optional required attribution" }`;
- optional `sourceUrl`, only if sharing the URL is permitted and it has no userinfo, query or fragment.

Paths must be exactly `assets/<sha256>.<canonical-extension>`, and each path occurs once. Supported content MIME/extensions are PNG/png, JPEG/jpg, WebP/webp, GIF/gif, MPEG audio/mp3, Ogg audio/ogg, WAVE audio/wav, FLAC/flac, MP4/mp4, GLB/glb, self-contained OBJ (`text/plain`)/obj and STL (`model/stl`)/stl. OBJ is recognized by validated geometry records, not arbitrary text MIME; external materials/includes, unresolved references and non-finite coordinates are rejected. ASCII STL uses a complete facet grammar; binary STL has verified count, length and finite coordinates. Geometry is limited to 50,000 facets/elements. SVG, HTML and executable attachments are not bundled. Content signatures/container integrity are inspected; this is not a general-purpose image/video decoder. Neutral bytes must match the declared length, SHA-256 and detected MIME. A mismatch fails parsing, never silently repairs an untrusted manifest.

The reference implementation accepts an explicit nonblank affirmative redistribution statement such as `creator-owned`, `permission`, `public-domain`, `CC0`, or a named license. It rejects sentinel `unknown`, `unverified`, `none`, `restricted`, and `external` bases. A `cc-by` or attribution-based statement requires nonblank attribution. **A statement records the supplier's attestation, not an automated legal determination.** Destination applications must validate their accepted rights policy and ownership. Neutral manifested rights are retained after integrity validation; source converters require separately supplied `mediaRights` before bundling any binary. A hosted URL, source `owned` flag, uploaded file or default avatar does not itself grant redistribution rights. Never fetch remote media from these descriptors.

Source descriptors remain evidence even when incorrectly labelled. For example, a CHARX descriptor naming PNG whose bytes are WebP produces a canonical WebP asset and `SOURCE_MEDIA_TYPE_MISMATCH` omission, retaining the original URI/ext. PNG character-card icons are reconstructed from image/animation chunks without embedded card, private EXIF or text metadata. Inline data-URI binary is represented separately rather than retained inside opaque JSON.

Missing neutral manifest bytes produce `MISSING_MEDIA_BYTES`, remove live asset references/manifest entries, and retain the unavailable manifests under `org.portable-rpg-world.unavailable-assets` version 1. Such a normalized incomplete document can be re-encoded without pretending binaries exist. Encoding requires every live manifest asset and rejects unmanifested supplied bytes.

## Omissions

An omission requires `scopeId`, `sourcePath`, machine-readable `code`, human-readable `message`, and `disposition`; optional `sourceFormat`, `targetKind`. Dispositions are `unmapped`, `unsupported`, `missing`, `external`, `rights-restricted`, `invalid`. A scope may identify unbound original evidence, not necessarily a current mapped entity. Never describe retained opaque data as discarded. Never describe a privacy exclusion as an ordinary mapping gap.

Reference adapter codes include `SOURCE_SCOPE_INCOMPLETE`, `OPAQUE_AUTHORED_CONTENT`, `UNRESOLVED_SOURCE_REFERENCE`, `PRIVATE_SOURCE_DATA_REMOVED`, `PRIVATE_URL_DATA_REMOVED`, `SOURCE_APPLICATION_SOFTWARE_EXCLUDED`, `CDF_SYNC_METADATA_EXCLUDED`, `SOURCE_SUBTREE_SCOPE`, `MISSING_SOURCE_SECTION`, `MISSING_MEDIA_BYTES`, `MEDIA_RIGHTS_REQUIRED`, `EXTERNAL_MEDIA_UNAVAILABLE`, `SOURCE_MEDIA_TYPE_MISMATCH`, `EMBEDDED_MEDIA_DESCRIPTOR`, `HTML_GRAPH_UNAVAILABLE`, `HTML_MEDIA_UNAVAILABLE`, and `EMPTY_OR_UNSTRUCTURED_HTML_EXPORT`. Archive/schema/integrity failures throw `WorldFormatError` with a stable code instead of producing a plausible partial world. Safety failures are not swallowed as ordinary omissions.

## Safety budgets

The reference implementation enforces the following public `WORLD_FILE_LIMITS`:

| Limit                                                   | Value                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Input / encoded ZIP bytes                               | 64 MiB                                                         |
| Cumulative expanded bytes across archive layers         | 256 MiB                                                        |
| Cumulative members across layers, including directories | 12,000                                                         |
| Archive nesting                                         | 2 layers (vvd outer plus inner backup)                         |
| Expanded member / JSON bytes                            | 64 MiB                                                         |
| Per-asset bytes                                         | 32 MiB                                                         |
| JSON nesting                                            | 80                                                             |
| JSON nodes                                              | 2,000,000                                                      |
| Deflate/gzip ratio                                      | at most 1,000×, with 1 MiB allowance for tiny compressed files |

ZIP directory metadata is preflighted before expansion. Streaming fflate decompression checks actual output against each declared size; both outer and inner containers share a cumulative budget. Reject absolute paths, drive prefixes, traversal, backslashes, control characters, percent-encoded path ambiguity, normalized/case-folded duplicates, local/central disagreement, overlaps, symlinks, encryption, split archives, ZIP64, unsupported compression and CRC failure. A JPEG-prefix CHARX polyglot is recognized; arbitrary prefixed software is not. UTF-8 decoding is strict. JSON prototype keys and non-JSON objects/numbers are rejected. No included code runs. Consumers should still treat parsing as untrusted work and isolate CPU/memory according to their service policy.

`fflate ^0.8.2` is the only runtime dependency because its small platform-independent streaming deflate/gzip and ZIP writer work in browsers and servers without Node-only zlib, native code, filesystem access or monorepo imports. The library wraps archive reading with stricter preflight and budgets instead of blindly calling an unbounded ZIP extraction helper.

## Round trips and consumers

A neutral → consumer → neutral round trip should preserve core values, IDs, relation targets, permitted assets, safe extension payloads and omission records. Database IDs may change, portable IDs must not. Preserve foreign extensions durably even if the consumer does not render them. Deleting an entity must not attach its provenance to an unrelated entity; retain explicitly unbound evidence or report its removal. Native graph translators must validate their own authored extension before mutations and retain unsupported native keys separately.

Consumers must distinguish incomplete content from release-ready mechanics; never synthesize a map, quest graph, inventory, stat system, starting scene or game rules merely from prose. Preview local source scope, counts, opaque payloads, missing mechanics and media availability before an explicit upload/confirmation step. Importing into an application should create a new private authored world, not silently merge or overwrite existing work. Authentication and transport are outside this format. ATProto/PDS accounts and private Spaces are not prerequisites.
