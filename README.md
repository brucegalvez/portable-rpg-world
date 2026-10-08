# Portable RPG World

An independent, MIT-licensed TypeScript format library for user-supplied authored RPG world files. It reads bounded archives, preserves safe source provenance, reports incomplete content, and writes neutral version-1 ZIP archives. It never signs into platforms, scrapes accounts, fetches remote assets, executes source software, or invents missing gameplay mechanics.

The public format is **Portable RPG World**. The library package is `world-format`. Read [SPEC.md](./SPEC.md) and the [neutral JSON Schema](./schema/world-v1.schema.json). This repository can be installed and tested on its own: no Prisma, Next.js, private source samples, company runtime, or monorepo loader is required.

## Install and use

Requires Node **22.18+** for native TypeScript stripping, or a TypeScript-aware browser/server bundler. Source is ESM TypeScript; no build step or `tsx` runtime is required.

```sh
npm install
npm run typecheck
npm test
node bin/portable-rpg-world.ts inspect fixtures/neutral.json
node bin/portable-rpg-world.ts convert fixtures/story-cards.json /tmp/cards.zip
```

After installing the package, the CLI name is `portable-rpg-world`:

```sh
portable-rpg-world inspect my-world.zip
portable-rpg-world convert my-world.zip portable-world.zip --rights '{"basis":"creator-owned"}'
portable-rpg-world character fixtures/neutral.json person:watcher card.json
```

`--rights` applies to source-file binaries. It is a supplier's affirmative redistribution attestation, not automatic proof of copyright. Omit it to retain prose/descriptors and list restricted media without binaries. Attribution-based licenses require attribution. Existing neutral manifest rights are preserved after hash, size and MIME validation. CLI outputs JSON summaries/errors and does not print full private source records. Inputs are never overwritten unless the operator explicitly selects the same output path.

```ts
import {
  parseWorldFile,
  parsePortableWorld,
  encodeWorldArchive,
  exportCharacterCard,
  WORLD_FILE_LIMITS,
} from 'world-format';

const parsed = await parseWorldFile(bytes, 'source.zip');
// Preview parsed.document + omissions locally before any upload.
const portableZip = await encodeWorldArchive(parsed.document, parsed.assets);
const person = parsed.document.entities.find(entity => entity.kind === 'person');
if (person) {
  const card = exportCharacterCard(person, parsed.document);
}
```

Public types include `PortableWorld`, `PortableEntity`, `PortableAsset`, `PortableRelation`, `PortableOmission`, `Extensions`, `AssetRights`, `ParseOptions`, and `ParsedWorld`. `ParsedWorld` is `{ document, assets, sourceFormat }`; asset dictionaries are keyed by canonical manifest **paths**, not IDs. `parseWorldFile(bytes, filename, { mediaRights? })` and `encodeWorldArchive(document, assets?)` return promises. `parsePortableWorld(unknown)` and `exportCharacterCard(entity, world?)` are synchronous. The root entry is browser-safe and does not import Node APIs; only the CLI uses filesystem APIs. Errors are `WorldFormatError` with `.code` and `.message`. Schema validation applies the published structural schema and the `portableGraph` identity/reference/path/rights vocabulary; hashing requires archive bytes.

## Supported files and fidelity

Support is scoped to documented/observed envelopes, not every version or full source re-import. Original behavior fixtures here are synthetic authored examples, **not copied application exports**. Reference converters were designed from privately inspected official exports; no private sample, account data, third-party demo prose or default artwork is published here.

| Input | Recognized scope and preservation | Deliberate limits |
| --- | --- | --- |
| Neutral ZIP / JSON | Exact `portable-rpg-world` / integer `1`; core graph, arbitrary safe versioned namespaces, rights-verified manifested bytes | Foreign major versions rejected; missing bytes explicitly normalized as unavailable evidence |
| AI Dungeon | JSON array of Story Cards: keys, value, title, type and authored extra fields; character/location types map, other types remain lore | Story Cards only, not Scenario/Adventure/session export; no opening, map or rules inferred |
| Friends & Fables / Craft CDF | Exactly one `.craft/project.json` with typed JSON/Markdown; `$craft.referenceId` identity, typed `referenceId` + `fileTypeSlug` and `fileReferenceId` links, schemas/GM prose as inert data | `.craft/base` duplicates and workspace/index/sync excluded; F&F need not contain Craft workspace files; observed JSON and simple YAML frontmatter, unknown safe frontmatter retained but not interpreted as mechanics; modules/MCP software excluded |
| Voyage | Observed `heroesVersion: 36`, exact map keys, regions/realms, locations, NPCs, factions, item types, lore, quests and narrative records; explicit region/currentLocation links and authored configuration retained | No cross-rename immutable identity for name-keyed maps, no movement/rules/stat/quest-graph equivalence inferred; other versions rejected; source mods excluded |
| vvd | Outer ZIP with one `.vvd` ZIP, or direct `.vvd`; world + documents + type definitions, links/hierarchy, tool JSON, supplementary Markdown and supplied media | Both layers budgeted; 13 inspected sparse documents did not establish complete map/canvas/timeline/family-tree fidelity; standard card types map, tool documents stay lore; absent writing-only media reported |
| LegendKeeper | Plain JSON or gzip `.lk`, observed version 1 resource documents and calendars; stable resource IDs, editor content and explicit mentions | Selected subtree is not guaranteed whole project; hosted images not bundled/fetched; editor maps/boards remain opaque rather than playable movement |
| Kanka | Observed JSON export version 3.15 ZIP with `info.json` + `campaign.json`; typed records and generic entity ID domains remain separate; character `entityLocations[].location_id` resolves to location record ID | Authored templates remain incomplete; duplicated trait collections retained once in raw source, not interpreted twice; unsupported categories retained opaquely; no permissions/accounts/plugins copied |
| Character Card V3 | JSON `chara_card_v3` / `3.0`, PNG/APNG `tEXt` `ccv3` base64, CHARX `card.json`, observed JPEG-prefix CHARX; one character, lorebook and inert prompts/application JSON | No full world implied; `embeded://` is the specification spelling; binaries gated; modules excluded; bytes sniffed rather than trusting URI `.png`; broader application variants unverified |
| World Anvil | Recognized official HTML fallback (`print-interface`, `world-title`, World Anvil marker); authored visible text retained, scripts/account display/tracking stripped | The privately inspected export was empty. No article/category graph or links invented. Structured JSON/HTML ZIP is documented but its schema/sample remains unavailable: rejected with a clear error, not claimed supported |

Incomplete sources always receive a `SOURCE_SCOPE_INCOMPLETE` omission. Core mapping does not convert opaque catalogues into a playable destination game. Safe raw authored payloads remain separate from editable mapped fields. Descriptors for unavailable/remote media survive with explicit omissions. Known private fields and URL credential/query data are removed with source-path omissions; source records must still undergo the consumer's security/privacy review.

### Official acquisition / format references

Use files already obtained through an authorized official export flow. Converter availability grants neither platform-access permission nor third-party redistribution rights. Do not provide platform credentials to the converter or importing application.

- [AI Dungeon Story Cards import/export](https://help.aidungeon.com/story-cards-import-and-export)
- [F&F owner export to Craft](https://www.craftrpgs.com/docs/moving-a-world-from-friends-and-fables-to-craft)
- [Craft CDF import/export](https://www.craftrpgs.com/docs/cdf-import-and-export)
- [Voyage release listing](https://voyage.io/releases) — actual version-36 download was observed via Studio → Save options → legacy editor → Download JSON; release pages are not a schema
- [vvd import/export](https://vvd.crisp.help/en/article/import-export-15oat5e/)
- [World Anvil export tutorial](https://www.worldanvil.com/learn/world/export) — HTML fallback and Guild structured ZIP are different routes
- [LegendKeeper export notes](https://www.legendkeeper.com/changelog/legendkeeper-0-16-1-0/)
- [Kanka export docs](https://docs.kanka.io/en/latest/features/campaigns/export.html)
- [CCv3 specification](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)

## Safety and limitations

Public limits: 64 MiB input/encoded archive, 256 MiB cumulative expansion, 12,000 members, two archive layers, 64 MiB per expanded member, 32 MiB per asset, JSON depth 80 and 2,000,000 nodes. ZIP/gzip expansion uses streamed fflate output with declared and actual limits; directory preflight validates paths, duplicates, overlaps, encryption/compression, symlinks and header agreement before extracting. ZIP and PNG CRC, asset SHA-256, size and detected content MIME are checked. No SVG, HTML or executable binary is accepted as a neutral asset. See SPEC for exact rights and custom-schema graph constraints.

Neutral extension privacy filtering applies at document, world and entity scopes and reports exact source paths. Use the document returned by `parsePortableWorld`; it does not mutate the caller. Safe unknown fields survive, and authored native minigame source remains inert and unchanged. Geometry attachments additionally support self-contained OBJ (`text/plain`, `.obj`) and ASCII/binary STL (`model/stl`, `.stl`) with finite coordinates, resolved local references, complete facet/count/length checks and no external material/includes. Model fixtures are original generated triangles, not copied platform media.

Header/container sniffing is not a general media decoder, malware scanner, copyright service or proof of file accessibility. Source prompts/scripts are inert evidence; consumers must never execute them or render unescaped source HTML. No remote request is made by any parser. This library has no database mutation API or destination `gameId` parameter. Native consumers must authenticate, validate their own mechanics and persist provenance transactionally before creating a new private authored world.

## Fixtures, tests and publication

`fixtures/` contains original synthetic source/neutral JSON, with invented nonpersonal identities and no third-party media. Tests synthesize their own one-pixel PNG and archive/gzip/PNG containers in memory. They exercise schema parity, exact unknown extension/ID preservation, relation domains, incomplete sources, media rights, hashes/MIME/length mismatch, PNG/card containers, privacy exclusion, traversal, ambiguous duplicates, CRC, header disagreement, forged expansion and cumulative/nesting limits. `.github/workflows/ci.yml` runs standalone typecheck, tests and CLI/package smoke steps. No tests here depend on local private research inputs.

Publishing this package does not publish any source platform's proprietary application code. CLI conversion is file-only; authenticated capture/export tools and ATProto transport are deliberately out of scope.
