#!/usr/bin/env -S node --experimental-strip-types
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  encodeWorldArchive,
  exportCharacterCard,
  parseWorldFile,
  validateAssetRights,
  WORLD_FILE_LIMITS,
  WorldFormatError,
} from "../src/index.ts";
import type { AssetRights } from "../src/index.ts";

const usage =
  "Usage: portable-rpg-world inspect INPUT [--rights JSON]\n       portable-rpg-world convert INPUT OUTPUT.zip [--rights JSON]\n       portable-rpg-world character INPUT PERSON_ID OUTPUT.json [--rights JSON]";
try {
  const args = process.argv.slice(2);
  let mediaRights: AssetRights | undefined;
  const rightsAt = args.indexOf("--rights");
  if (rightsAt >= 0) {
    if (!args[rightsAt + 1]) throw new Error(usage);
    mediaRights = validateAssetRights(
      JSON.parse(args[rightsAt + 1]!) as AssetRights,
    );
    args.splice(rightsAt, 2);
  }
  const [command, input, third, fourth] = args;
  if (
    !input ||
    !["inspect", "convert", "character"].includes(command ?? "") ||
    (command === "inspect" && args.length !== 2) ||
    (command === "convert" && args.length !== 3) ||
    (command === "character" && args.length !== 4)
  )
    throw new Error(usage);
  const info = await stat(input);
  if (!info.isFile() || info.size > WORLD_FILE_LIMITS.fileBytes)
    throw new WorldFormatError(
      "LIMIT_EXCEEDED",
      "Input must be a regular file no larger than 64 MiB.",
    );
  const parsed = await parseWorldFile(await readFile(input), basename(input), {
    mediaRights,
  });
  if (command === "inspect") {
    const counts: Record<string, number> = {};
    for (const entity of parsed.document.entities)
      counts[entity.kind] = (counts[entity.kind] ?? 0) + 1;
    console.log(
      JSON.stringify(
        {
          sourceFormat: parsed.sourceFormat,
          title: parsed.document.world.title,
          counts,
          assets: parsed.document.assets,
          omissions: parsed.document.omissions,
          retainedWorldNamespaces: Object.keys(
            parsed.document.world.extensions,
          ),
          retainedDocumentNamespaces: Object.keys(parsed.document.extensions),
        },
        null,
        2,
      ),
    );
  } else if (command === "convert") {
    await writeFile(
      third!,
      await encodeWorldArchive(parsed.document, parsed.assets),
    );
    console.log(
      JSON.stringify({
        output: third,
        entities: parsed.document.entities.length,
        assets: parsed.document.assets.length,
        omissions: parsed.document.omissions.length,
      }),
    );
  } else {
    const entity = parsed.document.entities.find(
      (e) => e.id === third && e.kind === "person",
    );
    if (!entity)
      throw new WorldFormatError(
        "MISSING_CHARACTER",
        "Person ID not present in this file.",
      );
    await writeFile(
      fourth!,
      JSON.stringify(exportCharacterCard(entity, parsed.document), null, 2),
    );
    console.log(JSON.stringify({ output: fourth }));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof WorldFormatError ? error.code : "CLI_ERROR",
      message: error instanceof Error ? error.message : "Conversion failed.",
    }),
  );
  process.exitCode = 1;
}
