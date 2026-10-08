import { zipSync } from "fflate";
import {
  convertCdf,
  convertStoryCards,
  convertVoyage,
  object,
} from "./converters.ts";
import { cardFromPng, pngImageBytes, sniffMedia } from "./media.ts";
import {
  budget,
  charge,
  gunzipBounded,
  insist,
  json,
  sha256,
  textBytes,
  unzipBounded,
  utf8,
  WORLD_FILE_LIMITS,
} from "./safety.ts";
import { parsePortableWorld } from "./schema.ts";
import {
  convertCharacterCard,
  convertKanka,
  convertLegendKeeper,
  convertVvd,
  convertWorldAnvilHtml,
} from "./source-adapters.ts";
import type {
  JsonValue,
  ParsedWorld,
  ParseOptions,
  PortableEntity,
  PortableWorld,
} from "./types.ts";

export type * from "./types.ts";
export {
  parsePortableWorld,
  portableWorldSchema,
  validateAssetRights,
  MEDIA_EXTENSIONS,
} from "./schema.ts";
export { WORLD_FILE_LIMITS, WorldFormatError, sha256 } from "./safety.ts";
export { sniffMedia } from "./media.ts";

async function neutral(
  value: unknown,
  files: Record<string, Uint8Array>,
): Promise<ParsedWorld> {
  const document = structuredClone(parsePortableWorld(value));
  const assets: Record<string, Uint8Array> = Object.create(null);
  const missing = new Set<string>();
  for (const asset of document.assets) {
    const bytes = files[asset.path];
    if (!bytes) {
      missing.add(asset.id);
      document.omissions.push({
        scopeId: document.world.id,
        sourcePath: asset.path,
        code: "MISSING_MEDIA_BYTES",
        message:
          "Manifest asset bytes absent in the supplied container. Descriptor retained as unavailable evidence.",
        disposition: "missing",
        sourceFormat: "portable-rpg-world",
      });
      continue;
    }
    insist(
      bytes.length === asset.byteLength,
      "SIZE_MISMATCH",
      "Asset byte length differs from manifest.",
    );
    insist(
      sniffMedia(bytes) === asset.mediaType,
      "MIME_MISMATCH",
      "Asset content MIME differs from manifest.",
    );
    insist(
      (await sha256(bytes)) === asset.sha256,
      "HASH_MISMATCH",
      "Asset SHA-256 differs from manifest.",
    );
    assets[asset.path] = bytes;
  }
  const declared = new Set(document.assets.map((a) => a.path));
  for (const path of Object.keys(files))
    insist(
      path === "world.json" || declared.has(path),
      "UNDECLARED_ARCHIVE_ENTRY",
      "Neutral archives may contain only world.json and manifested asset bytes.",
    );
  if (missing.size) {
    const lost = document.assets.filter((a) => missing.has(a.id));
    const namespace = "org.portable-rpg-world.unavailable-assets";
    const old = document.extensions[namespace];
    const prior = old && Array.isArray(old.descriptors) ? old.descriptors : [];
    document.extensions[namespace] = {
      ...old,
      version: old?.version ?? 1,
      descriptors: [...prior, ...lost] as unknown as JsonValue,
    };
    document.assets = document.assets.filter((a) => !missing.has(a.id));
    for (const row of [document.world, ...document.entities])
      if (row.assetIds)
        row.assetIds = row.assetIds.filter((id) => !missing.has(id));
  }
  return {
    document: parsePortableWorld(document),
    assets,
    sourceFormat: "portable-rpg-world",
  };
}
/** Parse user-supplied files only. No fetch, execution, account access or destination mutation. */
export async function parseWorldFile(
  bytes: Uint8Array,
  filename: string,
  options: ParseOptions = {},
): Promise<ParsedWorld> {
  insist(
    bytes.length > 0 && bytes.length <= WORLD_FILE_LIMITS.fileBytes,
    "LIMIT_EXCEEDED",
    "Input is empty or exceeds the 64 MiB file limit.",
  );
  const b = budget();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    return convertLegendKeeper(json(gunzipBounded(bytes, b)));
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
    return convertCharacterCard(
      cardFromPng(bytes),
      {},
      options.mediaRights,
      options.mediaRights ? pngImageBytes(bytes) : bytes,
    );
  if (
    (bytes[0] === 80 && bytes[1] === 75) ||
    (bytes[0] === 255 && bytes[1] === 216)
  ) {
    const files = unzipBounded(bytes, b);
    if (files["card.json"])
      return convertCharacterCard(
        json(files["card.json"]),
        files,
        options.mediaRights,
      );
    if (
      Object.keys(files).some((p) => /(?:^|\/)\.craft\/project\.json$/.test(p))
    )
      return convertCdf(files, options.mediaRights);
    if (files["info.json"] && files["campaign.json"])
      return convertKanka(files);
    const backups = Object.keys(files).filter((p) => p.endsWith(".vvd"));
    insist(
      backups.length <= 1,
      "AMBIGUOUS_SOURCE",
      "Multiple vvd backups are ambiguous.",
    );
    if (backups.length === 1)
      return convertVvd(
        unzipBounded(files[backups[0]!]!, b, 2),
        files,
        options.mediaRights,
      );
    if (files["world.json"]) {
      const value = object(json(files["world.json"]));
      if (value.format === "portable-rpg-world") return neutral(value, files);
      if (
        files["entity-types.json"] &&
        Object.keys(files).some((p) => p.startsWith("documents/"))
      )
        return convertVvd(files, files, options.mediaRights);
    }
    return insist(
      false,
      "UNRECOGNIZED_ARCHIVE",
      "Unrecognized archive. World Anvil structured JSON/HTML ZIP has no verified supported schema; use its official HTML fallback. No guessed graph is imported.",
    ) as never;
  }
  charge(b, bytes.length, 1);
  const text = utf8(bytes);
  if (/^\s*(?:<!doctype\s+html|<html)\b/i.test(text))
    return convertWorldAnvilHtml(text);
  const value = json(bytes);
  if (Array.isArray(value)) return convertStoryCards(value);
  const raw = object(value);
  if (raw.format === "portable-rpg-world") return neutral(raw, {});
  if (raw.spec === "chara_card_v3")
    return convertCharacterCard(raw, {}, options.mediaRights);
  if (Object.hasOwn(raw, "heroesVersion")) return convertVoyage(raw, filename);
  if (raw.version === 1 && Array.isArray(raw.resources))
    return convertLegendKeeper(raw);
  return insist(
    false,
    "UNRECOGNIZED_SOURCE",
    "Source format is not recognized by documented/observed markers.",
  ) as never;
}
export async function encodeWorldArchive(
  document: PortableWorld,
  assets: Record<string, Uint8Array> = {},
): Promise<Uint8Array> {
  const validated = parsePortableWorld(document);
  const files: Record<string, Uint8Array> = Object.create(null);
  const b = budget();
  const manifest = new Set(validated.assets.map((a) => a.path));
  files["world.json"] = textBytes(JSON.stringify(validated));
  charge(b, files["world.json"].length, 1);
  insist(
    files["world.json"].length <= WORLD_FILE_LIMITS.memberBytes,
    "LIMIT_EXCEEDED",
    "World JSON exceeds limit.",
  );
  for (const asset of validated.assets) {
    const bytes = assets[asset.path];
    insist(
      bytes,
      "MISSING_MEDIA_BYTES",
      "Cannot encode manifested asset without bytes.",
    );
    insist(
      bytes.length === asset.byteLength &&
        (await sha256(bytes)) === asset.sha256,
      "HASH_MISMATCH",
      "Asset size or SHA-256 differs from manifest.",
    );
    insist(
      sniffMedia(bytes) === asset.mediaType,
      "MIME_MISMATCH",
      "Asset content MIME differs from manifest.",
    );
    charge(b, bytes.length, 1);
    files[asset.path] = bytes;
  }
  for (const path of Object.keys(assets))
    insist(
      manifest.has(path),
      "UNDECLARED_ARCHIVE_ENTRY",
      "Asset bytes lack a manifest entry.",
    );
  const archive = zipSync(files, { level: 6 });
  insist(
    archive.length <= WORLD_FILE_LIMITS.fileBytes,
    "LIMIT_EXCEEDED",
    "Encoded archive exceeds file limit.",
  );
  return archive;
}
/** CCv3 JSON exports one character, never a falsely complete world. Source prompts stay inert. */
export function exportCharacterCard(
  entity: PortableEntity,
  world?: PortableWorld,
): object {
  insist(
    entity.kind === "person",
    "INVALID_CHARACTER_CARD",
    "Only person entities can be exported as CCv3.",
  );
  if (world) {
    parsePortableWorld(world);
    insist(
      world.entities.some((e) => e.id === entity.id),
      "INVALID_CHARACTER_CARD",
      "Character is not part of this world.",
    );
  }
  const extension = entity.extensions["org.character-card.v3"];
  const retained = extension?.rawData;
  const card =
    retained &&
    typeof retained === "object" &&
    !Array.isArray(retained) &&
    retained.spec === "chara_card_v3"
      ? (structuredClone(retained) as Record<string, unknown>)
      : { spec: "chara_card_v3", spec_version: "3.0", data: {} };
  const data =
    card.data && typeof card.data === "object" && !Array.isArray(card.data)
      ? (card.data as Record<string, unknown>)
      : {};
  data.name = entity.name;
  data.description = entity.description ?? "";
  for (const field of [
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
    "creator",
    "character_version",
  ])
    if (typeof data[field] !== "string") data[field] = "";
  for (const field of ["alternate_greetings", "group_only_greetings", "tags"])
    if (!Array.isArray(data[field])) data[field] = [];
  data.extensions = {
    ...(data.extensions &&
    typeof data.extensions === "object" &&
    !Array.isArray(data.extensions)
      ? data.extensions
      : {}),
    "org.portable-rpg-world": {
      version: 1,
      portableId: entity.id,
      extensions: structuredClone(entity.extensions),
    },
  };
  // JSON does not embed an archive's binaries; retain safe source descriptors but never pretend local paths are available.
  if (Array.isArray(data.assets))
    data.assets = data.assets.filter((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("uri" in value) ||
        typeof value.uri !== "string"
      )
        return false;
      return !value.uri.startsWith("embeded://");
    });
  card.data = data;
  return card;
}
