import { sniffMedia } from "./media.ts";
import {
  filterSourceData,
  PRIVATE_SOURCE_KEY as privateKeys,
} from "./privacy.ts";
import {
  insist,
  json,
  sha256,
  utf8,
  WORLD_FILE_LIMITS,
  WorldFormatError,
} from "./safety.ts";
import {
  MEDIA_EXTENSIONS,
  parsePortableWorld,
  validateAssetRights,
} from "./schema.ts";
import type {
  AssetRights,
  EntityKind,
  Extensions,
  JsonValue,
  ParsedWorld,
  PortableEntity,
  PortableOmission,
  PortableWorld,
} from "./types.ts";

type Obj = Record<string, unknown>;
export function object(value: unknown): Obj {
  insist(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_SOURCE",
    "Expected source object.",
  );
  return value as Obj;
}
const sourceNamespaces: Record<string, string> = {
  "ai-dungeon": "com.aidungeon.storycards",
  cdf: "io.craftrpgs.cdf",
  voyage: "io.voyage.export",
  vvd: "world.vvd.export",
  legendkeeper: "com.legendkeeper.export",
  kanka: "io.kanka.export",
  ccv3: "org.character-card.v3",
  "world-anvil-html": "com.worldanvil.html",
};
const scriptFiles =
  /(?:^|\/)(?:AGENTS|CLAUDE|README)\.md$|\.(?:js|mjs|cjs|ts|tsx|jsx|py|sh|exe|dll|wasm|risum)$/i;
export class Conversion {
  readonly document: PortableWorld;
  readonly assets: Record<string, Uint8Array> = Object.create(null);
  readonly namespace: string;
  readonly format: string;
  constructor(format: string, title: string, worldIdentity = "snapshot") {
    this.format = format;
    this.namespace = sourceNamespaces[format]!;
    this.document = {
      format: "portable-rpg-world",
      version: 1,
      world: {
        id: `${format}:world:${encodeURIComponent(worldIdentity)}`,
        title,
        extensions: {},
      },
      entities: [],
      assets: [],
      omissions: [],
      extensions: {},
    };
    const safeTitle = this.clean(title, this.document.world.id, "/title");
    this.document.world.title = typeof safeTitle === "string" ? safeTitle : "";
  }
  omit(
    scopeId: string,
    sourcePath: string,
    code: string,
    message: string,
    disposition: PortableOmission["disposition"],
  ): void {
    this.document.omissions.push({
      scopeId,
      sourcePath,
      code,
      message,
      disposition,
      sourceFormat: this.format,
    });
  }
  clean(value: unknown, scope: string, path: string): JsonValue {
    return filterSourceData(
      value as JsonValue,
      path,
      (sourcePath, code, message) =>
        this.omit(
          scope,
          sourcePath,
          code,
          message,
          code === "EMBEDDED_MEDIA_DESCRIPTOR" ? "unmapped" : "unsupported",
        ),
    );
  }
  retain(
    target: { extensions: Extensions; id: string },
    raw: unknown,
    identity: string,
    path: string,
    extra: Record<string, JsonValue> = {},
  ): void {
    target.extensions[this.namespace] = {
      version: 1,
      sourceFormat: this.format,
      sourceIdentity: identity,
      sourcePath: path,
      rawData: this.clean(raw, target.id, path),
      ...extra,
    };
  }
  entity(
    identity: string,
    kind: EntityKind,
    name: unknown,
    description: unknown,
    raw: unknown,
    path: string,
  ): PortableEntity {
    const entity: PortableEntity = {
      id: `${this.format}:record:${encodeURIComponent(identity)}`,
      kind,
      name: typeof name === "string" ? name : "",
      relations: [],
      extensions: {},
    };
    const safeName = this.clean(entity.name, entity.id, `${path}/name`);
    entity.name = typeof safeName === "string" ? safeName : "";
    if (typeof description === "string") {
      const safeDescription = this.clean(
        description,
        entity.id,
        `${path}/description`,
      );
      entity.description =
        typeof safeDescription === "string" ? safeDescription : "";
    }
    this.retain(entity, raw, identity, path);
    this.document.entities.push(entity);
    return entity;
  }
  relation(
    entity: PortableEntity,
    type: string,
    target: string | undefined,
    path: string,
  ): void {
    if (target) {
      if (!entity.relations.some((r) => r.type === type && r.target === target))
        entity.relations.push({ type, target });
    } else
      this.omit(
        entity.id,
        path,
        "UNRESOLVED_SOURCE_REFERENCE",
        "Source reference does not resolve within the supplied snapshot; preserved opaque reference is not a live graph edge.",
        "missing",
      );
  }
  external(value: unknown, scope: string, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((v, i) => this.external(v, scope, `${path}/${i}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (
        typeof v === "string" &&
        v &&
        /(?:image|avatar|audio|video|texture|background|url|uri|src|image_path|header_image)/i.test(
          key,
        ) &&
        /^(?:https?:|\/api\/media\/)/i.test(v)
      )
        this.omit(
          scope,
          `${path}/${key}`,
          "EXTERNAL_MEDIA_UNAVAILABLE",
          "Media descriptor retained as inert source data; no remote download or redistribution permission is implied.",
          "external",
        );
      else this.external(v, scope, `${path}/${key}`);
    }
  }
  async media(
    bytes: Uint8Array | undefined,
    rights: AssetRights | undefined,
    role: string,
    scope: { id: string; assetIds?: string[] },
    path: string,
    declared?: string,
  ): Promise<string | undefined> {
    if (!bytes) {
      this.omit(
        scope.id,
        path,
        "MISSING_MEDIA_BYTES",
        "Referenced media bytes are not included in the supplied file.",
        "missing",
      );
      return;
    }
    if (!rights) {
      this.omit(
        scope.id,
        path,
        "MEDIA_RIGHTS_REQUIRED",
        "Bundled source media excluded until an explicit redistribution basis is supplied.",
        "rights-restricted",
      );
      return;
    }
    validateAssetRights(rights);
    let mediaType: string;
    try {
      mediaType = sniffMedia(bytes);
    } catch (error) {
      if (!(error instanceof WorldFormatError)) throw error;
      this.omit(scope.id, path, error.code, error.message, "invalid");
      return;
    }
    if (
      declared &&
      declared !== "application/octet-stream" &&
      declared !== mediaType
    )
      this.omit(
        scope.id,
        path,
        "SOURCE_MEDIA_TYPE_MISMATCH",
        `Source descriptor declares ${declared}; bytes are ${mediaType}. Original descriptor retained, canonical asset uses detected type.`,
        "invalid",
      );
    const hash = await sha256(bytes);
    const canonical = `assets/${hash}.${MEDIA_EXTENSIONS[mediaType]}`;
    let asset = this.document.assets.find((a) => a.path === canonical);
    if (!asset) {
      asset = {
        id: `asset:${hash}`,
        mediaType,
        sha256: hash,
        byteLength: bytes.length,
        path: canonical,
        role,
        rights: { ...rights },
      };
      this.document.assets.push(asset);
      this.assets[canonical] = bytes;
    }
    scope.assetIds ??= [];
    if (!scope.assetIds.includes(asset.id)) scope.assetIds.push(asset.id);
    return asset.id;
  }
  finish(): ParsedWorld {
    this.omit(
      this.document.world.id,
      "/",
      "SOURCE_SCOPE_INCOMPLETE",
      "Source prose, records and retained mechanics do not establish a complete playable world; no missing mechanics were synthesized.",
      "missing",
    );
    if (this.document.entities.some((e) => e.kind === "lore"))
      this.omit(
        this.document.world.id,
        "/entities",
        "OPAQUE_AUTHORED_CONTENT",
        "Safe source payloads are retained in versioned extensions. Uninterpreted rules and tool documents are inert, not executable gameplay.",
        "unmapped",
      );
    return {
      document: parsePortableWorld(this.document),
      assets: this.assets,
      sourceFormat: this.format,
    };
  }
}
export function walk(
  value: unknown,
  visit: (v: Obj, path: string) => void,
  path = "",
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, visit, `${path}/${i}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  visit(value as Obj, path);
  for (const [key, v] of Object.entries(value))
    walk(v, visit, `${path}/${key}`);
}
export function convertStoryCards(value: unknown): ParsedWorld {
  insist(
    Array.isArray(value) &&
      value.every(
        (v) =>
          v &&
          typeof v === "object" &&
          typeof v.keys === "string" &&
          typeof v.value === "string",
      ),
    "INVALID_SOURCE",
    "Expected AI Dungeon Story Card array.",
  );
  const c = new Conversion("ai-dungeon", "Imported Story Cards");
  value.forEach((v, i) => {
    const card = object(v);
    const kind =
      card.type === "character"
        ? "person"
        : card.type === "location"
          ? "place"
          : "lore";
    c.entity(
      `cards/${i}`,
      kind,
      card.title ?? card.keys,
      card.value,
      card,
      `/cards/${i}`,
    );
  });
  return c.finish();
}
export function convertVoyage(value: unknown, filename: string): ParsedWorld {
  const raw = object(value);
  insist(
    raw.heroesVersion === 36,
    "UNSUPPORTED_SOURCE_VERSION",
    "Only observed Voyage heroesVersion 36 is supported.",
  );
  const c = new Conversion("voyage", filename.replace(/\.json$/i, ""));
  const kinds: Record<string, EntityKind> = {
    regions: "group",
    realms: "group",
    locations: "place",
    npcs: "person",
    factions: "group",
    itemTypes: "item",
    worldLore: "lore",
    quests: "objective",
    narrativeEvents: "event",
  };
  const ids = new Map<string, string>();
  const rows: {
    entity: PortableEntity;
    record: Obj;
    section: string;
    key: string;
  }[] = [];
  for (const [section, kind] of Object.entries(kinds)) {
    if (raw[section] === undefined) {
      c.omit(
        c.document.world.id,
        `/${section}`,
        "MISSING_SOURCE_SECTION",
        "This source entity section is absent.",
        "missing",
      );
      continue;
    }
    for (const [key, v] of Object.entries(object(raw[section]))) {
      const record =
        typeof v === "string" ? { name: key, basicInfo: v } : object(v);
      const entity = c.entity(
        `${section}/${key}`,
        kind,
        record.name ?? key,
        record.basicInfo ?? record.description ?? record.content,
        v,
        `/${section}/${key}`,
      );
      ids.set(`${section}/${key}`, entity.id);
      rows.push({ entity, record, section, key });
      c.external(v, entity.id, `/${section}/${key}`);
    }
  }
  for (const { entity, record, section, key } of rows) {
    if (typeof record.region === "string" && record.region)
      c.relation(
        entity,
        "belongsTo",
        ids.get(`regions/${record.region}`),
        `/${section}/${key}/region`,
      );
    if (typeof record.currentLocation === "string" && record.currentLocation)
      c.relation(
        entity,
        "locatedAt",
        ids.get(`locations/${record.currentLocation}`),
        `/${section}/${key}/currentLocation`,
      );
  }
  const config = { ...raw };
  for (const section of Object.keys(kinds)) delete config[section];
  // Mods are source application modules, not authored world records.
  if (Array.isArray(config.mods) && config.mods.length)
    c.omit(
      c.document.world.id,
      "/mods",
      "SOURCE_APPLICATION_SOFTWARE_EXCLUDED",
      "Source application modules are not portable authored content.",
      "unsupported",
    );
  delete config.mods;
  c.retain(c.document.world, config, "configuration", "/");
  c.external(config, c.document.world.id, "/");
  return c.finish();
}

/** Observed CDF uses both inline JSON and indentation-based YAML frontmatter. Full Markdown remains inert evidence. */
function markdownRecord(text: string): Obj {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n"))
    return { content: text };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { content: text };
  const raw: Obj = { content: match[2]!, frontmatter: match[1]! };
  const stack: { indent: number; value: Obj }[] = [{ indent: -1, value: raw }];
  for (const line of match[1]!.split(/\r?\n/)) {
    const row = /^( *)([^:#][^:]*):(?:\s*(.*))?$/.exec(line);
    if (!row) continue;
    const indent = row[1]!.length;
    const key = row[2]!.trim();
    const value = row[3]?.trim() ?? "";
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent)
      stack.pop();
    const parent = stack[stack.length - 1]!.value;
    if (!value) {
      const nested: Obj = {};
      parent[key] = nested;
      stack.push({ indent, value: nested });
    } else {
      try {
        parent[key] = JSON.parse(value);
      } catch {
        parent[key] = value.replace(/^'(.*)'$/, "$1");
      }
    }
  }
  return raw;
}
export async function convertCdf(
  files: Record<string, Uint8Array>,
  rights?: AssetRights,
): Promise<ParsedWorld> {
  const projectPaths = Object.keys(files).filter((p) =>
    /(?:^|\/)\.craft\/project\.json$/.test(p),
  );
  insist(
    projectPaths.length === 1,
    "INVALID_SOURCE",
    "CDF requires exactly one project metadata file.",
  );
  const projectPath = projectPaths[0]!;
  const root = projectPath.slice(0, -".craft/project.json".length);
  const project = object(json(files[projectPath]!));
  const c = new Conversion(
    "cdf",
    typeof project.name === "string" ? project.name : "Imported CDF",
  );
  c.retain(c.document.world, project, "project", projectPath);
  if (typeof project.description === "string")
    c.document.world.description = c.clean(
      project.description,
      c.document.world.id,
      `${projectPath}/description`,
    ) as string;
  c.external(project, c.document.world.id, projectPath);
  const schemas: Obj = {};
  const rows: { entity: PortableEntity; record: Obj; path: string }[] = [];
  const refs = new Map<string, string>();
  const kinds: Record<string, EntityKind> = {
    character: "person",
    monster: "person",
    creature: "person",
    location: "place",
    faction: "group",
    lore: "lore",
    "game-start": "event",
    gear: "item",
    "adventuring-gear": "item",
    armor: "item",
    equipment: "item",
    consumable: "item",
    "magic-item": "item",
  };
  let syncExcluded = false;
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith(root)) {
      c.omit(
        c.document.world.id,
        path,
        "UNRELATED_ARCHIVE_ENTRY",
        "Entry outside the CDF project is excluded.",
        "unsupported",
      );
      continue;
    }
    const relative = path.slice(root.length);
    if (relative.startsWith(".craft/")) {
      if (
        relative.startsWith(".craft/file-types/") &&
        relative.endsWith(".json")
      )
        schemas[relative] = json(bytes);
      else if (relative !== ".craft/project.json") syncExcluded = true;
      continue;
    }
    if (scriptFiles.test(relative) || /\.mcp\.(?:json|md)$/.test(relative)) {
      c.omit(
        c.document.world.id,
        path,
        "SOURCE_APPLICATION_SOFTWARE_EXCLUDED",
        "Application software or agent-control files are not authored entities.",
        "unsupported",
      );
      continue;
    }
    const typed = /\.([a-z0-9-]+)\.(json|md)$/i.exec(relative);
    if (!typed) {
      if (
        !/\.(?:png|jpe?g|webp|gif|mp3|wav|ogg|flac|mp4|glb|obj|stl)$/i.test(
          relative,
        )
      )
        c.omit(
          c.document.world.id,
          path,
          "UNSUPPORTED_CDF_ENTRY",
          "Unrecognized CDF entry excluded; media is never fetched remotely.",
          "unsupported",
        );
      continue;
    }
    const record = object(
      typed[2] === "json" ? json(bytes) : markdownRecord(utf8(bytes)),
    );
    // Frontmatter's recognized values are retained as JSON; unparsed text is retained after privacy filtering.
    if (typeof record.frontmatter === "string") {
      let excludedIndent: number | undefined;
      const safeLines: string[] = [];
      for (const line of record.frontmatter.split(/\r?\n/)) {
        const indent = /^\s*/.exec(line)![0].length;
        if (
          excludedIndent !== undefined &&
          (line.trim() === "" || indent > excludedIndent)
        )
          continue;
        excludedIndent = undefined;
        if (privateKeys.test(line.trim().split(":")[0] ?? "")) {
          excludedIndent = indent;
          c.omit(
            c.document.world.id,
            `${path}/frontmatter`,
            "PRIVATE_SOURCE_DATA_REMOVED",
            "Private YAML field and its nested values removed.",
            "unsupported",
          );
          continue;
        }
        safeLines.push(line);
      }
      record.frontmatter = safeLines.join("\n");
    }
    const craft =
      record.$craft && typeof record.$craft === "object"
        ? object(record.$craft)
        : {};
    const identity =
      typeof craft.referenceId === "string"
        ? craft.referenceId
        : `path:${relative}`;
    const description =
      typed[2] === "md"
        ? record.content
        : (record.description ?? record.content);
    const entity = c.entity(
      identity,
      kinds[typed[1]!] ?? "lore",
      record.name ??
        relative
          .replace(/\.[^.]+\.(json|md)$/i, "")
          .split("/")
          .pop(),
      description,
      record,
      path,
    );
    if (typeof craft.referenceId === "string") {
      insist(
        !refs.has(craft.referenceId),
        "DUPLICATE_SOURCE_ID",
        "CDF reference IDs must be unique outside synchronization baselines.",
      );
      refs.set(craft.referenceId, entity.id);
    }
    entity.extensions[c.namespace]!.fileTypeSlug = typed[1]!;
    rows.push({ entity, record, path });
    c.external(record, entity.id, path);
  }
  if (syncExcluded)
    c.omit(
      c.document.world.id,
      `${root}.craft/`,
      "CDF_SYNC_METADATA_EXCLUDED",
      "Workspace, index and baseline synchronization data excluded; current authored records only.",
      "unsupported",
    );
  c.document.extensions[c.namespace] = {
    version: 1,
    fileTypes: c.clean(
      schemas,
      c.document.world.id,
      `${root}.craft/file-types`,
    ),
  };
  for (const { entity, record, path } of rows)
    walk(record, (node, nodePath) => {
      if (
        typeof node.referenceId === "string" &&
        typeof node.fileTypeSlug === "string"
      )
        c.relation(
          entity,
          `cdf:${node.fileTypeSlug}`,
          refs.get(node.referenceId),
          `${path}${nodePath}`,
        );
      for (const [key, value] of Object.entries(node))
        if (
          typeof value === "string" &&
          /(?:^fileReferenceId$|FileReferenceId$)/.test(key)
        )
          c.relation(
            entity,
            "cdf:file",
            refs.get(value),
            `${path}${nodePath}/${key}`,
          );
    });
  const bindings: Record<string, JsonValue> = {};
  const consumedFiles = new Set<string>();
  for (const { entity, record, path } of [
    ...rows,
    { entity: c.document.world, record: project, path: projectPath },
  ]) {
    const descriptors: { uri: string; sourcePath: string }[] = [];
    walk(record, (node, nodePath) => {
      if (
        typeof node.url === "string" &&
        node.url &&
        !/^(?:https?:|data:)/i.test(node.url)
      )
        descriptors.push({
          uri: node.url,
          sourcePath: `${path}${nodePath}/url`,
        });
    });
    for (const descriptor of descriptors) {
      const candidate = descriptor.uri.replace(/^\.\//, "");
      const sourceFile = files[candidate] ? candidate : `${root}${candidate}`;
      const bytes = files[sourceFile];
      if (bytes) consumedFiles.add(sourceFile);
      const asset = await c.media(
        bytes,
        rights,
        "source-media",
        entity,
        descriptor.sourcePath,
      );
      if (asset) bindings[descriptor.sourcePath] = asset;
    }
  }
  for (const [path, bytes] of Object.entries(files)) {
    if (
      !path.startsWith(root) ||
      consumedFiles.has(path) ||
      path.slice(root.length).startsWith(".craft/") ||
      !/\.(?:png|jpe?g|webp|gif|mp3|wav|ogg|flac|mp4|glb|obj|stl)$/i.test(path)
    )
      continue;
    const asset = await c.media(
      bytes,
      rights,
      "source-media",
      c.document.world,
      path,
    );
    if (asset) bindings[path] = asset;
  }
  c.document.extensions[c.namespace]!.mediaBindings = bindings;
  const settings =
    project.settings && typeof project.settings === "object"
      ? object(project.settings)
      : {};
  if (
    typeof settings.rootMapFileReferenceId === "string" &&
    !refs.has(settings.rootMapFileReferenceId)
  )
    c.omit(
      c.document.world.id,
      `${projectPath}/settings/rootMapFileReferenceId`,
      "UNRESOLVED_SOURCE_REFERENCE",
      "Root map reference absent in this snapshot.",
      "missing",
    );
  return c.finish();
}
