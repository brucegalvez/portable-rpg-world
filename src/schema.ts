import { filterSourceData } from "./privacy.ts";
import { insist, safePath, validateJson, WORLD_FILE_LIMITS } from "./safety.ts";
import type {
  AssetRights,
  Extensions,
  PortableOmission,
  PortableWorld,
} from "./types.ts";

const string = { type: "string" };
const nonempty = { type: "string", minLength: 1 };
const id = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
};
const extensions = {
  type: "object",
  propertyNames: { pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$" },
  additionalProperties: {
    type: "object",
    required: ["version"],
    properties: { version: { type: "integer", minimum: 1 } },
    additionalProperties: true,
  },
};
const assetIds = { type: "array", uniqueItems: true, items: id };
const rights = {
  type: "object",
  required: ["basis"],
  properties: { basis: nonempty, attribution: nonempty },
  additionalProperties: false,
};
/** The portableGraph vocabulary adds identity/reference/path/MIME/rights invariants to structural JSON Schema. */
export const portableWorldSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:portable-rpg-world:schema:1",
  title: "Portable RPG World version 1",
  type: "object",
  required: [
    "format",
    "version",
    "world",
    "entities",
    "assets",
    "omissions",
    "extensions",
  ],
  additionalProperties: false,
  portableGraph: true,
  properties: {
    format: { const: "portable-rpg-world" },
    version: { const: 1 },
    world: {
      type: "object",
      required: ["id", "title", "extensions"],
      additionalProperties: false,
      properties: {
        id,
        title: string,
        description: string,
        assetIds,
        extensions,
      },
    },
    entities: {
      type: "array",
      maxItems: WORLD_FILE_LIMITS.members,
      items: {
        type: "object",
        required: ["id", "kind", "name", "relations", "extensions"],
        additionalProperties: false,
        properties: {
          id,
          kind: {
            enum: [
              "place",
              "person",
              "item",
              "group",
              "lore",
              "objective",
              "event",
            ],
          },
          name: string,
          description: string,
          assetIds,
          extensions,
          relations: {
            type: "array",
            items: {
              type: "object",
              required: ["type", "target"],
              additionalProperties: false,
              properties: { type: nonempty, target: id },
            },
          },
        },
      },
    },
    assets: {
      type: "array",
      maxItems: WORLD_FILE_LIMITS.members,
      items: {
        type: "object",
        required: [
          "id",
          "mediaType",
          "sha256",
          "byteLength",
          "path",
          "role",
          "rights",
        ],
        additionalProperties: false,
        properties: {
          id,
          mediaType: {
            enum: [
              "image/png",
              "image/jpeg",
              "image/webp",
              "image/gif",
              "audio/mpeg",
              "audio/ogg",
              "audio/wav",
              "audio/flac",
              "video/mp4",
              "model/gltf-binary",
              "text/plain",
              "model/stl",
            ],
          },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          byteLength: {
            type: "integer",
            minimum: 1,
            maximum: WORLD_FILE_LIMITS.assetBytes,
          },
          path: {
            type: "string",
            pattern:
              "^assets/[a-f0-9]{64}\\.(?:png|jpg|webp|gif|mp3|ogg|wav|flac|mp4|glb|obj|stl)$",
          },
          role: nonempty,
          rights,
          sourceUrl: string,
        },
      },
    },
    omissions: {
      type: "array",
      items: {
        type: "object",
        required: ["scopeId", "sourcePath", "code", "message", "disposition"],
        additionalProperties: false,
        properties: {
          scopeId: id,
          sourcePath: string,
          code: nonempty,
          message: string,
          disposition: {
            enum: [
              "unmapped",
              "unsupported",
              "missing",
              "external",
              "rights-restricted",
              "invalid",
            ],
          },
          targetKind: string,
          sourceFormat: string,
        },
      },
    },
    extensions,
  },
} as const;

// A deliberately small JSON Schema interpreter for the vocabulary used by the public schema.
type Schema = { [key: string]: unknown };
function structural(value: unknown, schema: Schema, path: string): void {
  if ("const" in schema)
    insist(
      value === schema.const,
      "INVALID_DOCUMENT",
      `${path}: unsupported format/version or constant.`,
    );
  if (schema.enum)
    insist(
      (schema.enum as unknown[]).includes(value),
      "INVALID_DOCUMENT",
      `${path}: unsupported value.`,
    );
  const type = schema.type;
  if (type === "string") {
    insist(
      typeof value === "string",
      "INVALID_DOCUMENT",
      `${path}: expected string.`,
    );
    if (schema.minLength)
      insist(
        value.length >= Number(schema.minLength),
        "INVALID_DOCUMENT",
        `${path}: empty value.`,
      );
    if (schema.maxLength)
      insist(
        value.length <= Number(schema.maxLength),
        "INVALID_DOCUMENT",
        `${path}: excessive length.`,
      );
    if (schema.pattern)
      insist(
        new RegExp(String(schema.pattern), "u").test(value),
        "INVALID_DOCUMENT",
        `${path}: invalid string.`,
      );
  } else if (type === "integer") {
    insist(
      typeof value === "number" && Number.isSafeInteger(value),
      "INVALID_DOCUMENT",
      `${path}: expected safe integer.`,
    );
    if (schema.minimum !== undefined)
      insist(
        value >= Number(schema.minimum),
        "INVALID_DOCUMENT",
        `${path}: below minimum.`,
      );
    if (schema.maximum !== undefined)
      insist(
        value <= Number(schema.maximum),
        "INVALID_DOCUMENT",
        `${path}: above maximum.`,
      );
  } else if (type === "array") {
    insist(
      Array.isArray(value),
      "INVALID_DOCUMENT",
      `${path}: expected array.`,
    );
    if (schema.maxItems)
      insist(
        value.length <= Number(schema.maxItems),
        "LIMIT_EXCEEDED",
        `${path}: too many records.`,
      );
    if (schema.uniqueItems)
      insist(
        new Set(value.map((v) => JSON.stringify(v))).size === value.length,
        "INVALID_DOCUMENT",
        `${path}: duplicate values.`,
      );
    value.forEach((v, i) =>
      structural(v, schema.items as Schema, `${path}/${i}`),
    );
  } else if (type === "object") {
    insist(
      value !== null && typeof value === "object" && !Array.isArray(value),
      "INVALID_DOCUMENT",
      `${path}: expected object.`,
    );
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[])
      insist(
        Object.hasOwn(object, key),
        "INVALID_DOCUMENT",
        `${path}/${key}: missing required field.`,
      );
    for (const [key, v] of Object.entries(object)) {
      if (schema.propertyNames)
        structural(
          key,
          { type: "string", ...(schema.propertyNames as Schema) },
          path,
        );
      if (Object.hasOwn(properties, key))
        structural(v, properties[key]!, `${path}/${key}`);
      else {
        insist(
          schema.additionalProperties !== false,
          "INVALID_DOCUMENT",
          `${path}/${key}: unknown core field; use extensions.`,
        );
        if (typeof schema.additionalProperties === "object")
          structural(
            v,
            schema.additionalProperties as Schema,
            `${path}/${key}`,
          );
      }
    }
  }
}
export function validateAssetRights(value: AssetRights): AssetRights {
  validateJson(value);
  structural(value, rights, "/rights");
  insist(
    value.basis.trim().length > 0 &&
      !/^(?:unknown|unverified|none|restricted|external)$/i.test(
        value.basis.trim(),
      ),
    "RIGHTS_REQUIRED",
    "An explicit redistribution basis is required.",
  );
  if (/\b(?:cc-by|attribution)\b/i.test(value.basis))
    insist(
      value.attribution?.trim(),
      "RIGHTS_REQUIRED",
      "This redistribution basis requires attribution.",
    );
  return value;
}
export const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "model/gltf-binary": "glb",
  "text/plain": "obj",
  "model/stl": "stl",
};
export function parsePortableWorld(value: unknown): PortableWorld {
  validateJson(value);
  structural(value, portableWorldSchema, "");
  let doc = value as PortableWorld;
  const added: PortableOmission[] = [];
  const filtered = (
    extensions: Extensions,
    scopeId: string,
    path: string,
  ): Extensions =>
    filterSourceData(extensions, path, (sourcePath, code, message) => {
      added.push({
        scopeId,
        sourcePath,
        code,
        message,
        disposition:
          code === "EMBEDDED_MEDIA_DESCRIPTOR" ? "unmapped" : "unsupported",
        sourceFormat: "portable-rpg-world",
      });
    }) as Extensions;
  const worldExtensions = filtered(
    doc.world.extensions,
    doc.world.id,
    "/world/extensions",
  );
  const documentExtensions = filtered(
    doc.extensions,
    doc.world.id,
    "/extensions",
  );
  const entities = doc.entities.map((entity, i) => {
    const extensions = filtered(
      entity.extensions,
      entity.id,
      `/entities/${i}/extensions`,
    );
    return extensions === entity.extensions
      ? entity
      : { ...entity, extensions };
  });
  if (added.length)
    doc = {
      ...doc,
      world: { ...doc.world, extensions: worldExtensions },
      entities,
      extensions: documentExtensions,
      omissions: [...doc.omissions, ...added],
    };
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const row of [doc.world, ...doc.entities, ...doc.assets]) {
    insist(
      !identities.has(row.id),
      "DUPLICATE_ID",
      "IDs must be unique across world, entities and assets.",
    );
    identities.add(row.id);
  }
  const graphIds = new Set([doc.world.id, ...doc.entities.map((e) => e.id)]);
  const assetIds = new Set(doc.assets.map((a) => a.id));
  for (const row of [doc.world, ...doc.entities])
    for (const target of row.assetIds ?? [])
      insist(
        assetIds.has(target),
        "MISSING_ASSET_REFERENCE",
        `Missing asset ${target}.`,
      );
  for (const entity of doc.entities)
    for (const relation of entity.relations)
      insist(
        graphIds.has(relation.target),
        "UNRESOLVED_REFERENCE",
        `Missing relation target ${relation.target}.`,
      );
  for (const asset of doc.assets) {
    validateAssetRights(asset.rights);
    safePath(asset.path);
    insist(
      asset.path ===
        `assets/${asset.sha256}.${MEDIA_EXTENSIONS[asset.mediaType]}`,
      "INVALID_ASSET_PATH",
      "Asset path must match digest and actual media type.",
    );
    insist(
      !paths.has(asset.path),
      "DUPLICATE_ASSET_PATH",
      "Each manifest entry must have a unique path.",
    );
    paths.add(asset.path);
    if (asset.sourceUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(asset.sourceUrl);
      } catch {
        return insist(
          false,
          "UNSAFE_URL",
          "Invalid asset source URL.",
        ) as never;
      }
      insist(
        ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash,
        "UNSAFE_URL",
        "Asset source URL must not include credentials, query tokens or fragments.",
      );
    }
  }
  return doc;
}
