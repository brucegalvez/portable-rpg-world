import { Conversion, object, walk } from "./converters.ts";
import { decodeBase64, insist, json, safePath, utf8 } from "./safety.ts";
import type {
  AssetRights,
  EntityKind,
  JsonValue,
  ParsedWorld,
  PortableEntity,
} from "./types.ts";

function authoredText(value: unknown): string {
  const pieces: string[] = [];
  walk(value, (node) => {
    if (typeof node.text === "string") pieces.push(node.text);
    else if (
      node.type === "mention" &&
      node.attrs &&
      typeof object(node.attrs).text === "string"
    )
      pieces.push(object(node.attrs).text as string);
  });
  return pieces.join(" ");
}
export function convertLegendKeeper(value: unknown): ParsedWorld {
  const raw = object(value);
  insist(
    raw.version === 1 &&
      Array.isArray(raw.resources) &&
      Array.isArray(raw.calendars),
    "UNSUPPORTED_SOURCE_VERSION",
    "Expected observed LegendKeeper version-1 resource export.",
  );
  const c = new Conversion("legendkeeper", "Imported LegendKeeper resources");
  const ids = new Map<string, string>();
  const rows: { entity: PortableEntity; raw: Record<string, unknown> }[] = [];
  raw.resources.forEach((v, i) => {
    const r = object(v);
    insist(
      typeof r.id === "string" &&
        typeof r.name === "string" &&
        Array.isArray(r.documents),
      "INVALID_SOURCE",
      "LegendKeeper resources require id, name and documents.",
    );
    insist(
      !ids.has(r.id),
      "DUPLICATE_SOURCE_ID",
      "Duplicate LegendKeeper resource identity.",
    );
    const entity = c.entity(
      r.id,
      "lore",
      r.name,
      authoredText(r.documents),
      r,
      `/resources/${i}`,
    );
    ids.set(r.id, entity.id);
    rows.push({ entity, raw: r });
    c.external(r, entity.id, `/resources/${i}`);
  });
  for (const { entity, raw: r } of rows)
    walk(r, (node, path) => {
      if (
        node.type === "mention" &&
        node.attrs &&
        typeof node.attrs === "object"
      ) {
        const attrs = object(node.attrs);
        if (typeof attrs.id === "string")
          c.relation(
            entity,
            "involves",
            ids.get(attrs.id),
            `/resources/${r.id}${path}/attrs/id`,
          );
      }
      if (typeof node.parentId === "string")
        c.relation(
          entity,
          "belongsTo",
          ids.get(node.parentId),
          `/resources/${r.id}${path}/parentId`,
        );
      if (typeof node.resourceId === "string")
        c.relation(
          entity,
          "involves",
          ids.get(node.resourceId),
          `/resources/${r.id}${path}/resourceId`,
        );
    });
  const envelope = { ...raw };
  delete envelope.resources;
  c.retain(c.document.world, envelope, "resource-export", "/");
  c.omit(
    c.document.world.id,
    "/resources",
    "SOURCE_SUBTREE_SCOPE",
    "Resource export may describe only a selected subtree. Map/board/editor data is retained, not converted into movement or game mechanics.",
    "unmapped",
  );
  return c.finish();
}
export function convertKanka(files: Record<string, Uint8Array>): ParsedWorld {
  const info = object(json(files["info.json"]!));
  insist(
    info.export_version === "3.15",
    "UNSUPPORTED_SOURCE_VERSION",
    "Only observed Kanka JSON export version 3.15 is supported.",
  );
  const campaign = object(json(files["campaign.json"]!));
  const c = new Conversion(
    "kanka",
    typeof campaign.name === "string"
      ? campaign.name
      : "Imported Kanka campaign",
    String(campaign.id ?? "snapshot"),
  );
  c.retain(
    c.document.world,
    campaign,
    String(campaign.id ?? "campaign"),
    "/campaign.json",
  );
  c.external(campaign, c.document.world.id, "/campaign.json");
  const kinds: Record<string, EntityKind> = {
    characters: "person",
    locations: "place",
    items: "item",
    organisations: "group",
    organizations: "group",
    families: "group",
    races: "group",
    quests: "objective",
    events: "event",
    notes: "lore",
    journals: "lore",
  };
  const ids = new Map<string, string>();
  const genericIds = new Map<string, string>();
  const rows: {
    entity: PortableEntity;
    record: Record<string, unknown>;
    category: string;
    path: string;
  }[] = [];
  const sourceInfo = { ...info };
  if (Object.hasOwn(sourceInfo, "started")) {
    delete sourceInfo.started;
    c.omit(
      c.document.world.id,
      "/info.json/started",
      "PRIVATE_SOURCE_DATA_REMOVED",
      "Export-run lifecycle timestamp excluded from authored content.",
      "unsupported",
    );
  }
  const metadata: Record<string, unknown> = { "info.json": sourceInfo };
  for (const [path, bytes] of Object.entries(files)) {
    if (path === "info.json" || path === "campaign.json") continue;
    if (!path.endsWith(".json")) {
      c.omit(
        c.document.world.id,
        path,
        "UNSUPPORTED_KANKA_ENTRY",
        "Unsupported entry is not interpreted or executed.",
        "unsupported",
      );
      continue;
    }
    const value = json(bytes);
    const category = path.split("/")[0]!;
    if (category === "settings") {
      metadata[path] = value;
      continue;
    }
    const raw = object(value);
    if (raw.id === undefined || !raw.entity || typeof raw.entity !== "object") {
      metadata[path] = raw;
      c.omit(
        c.document.world.id,
        path,
        "OPAQUE_KANKA_DOCUMENT",
        "Unrecognized authored document retained as opaque source data, not invented as a typed entity.",
        "unmapped",
      );
      continue;
    }
    const generic = object(raw.entity);
    const identity = `${category}/${raw.id}`;
    insist(
      !ids.has(identity),
      "DUPLICATE_SOURCE_ID",
      "Duplicate Kanka typed record ID.",
    );
    const entity = c.entity(
      identity,
      kinds[category] ?? "lore",
      raw.name ?? generic.name,
      raw.entry ?? generic.entry,
      raw,
      path,
    );
    ids.set(identity, entity.id);
    if (generic.id !== undefined) {
      insist(
        !genericIds.has(String(generic.id)),
        "DUPLICATE_SOURCE_ID",
        "Duplicate Kanka generic entity ID.",
      );
      genericIds.set(String(generic.id), entity.id);
    }
    rows.push({ entity, record: raw, category, path });
    c.external(raw, entity.id, path);
  }
  for (const { entity, record, category, path } of rows) {
    const generic = object(record.entity);
    if (generic.parent_id !== null && generic.parent_id !== undefined)
      c.relation(
        entity,
        "belongsTo",
        genericIds.get(String(generic.parent_id)),
        `${path}/entity/parent_id`,
      );
    const locations = generic.entityLocations ?? generic.entity_locations;
    if (Array.isArray(locations))
      locations.forEach((v, i) => {
        const ref = object(v);
        if (ref.location_id !== undefined)
          c.relation(
            entity,
            "locatedAt",
            ids.get(`locations/${ref.location_id}`),
            `${path}/entity/entityLocations/${i}/location_id`,
          );
      });
    if (record.location_id !== undefined && record.location_id !== null)
      c.relation(
        entity,
        "locatedAt",
        ids.get(`locations/${record.location_id}`),
        `${path}/location_id`,
      );
    if (
      category === "locations" &&
      record.parent_location_id !== undefined &&
      record.parent_location_id !== null
    )
      c.relation(
        entity,
        "belongsTo",
        ids.get(`locations/${record.parent_location_id}`),
        `${path}/parent_location_id`,
      );
  }
  c.document.extensions[c.namespace] = {
    version: 1,
    metadata: c.clean(metadata, c.document.world.id, ""),
  };
  return c.finish();
}
export async function convertVvd(
  inner: Record<string, Uint8Array>,
  outer: Record<string, Uint8Array>,
  rights?: AssetRights,
): Promise<ParsedWorld> {
  const world = object(json(inner["world.json"]!));
  insist(
    typeof world.id === "string" &&
      typeof world.name === "string" &&
      inner["entity-types.json"],
    "INVALID_SOURCE",
    "Expected vvd document backup, not a neutral world.json.",
  );
  const c = new Conversion("vvd", world.name, world.id);
  c.retain(c.document.world, world, world.id, "/world.json");
  if (typeof world.description === "string")
    c.document.world.description = c.clean(
      world.description,
      c.document.world.id,
      "/world.json/description",
    ) as string;
  const typeEnvelope = object(json(inner["entity-types.json"]!));
  const types =
    typeEnvelope.types && typeof typeEnvelope.types === "object"
      ? object(typeEnvelope.types)
      : {};
  const ids = new Map<string, string>();
  const rows: {
    entity: PortableEntity;
    record: Record<string, unknown>;
    path: string;
  }[] = [];
  const metadata: Record<string, unknown> = {};
  for (const [path, bytes] of Object.entries(inner)) {
    if (path === "world.json") continue;
    if (!path.endsWith(".json")) {
      c.omit(
        c.document.world.id,
        path,
        "UNSUPPORTED_VVD_ENTRY",
        "Backup member is not an authored JSON document.",
        "unsupported",
      );
      continue;
    }
    const raw = json(bytes);
    if (!path.startsWith("documents/")) {
      metadata[path] = raw;
      continue;
    }
    const r = object(raw);
    insist(
      typeof r.id === "string" && typeof r.name === "string",
      "INVALID_SOURCE",
      "vvd documents require stable id and name.",
    );
    insist(!ids.has(r.id), "DUPLICATE_SOURCE_ID", "Duplicate vvd document ID.");
    let key =
      typeof r.entity_type_key === "string"
        ? r.entity_type_key
        : typeof r.entity_type_id === "string"
          ? r.entity_type_id
          : "";
    const seen = new Set<string>();
    while (types[key] && typeof types[key] === "object" && !seen.has(key)) {
      seen.add(key);
      const parent = object(types[key]).parent_type_id;
      if (typeof parent !== "string") break;
      key = parent;
    }
    const kinds: Record<string, EntityKind> = {
      character: "person",
      location: "place",
      item: "item",
      artifact: "item",
      faction: "group",
      event: "event",
      lore: "lore",
    };
    const entity = c.entity(
      r.id,
      r.document_type === "card" ? (kinds[key] ?? "lore") : "lore",
      r.name,
      r.plainText ?? authoredText(r.content),
      r,
      path,
    );
    ids.set(r.id, entity.id);
    rows.push({ entity, record: r, path });
  }
  for (const { entity, record, path } of rows) {
    if (typeof record.parent_id === "string")
      c.relation(
        entity,
        "belongsTo",
        ids.get(record.parent_id),
        `${path}/parent_id`,
      );
    walk(record.content, (node, sub) => {
      if (typeof node.cardDocumentId === "string")
        c.relation(
          entity,
          "involves",
          ids.get(node.cardDocumentId),
          `${path}/content${sub}/cardDocumentId`,
        );
    });
  }
  if (inner["links.json"]) {
    const links = json(inner["links.json"]!);
    if (Array.isArray(links))
      links.forEach((v, i) => {
        const r = object(v);
        const source = rows.find((row) => row.record.id === r.source_id);
        if (source && typeof r.target_id === "string")
          c.relation(
            source.entity,
            `vvd:${String(r.kind ?? "link")}`,
            ids.get(r.target_id),
            `/links.json/${i}`,
          );
        else
          c.omit(
            c.document.world.id,
            `/links.json/${i}`,
            "UNRESOLVED_SOURCE_REFERENCE",
            "Link endpoint absent from supplied documents.",
            "missing",
          );
      });
  }
  const markdown: Record<string, JsonValue> = {};
  for (const [path, bytes] of Object.entries(outer))
    if (path.startsWith("world/") && path.endsWith(".md"))
      markdown[path] = c.clean(utf8(bytes), c.document.world.id, path);
  const mediaIds = new Map<string, string>();
  const media = inner["media.json"] ? object(json(inner["media.json"]!)) : {};
  if (Array.isArray(media.entries))
    for (let i = 0; i < media.entries.length; i++) {
      const entry = object(media.entries[i]);
      const path =
        typeof entry.path === "string" ? safePath(entry.path) : undefined;
      const asset = await c.media(
        path ? (outer[path] ?? inner[path]) : undefined,
        rights,
        "source-media",
        c.document.world,
        `/media.json/entries/${i}`,
        typeof entry.mimeType === "string" ? entry.mimeType : undefined,
      );
      if (asset && typeof entry.id === "string") mediaIds.set(entry.id, asset);
    }
  for (const { entity, record, path } of rows) {
    if (typeof record.avatar_media_id === "string") {
      const asset = mediaIds.get(record.avatar_media_id);
      if (asset) entity.assetIds = [asset];
      else if (!Array.isArray(media.entries))
        c.omit(
          entity.id,
          `${path}/avatar_media_id`,
          "MISSING_MEDIA_BYTES",
          "Document avatar is not included in this writing-only backup.",
          "missing",
        );
    }
    c.external(record, entity.id, path);
  }
  c.external(world, c.document.world.id, "/world.json");
  c.document.extensions[c.namespace] = {
    version: 1,
    metadata: c.clean(metadata, c.document.world.id, "/"),
    markdown,
    mediaBindings: Object.fromEntries(mediaIds),
  };
  return c.finish();
}
export async function convertCharacterCard(
  value: unknown,
  files: Record<string, Uint8Array> = {},
  rights?: AssetRights,
  pngAvatar?: Uint8Array,
): Promise<ParsedWorld> {
  const raw = object(value);
  insist(
    raw.spec === "chara_card_v3" && raw.spec_version === "3.0",
    "UNSUPPORTED_SOURCE_VERSION",
    "Expected CCv3 spec chara_card_v3 version 3.0.",
  );
  const data = object(raw.data);
  insist(
    typeof data.name === "string" && typeof data.description === "string",
    "INVALID_CHARACTER_CARD",
    "CCv3 requires name and description.",
  );
  const c = new Conversion("ccv3", data.name);
  const person = c.entity(
    "card",
    "person",
    data.name,
    data.description,
    raw,
    "/card.json",
  );
  const book =
    data.character_book && typeof data.character_book === "object"
      ? object(data.character_book)
      : {};
  if (Array.isArray(book.entries))
    book.entries.forEach((value, i) => {
      const entry = object(value);
      const identity =
        typeof entry.id === "string" || typeof entry.id === "number"
          ? `lore/${entry.id}`
          : `lore/path/${i}`;
      const lore = c.entity(
        identity,
        "lore",
        entry.name ?? entry.comment ?? "",
        entry.content,
        entry,
        `/card.json/data/character_book/entries/${i}`,
      );
      c.relation(
        person,
        "involves",
        lore.id,
        `/card.json/data/character_book/entries/${i}`,
      );
    });
  const bindings: Record<string, JsonValue> = {};
  const declaredFiles = new Set<string>();
  if (Array.isArray(data.assets))
    for (let i = 0; i < data.assets.length; i++) {
      const descriptor = object(data.assets[i]);
      const uri = descriptor.uri;
      const path = `/card.json/data/assets/${i}`;
      if (typeof uri !== "string") {
        c.omit(
          person.id,
          path,
          "INVALID_MEDIA_DESCRIPTOR",
          "Asset URI is absent.",
          "invalid",
        );
        continue;
      }
      let bytes: Uint8Array | undefined;
      let declared =
        typeof descriptor.ext === "string"
          ? (
              {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                webp: "image/webp",
                gif: "image/gif",
                mp3: "audio/mpeg",
                wav: "audio/wav",
                ogg: "audio/ogg",
                mp4: "video/mp4",
              } as Record<string, string>
            )[descriptor.ext.toLowerCase()]
          : undefined;
      if (uri.startsWith("embeded://")) {
        const sourcePath = safePath(uri.slice("embeded://".length));
        declaredFiles.add(sourcePath);
        bytes = files[sourcePath];
      } else if (uri.startsWith("data:")) {
        const match = /^data:([^;,]*);base64,([\s\S]*)$/.exec(uri);
        insist(match, "INVALID_MEDIA_DESCRIPTOR", "Unsupported data URI.");
        if (rights) bytes = decodeBase64(match[2]!);
        if (!declared) declared = match[1]!;
        if (!rights) {
          c.omit(
            person.id,
            path,
            "MEDIA_RIGHTS_REQUIRED",
            "Inline binary excluded without explicit redistribution basis.",
            "rights-restricted",
          );
          continue;
        }
      } else if (/^https?:\/\//.test(uri)) {
        c.omit(
          person.id,
          path,
          "EXTERNAL_MEDIA_UNAVAILABLE",
          "Remote character-card media is not fetched.",
          "external",
        );
        continue;
      } else if (uri === "ccdefault:" && pngAvatar) {
        bytes = pngAvatar;
        declared = "image/png";
      } else {
        c.omit(
          person.id,
          path,
          "MISSING_MEDIA_BYTES",
          "Default or unsupported character-card media URI has no portable bytes.",
          "missing",
        );
        continue;
      }
      const asset = await c.media(
        bytes,
        rights,
        String(descriptor.type ?? "character-media"),
        person,
        path,
        declared,
      );
      if (asset) bindings[String(i)] = asset;
    }
  if (pngAvatar && (!Array.isArray(data.assets) || data.assets.length === 0)) {
    const asset = await c.media(
      pngAvatar,
      rights,
      "icon",
      person,
      "/png/image",
      "image/png",
    );
    if (asset) bindings.pngImage = asset;
  }
  const extras: Record<string, JsonValue> = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (path === "card.json" || declaredFiles.has(path)) continue;
    if (path.startsWith("assets/")) {
      c.omit(
        person.id,
        path,
        "UNDECLARED_CHARACTER_MEDIA",
        "Attachment not declared by the character-card asset list; no role or reference is guessed.",
        rights ? "unsupported" : "rights-restricted",
      );
      continue;
    }
    if (path.startsWith("x_meta/") && path.endsWith(".json"))
      extras[path] = c.clean(json(bytes), person.id, path);
    else
      c.omit(
        person.id,
        path,
        "SOURCE_APPLICATION_SOFTWARE_EXCLUDED",
        "Application modules and unsupported attachments excluded; no included code is executed.",
        "unsupported",
      );
  }
  c.document.extensions[c.namespace] = {
    version: 1,
    metadata: extras,
    mediaBindings: bindings,
  };
  return c.finish();
}
function htmlText(value: string): string {
  return value
    .replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|li|section)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[entity]!,
    )
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
export function convertWorldAnvilHtml(html: string): ParsedWorld {
  insist(
    /World Anvil/i.test(html) &&
      /class=["'][^"']*print-interface/i.test(html) &&
      /class=["'][^"']*world-title/i.test(html),
    "UNRECOGNIZED_SOURCE",
    "HTML is not a recognized World Anvil official export fallback.",
  );
  const match =
    /<h1\b[^>]*class=["'][^"']*world-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(
      html,
    );
  const c = new Conversion(
    "world-anvil-html",
    match ? htmlText(match[1]!) : "Imported World Anvil",
  );
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? "";
  const cleaned = body
    .replace(
      /<(script|style|iframe|object|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(
      /<span\b[^>]*class=["'][^"']*world-authors[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
      "",
    )
    .replace(
      /<div\b[^>]*id=["'](?:batBeacon|.*tracking)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      "",
    )
    .replace(/<img\b[^>]*>/gi, "");
  const text = htmlText(cleaned);
  c.document.world.description = text;
  c.retain(c.document.world, { authoredText: text }, "html-fallback", "/body");
  c.omit(
    c.document.world.id,
    "/html",
    "HTML_ACTIVE_PRIVATE_CONTENT_REMOVED",
    "Scripts, styles, embedded applications, creator-account display and tracking discarded; authored visible text retained inert.",
    "unsupported",
  );
  c.omit(
    c.document.world.id,
    "/html/links",
    "HTML_GRAPH_UNAVAILABLE",
    "HTML fallback does not establish a trustworthy article/category/reference graph; no structured entities inferred.",
    "missing",
  );
  c.omit(
    c.document.world.id,
    "/html/media",
    "HTML_MEDIA_UNAVAILABLE",
    "HTML export does not supply validated redistributable media bytes.",
    "external",
  );
  if (!/\b(?:article|timeline)[-_]?(?:id|body|content)\b/i.test(cleaned))
    c.omit(
      c.document.world.id,
      "/html/articles",
      "EMPTY_OR_UNSTRUCTURED_HTML_EXPORT",
      "No independently identifiable authored article/timeline records in the recognized fallback.",
      "missing",
    );
  return c.finish();
}
