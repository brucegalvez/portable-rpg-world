import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync, zipSync, zlibSync } from "fflate";
import {
  encodeWorldArchive,
  exportCharacterCard,
  parsePortableWorld,
  parseWorldFile,
  sha256,
  sniffMedia,
  WORLD_FILE_LIMITS,
  WorldFormatError,
} from "../src/index.ts";
import type { JsonValue, PortableWorld } from "../src/index.ts";
import { pngChunks } from "../src/media.ts";
import { budget, crc32, textBytes, unzipBounded } from "../src/safety.ts";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  );
}
function files(value: unknown): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, content]) => [
      name,
      textBytes(
        typeof content === "string" ? content : JSON.stringify(content),
      ),
    ]),
  );
}
function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WorldFormatError && error.code === code;
}
function png(extra?: { type: string; bytes: Uint8Array }): Uint8Array {
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 1);
  hv.setUint32(4, 1);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    { type: "IHDR", bytes: header },
    ...(extra ? [extra] : []),
    { type: "IDAT", bytes: zlibSync(new Uint8Array([0, 15, 30, 60, 255])) },
    { type: "IEND", bytes: new Uint8Array() },
  ];
  const result = new Uint8Array(
    8 + chunks.reduce((n, c) => n + c.bytes.length + 12, 0),
  );
  result.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(result.buffer);
  let p = 8;
  for (const c of chunks) {
    view.setUint32(p, c.bytes.length);
    result.set(textBytes(c.type), p + 4);
    result.set(c.bytes, p + 8);
    view.setUint32(
      p + 8 + c.bytes.length,
      crc32(result.subarray(p + 4, p + 8 + c.bytes.length)),
    );
    p += c.bytes.length + 12;
  }
  return result;
}
async function withAsset(): Promise<{
  document: PortableWorld;
  assets: Record<string, Uint8Array>;
}> {
  const document = parsePortableWorld(await fixture("neutral.json"));
  const bytes = png();
  const hash = await sha256(bytes);
  const path = `assets/${hash}.png`;
  document.assets.push({
    id: `asset:${hash}`,
    path,
    sha256: hash,
    byteLength: bytes.length,
    mediaType: "image/png",
    role: "poster",
    rights: { basis: "creator-owned" },
  });
  document.world.assetIds = [document.assets[0]!.id];
  return { document, assets: { [path]: bytes } };
}

test("neutral round trip preserves exact identities, unknown namespaces, relations and omissions", async () => {
  const original = parsePortableWorld(await fixture("neutral.json"));
  const parsed = await parseWorldFile(
    await encodeWorldArchive(original),
    "renamed.zip",
  );
  assert.deepEqual(parsed.document, original);
  assert.equal(parsed.sourceFormat, "portable-rpg-world");
  assert.equal(
    parsed.document.world.extensions["org.example.authoring"]!.sourceKey,
    "Exact / key: Δ",
  );
});
test("neutral verified rights and digest survive without another source-rights prompt", async () => {
  const { document, assets } = await withAsset();
  const parsed = await parseWorldFile(
    await encodeWorldArchive(document, assets),
    "world.zip",
  );
  assert.deepEqual(parsed.document.assets, document.assets);
  assert.deepEqual(Object.entries(parsed.assets), Object.entries(assets));
});
test("hash, length, MIME and path mismatches are rejected", async () => {
  const { document, assets } = await withAsset();
  const bytes = assets[document.assets[0]!.path]!;
  const tampered = structuredClone(document);
  tampered.assets[0]!.sha256 = "a".repeat(64);
  tampered.assets[0]!.path = `assets/${"a".repeat(64)}.png`;
  await assert.rejects(
    parseWorldFile(
      zipSync({
        "world.json": textBytes(JSON.stringify(tampered)),
        [tampered.assets[0]!.path]: bytes,
      }),
      "world.zip",
    ),
    expectCode("HASH_MISMATCH"),
  );
  const wrongMime = structuredClone(document);
  wrongMime.assets[0]!.mediaType = "image/jpeg";
  wrongMime.assets[0]!.path = wrongMime.assets[0]!.path.replace(".png", ".jpg");
  await assert.rejects(
    parseWorldFile(
      zipSync({
        "world.json": textBytes(JSON.stringify(wrongMime)),
        [wrongMime.assets[0]!.path]: bytes,
      }),
      "world.zip",
    ),
    expectCode("MIME_MISMATCH"),
  );
  const wrongLength = structuredClone(document);
  wrongLength.assets[0]!.byteLength++;
  await assert.rejects(
    parseWorldFile(
      zipSync({
        "world.json": textBytes(JSON.stringify(wrongLength)),
        ...assets,
      }),
      "world.zip",
    ),
    expectCode("SIZE_MISMATCH"),
  );
  const wrongPath = structuredClone(document);
  wrongPath.assets[0]!.path = `assets/${"b".repeat(64)}.png`;
  assert.throws(
    () => parsePortableWorld(wrongPath),
    expectCode("INVALID_ASSET_PATH"),
  );
});
test("missing media becomes explicit omissions with original unavailable manifest retained", async () => {
  const { document } = await withAsset();
  const parsed = await parseWorldFile(
    textBytes(JSON.stringify(document)),
    "world.json",
  );
  assert.equal(parsed.document.assets.length, 0);
  assert.deepEqual(parsed.document.world.assetIds, []);
  assert.ok(
    parsed.document.omissions.some((o) => o.code === "MISSING_MEDIA_BYTES"),
  );
  assert.ok(
    parsed.document.extensions["org.portable-rpg-world.unavailable-assets"],
  );
});
test("duplicate identities, dangling targets, non-versioned namespaces and unsafe JSON keys reject", async () => {
  const document = parsePortableWorld(await fixture("neutral.json"));
  const duplicate = structuredClone(document);
  duplicate.entities[0]!.id = document.world.id;
  assert.throws(
    () => parsePortableWorld(duplicate),
    expectCode("DUPLICATE_ID"),
  );
  const missing = structuredClone(document);
  missing.entities[1]!.relations[0]!.target = "missing";
  assert.throws(
    () => parsePortableWorld(missing),
    expectCode("UNRESOLVED_REFERENCE"),
  );
  const invalid = structuredClone(document) as unknown as Record<
    string,
    unknown
  >;
  invalid.extensions = { "org.example.bad": { data: 1 } };
  assert.throws(
    () => parsePortableWorld(invalid),
    expectCode("INVALID_DOCUMENT"),
  );
  await assert.rejects(
    parseWorldFile(textBytes('{"__proto__":{"unsafe":true}}'), "x.json"),
    expectCode("UNSAFE_JSON_KEY"),
  );
});
test("unsupported neutral major version is not detected as a foreign source", async () => {
  const doc = (await fixture("neutral.json")) as Record<string, unknown>;
  doc.version = 2;
  await assert.rejects(
    parseWorldFile(textBytes(JSON.stringify(doc)), "world.json"),
    expectCode("INVALID_DOCUMENT"),
  );
});
test("archive traversal, absolute paths, aliases and ambiguous duplicates reject before conversion", async () => {
  for (const path of [
    "../world.json",
    "/world.json",
    "C:/world.json",
    "a\\world.json",
    "a/%2e%2e/world.json",
    "a//world.json",
  ])
    await assert.rejects(
      parseWorldFile(zipSync({ [path]: textBytes("{}") }), "unsafe.zip"),
      expectCode("UNSAFE_PATH"),
    );
  await assert.rejects(
    parseWorldFile(
      zipSync({ "world.json": textBytes("{}"), "WORLD.JSON": textBytes("{}") }),
      "duplicate.zip",
    ),
    expectCode("DUPLICATE_ENTRY"),
  );
  const z = zipSync(
    { "aa.json": textBytes("{}"), "bb.json": textBytes("{}") },
    { level: 0 },
  );
  for (let p = 0; p < z.length - 7; p++)
    if (
      z[p] === 98 &&
      z[p + 1] === 98 &&
      String.fromCharCode(...z.subarray(p + 2, p + 7)) === ".json"
    ) {
      z[p] = 97;
      z[p + 1] = 97;
    }
  await assert.rejects(
    parseWorldFile(z, "duplicate.zip"),
    expectCode("DUPLICATE_ENTRY"),
  );
});
test("CRC corruption and inconsistent ZIP local metadata reject", async () => {
  const z = zipSync(
    { "world.json": textBytes(JSON.stringify(await fixture("neutral.json"))) },
    { level: 0 },
  );
  const broken = z.slice();
  const view = new DataView(broken.buffer);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  broken[start] = broken[start]! ^ 1;
  await assert.rejects(
    parseWorldFile(broken, "broken.zip"),
    expectCode("CRC_MISMATCH"),
  );
  const badLocal = z.slice();
  new DataView(badLocal.buffer).setUint16(8, 99, true);
  await assert.rejects(
    parseWorldFile(badLocal, "broken.zip"),
    expectCode("INVALID_ARCHIVE"),
  );
});
test("bounded expanded bytes, members, nesting and JSON depth reject", async () => {
  const compressed = gzipSync(
    textBytes(JSON.stringify(await fixture("legendkeeper.json"))),
  );
  const huge = compressed.slice();
  new DataView(huge.buffer).setUint32(
    huge.length - 4,
    WORLD_FILE_LIMITS.memberBytes + 1,
    true,
  );
  await assert.rejects(
    parseWorldFile(huge, "huge.lk"),
    expectCode("LIMIT_EXCEEDED"),
  );
  const z = zipSync({ a: textBytes("x") });
  assert.throws(
    () =>
      unzipBounded(z, {
        expanded: WORLD_FILE_LIMITS.expandedBytes,
        members: 0,
      }),
    expectCode("LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => unzipBounded(z, { expanded: 0, members: WORLD_FILE_LIMITS.members }),
    expectCode("LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => unzipBounded(z, budget(), 3),
    expectCode("LIMIT_EXCEEDED"),
  );
  const deep = zipSync({ "test.vvd": zipSync({ "another.vvd": z }) });
  await assert.rejects(
    parseWorldFile(deep, "deep.zip"),
    expectCode("LIMIT_EXCEEDED"),
  );
  await assert.rejects(
    parseWorldFile(
      textBytes("[".repeat(81) + "0" + "]".repeat(81)),
      "deep.json",
    ),
    expectCode("LIMIT_EXCEEDED"),
  );
});
test("declared expansion cannot bypass actual streamed limit", async () => {
  const z = zipSync({ "world.json": textBytes(" ".repeat(50000)) });
  const view = new DataView(z.buffer);
  view.setUint32(22, 1, true);
  for (let p = 0; p < z.length - 46; p++)
    if (view.getUint32(p, true) === 0x02014b50) {
      view.setUint32(p + 24, 1, true);
      break;
    }
  await assert.rejects(
    parseWorldFile(z, "forged.zip"),
    expectCode("SIZE_MISMATCH"),
  );
});
test("AI Dungeon exports only typed source cards, exact payloads, and incomplete scope", async () => {
  const raw = await fixture("story-cards.json");
  const parsed = await parseWorldFile(
    textBytes(JSON.stringify(raw)),
    "cards.json",
  );
  assert.deepEqual(
    parsed.document.entities.map((e) => e.kind),
    ["place", "person"],
  );
  assert.deepEqual(
    parsed.document.entities[0]!.extensions["com.aidungeon.storycards"]!
      .rawData,
    (raw as unknown[])[0],
  );
  assert.ok(
    parsed.document.omissions.some((o) => o.code === "SOURCE_SCOPE_INCOMPLETE"),
  );
});
test("Voyage name keys remain exact identities and explicit references resolve", async () => {
  const raw = await fixture("voyage.json");
  const parsed = await parseWorldFile(
    textBytes(JSON.stringify(raw)),
    "world.json",
  );
  const place = parsed.document.entities.find((e) => e.kind === "place")!;
  assert.equal(
    place.extensions["io.voyage.export"]!.sourceIdentity,
    "locations/Quay / exact",
  );
  assert.equal(place.relations[0]!.type, "belongsTo");
  assert.equal(
    parsed.document.entities.find((e) => e.kind === "person")!.relations[0]!
      .target,
    place.id,
  );
});
test("CDF baseline copies excluded, Markdown identities retained, typed links preserved", async () => {
  const parsed = await parseWorldFile(
    zipSync(files(await fixture("cdf-files.json"))),
    "cdf.zip",
  );
  assert.equal(parsed.document.entities.length, 3);
  assert.equal(
    parsed.document.entities.find((e) => e.kind === "person")!.relations[0]!
      .type,
    "cdf:location",
  );
  assert.equal(
    parsed.document.entities.find((e) => e.kind === "lore")!.extensions[
      "io.craftrpgs.cdf"
    ]!.sourceIdentity,
    "lore:notes",
  );
  assert.ok(
    parsed.document.omissions.some(
      (o) => o.code === "CDF_SYNC_METADATA_EXCLUDED",
    ),
  );
});
test("private source data and URL credentials/tokens excluded while unknown authored data survives", async () => {
  const raw = (await fixture("cdf-files.json")) as Record<string, unknown>;
  const person = raw["project/Watcher.character.json"] as Record<
    string,
    unknown
  >;
  person.createdBy = "PRIVATE_ACCOUNT";
  person.tracking = { token: "PRIVATE_TRACK" };
  person.customAuthored = { nested: "exact" };
  person.image = { url: "https://example.invalid/picture?token=PRIVATE_TOKEN" };
  raw["project/Notes.lore.md"] =
    "---\nname: Notes\ncredentials:\n  arbitrary: PRIVATE_NESTED\n$craft:\n  referenceId: lore:notes\n---\nSafe writing.";
  const parsed = await parseWorldFile(zipSync(files(raw)), "cdf.zip");
  const serialized = JSON.stringify(parsed.document);
  for (const secret of ["PRIVATE_ACCOUNT", "PRIVATE_TRACK", "PRIVATE_TOKEN", "PRIVATE_NESTED"]) assert.ok(!serialized.includes(secret));
  assert.ok(serialized.includes("customAuthored"));
  assert.ok(
    parsed.document.omissions.some(
      (o) => o.code === "PRIVATE_SOURCE_DATA_REMOVED",
    ),
  );
  assert.ok(serialized.includes("https://example.invalid/picture"));
});
test("LegendKeeper gzip/plain resources preserve resource identities, editor blocks and mentions", async () => {
  const bytes = textBytes(JSON.stringify(await fixture("legendkeeper.json")));
  const plain = await parseWorldFile(bytes, "resource.json");
  const gzip = await parseWorldFile(gzipSync(bytes), "resource.lk");
  assert.deepEqual(gzip, plain);
  assert.equal(
    plain.document.entities[0]!.relations[0]!.target,
    plain.document.entities[1]!.id,
  );
  assert.ok(!JSON.stringify(plain.document).includes("discard-account"));
  assert.ok(!JSON.stringify(plain.document).includes("discard-export-run"));
});
test("Kanka record and generic entity identity domains do not collide", async () => {
  const raw = (await fixture("kanka-files.json")) as Record<string, unknown>;
  const locations = raw["locations/quay.json"] as Record<string, unknown>;
  locations.id = 100;
  const character = raw["characters/watcher.json"] as {
    entity: { entityLocations: { location_id: number }[] };
  };
  character.entity.entityLocations[0]!.location_id = 100;
  const parsed = await parseWorldFile(zipSync(files(raw)), "kanka.zip");
  assert.equal(
    parsed.document.entities[0]!.relations[0]!.target,
    parsed.document.entities[1]!.id,
  );
  assert.ok(parsed.document.entities[1]!.id.includes("locations%2F100"));
});
test("vvd nested backups retain JSON, Markdown, hierarchy, tool payloads and rights-gated media", async () => {
  const inner = zipSync(files(await fixture("vvd-inner-files.json")));
  const source = zipSync({
    "test.vvd": inner,
    "world/watch.md": textBytes("# Watch\nCounts lanterns."),
    "media/beacon.png": png(),
  });
  const restricted = await parseWorldFile(source, "vvd.zip");
  assert.equal(restricted.document.assets.length, 0);
  assert.ok(
    restricted.document.omissions.some(
      (o) => o.disposition === "rights-restricted",
    ),
  );
  const permitted = await parseWorldFile(source, "vvd.zip", {
    mediaRights: { basis: "creator-owned" },
  });
  assert.equal(permitted.document.assets.length, 1);
  assert.equal(permitted.document.entities.length, 2);
  assert.ok(
    permitted.document.entities[0]!.relations.some(
      (r) => r.type === "belongsTo",
    ),
  );
  assert.ok(permitted.document.extensions["world.vvd.export"]!.markdown);
});
test("CCv3 JSON, PNG text, CHARX and JPEG-prefix CHARX preserve one card and lore scope", async () => {
  const card = (await fixture("ccv3.json")) as {
    data: { assets: { uri: string }[] };
  };
  const source = textBytes(JSON.stringify(card));
  const archive = zipSync({
    "card.json": source,
    "assets/icon/main.png": png(),
    "module.risum": textBytes("source application module must not travel"),
  });
  const charx = await parseWorldFile(archive, "card.charx", {
    mediaRights: { basis: "creator-owned" },
  });
  assert.equal(charx.document.assets.length, 1);
  assert.equal(charx.document.entities.length, 2);
  assert.ok(
    charx.document.omissions.some(
      (o) => o.code === "SOURCE_APPLICATION_SOFTWARE_EXCLUDED",
    ),
  );
  const prefix = new Uint8Array([255, 216, 255, 217]);
  const polyglot = new Uint8Array(prefix.length + archive.length);
  polyglot.set(prefix);
  polyglot.set(archive, prefix.length);
  assert.deepEqual(
    (
      await parseWorldFile(polyglot, "card.jpeg", {
        mediaRights: { basis: "creator-owned" },
      })
    ).document,
    charx.document,
  );
  const pngCard = structuredClone(card);
  pngCard.data.assets[0]!.uri = "ccdefault:";
  const payload = textBytes(
    "ccv3\0" + Buffer.from(JSON.stringify(pngCard)).toString("base64"),
  );
  const picture = png({ type: "tEXt", bytes: payload });
  const parsedPng = await parseWorldFile(picture, "card.png", {
    mediaRights: { basis: "creator-owned" },
  });
  assert.equal(parsedPng.document.assets.length, 1);
  assert.ok(
    pngChunks(Object.values(parsedPng.assets)[0]!).every(
      (c) => c.type !== "tEXt",
    ),
  );
  const plain = await parseWorldFile(source, "card.json");
  assert.equal(plain.document.assets.length, 0);
  assert.ok(
    plain.document.omissions.some((o) => o.code === "MISSING_MEDIA_BYTES"),
  );
});
test("mislabelled source media uses actual MIME and retains original descriptor plus omission", async () => {
  const raw = (await fixture("ccv3.json")) as {
    data: { assets: { uri: string; ext: string }[] };
  };
  raw.data.assets[0]!.uri = "embeded://assets/icon/main.webp";
  raw.data.assets[0]!.ext = "webp";
  const parsed = await parseWorldFile(
    zipSync({
      "card.json": textBytes(JSON.stringify(raw)),
      "assets/icon/main.webp": png(),
    }),
    "card.charx",
    {
      mediaRights: {
        basis: "permission",
        attribution: "Original fixture author",
      },
    },
  );
  assert.equal(parsed.document.assets[0]!.mediaType, "image/png");
  assert.ok(parsed.document.assets[0]!.path.endsWith(".png"));
  assert.ok(
    parsed.document.omissions.some(
      (o) => o.code === "SOURCE_MEDIA_TYPE_MISMATCH",
    ),
  );
  assert.ok(
    JSON.stringify(parsed.document.entities[0]!.extensions).includes(
      "main.webp",
    ),
  );
});
test("source-rights attribution requirements enforce explicit media permission", async () => {
  const bytes = zipSync({
    "card.json": textBytes(JSON.stringify(await fixture("ccv3.json"))),
    "assets/icon/main.png": png(),
  });
  const restricted = await parseWorldFile(bytes, "card.charx");
  assert.equal(restricted.document.assets.length, 0);
  assert.ok(
    restricted.document.omissions.some(
      (o) => o.code === "MEDIA_RIGHTS_REQUIRED",
    ),
  );
  await assert.rejects(
    parseWorldFile(bytes, "card.charx", { mediaRights: { basis: "cc-by" } }),
    expectCode("RIGHTS_REQUIRED"),
  );
});
test("World Anvil only accepts observed official HTML fallback, excludes scripts/accounts and never guesses JSON shape", async () => {
  const html =
    '<!DOCTYPE html><html><head><title>World Anvil</title></head><body class="print-interface"><h1 class="world-title">Beacon</h1><span class="world-authors">PRIVATE_ACCOUNT</span><h1>Articles</h1><h1>Timelines</h1><script>PRIVATE_SCRIPT</script></body></html>';
  const parsed = await parseWorldFile(textBytes(html), "world.html");
  assert.equal(parsed.document.entities.length, 0);
  for (const secret of ["PRIVATE_ACCOUNT", "PRIVATE_SCRIPT"]) assert.ok(!JSON.stringify(parsed.document).includes(secret));
  assert.ok(
    parsed.document.omissions.some((o) => o.code === "HTML_GRAPH_UNAVAILABLE"),
  );
  await assert.rejects(
    parseWorldFile(
      zipSync({
        "articles.json": textBytes("[]"),
        "world.html": textBytes(html),
      }),
      "worldanvil.zip",
    ),
    expectCode("UNRECOGNIZED_ARCHIVE"),
  );
});
test("character export changes mapped names without rewriting retained authored evidence", async () => {
  const parsed = await parseWorldFile(
    textBytes(JSON.stringify(await fixture("ccv3.json"))),
    "card.json",
  );
  const person = parsed.document.entities[0]!;
  person.name = "Edited Watcher";
  const card = exportCharacterCard(person, parsed.document) as {
    spec: string;
    data: {
      name: string;
      first_mes: string;
      extensions: Record<string, unknown>;
    };
  };
  const retained = person.extensions["org.character-card.v3"]!.rawData as {
    data: { name: string };
  };
  assert.equal(card.spec, "chara_card_v3");
  assert.equal(card.data.name, "Edited Watcher");
  assert.equal(card.data.first_mes, "Another lantern!");
  assert.equal(retained.data.name, "Watcher");
});
test("Kanka settings can be arrays without pretending they are typed entity objects", async () => {
  const parsed = await parseWorldFile(
    zipSync(files(await fixture("kanka-files.json"))),
    "kanka.zip",
  );
  const metadata = parsed.document.extensions["io.kanka.export"]!
    .metadata as Record<string, unknown>;
  assert.deepEqual(metadata["settings/custom-modules.json"], []);
});
test("neutral extensions filter credentials/tracking on all scopes but preserve inert native source", async () => {
  const document = parsePortableWorld(await fixture("neutral.json"));
  const source = "fetch('https://example.invalid/asset?variant=blue')";
  document.extensions["org.example.private"] = {
    version: 1,
    apiToken: "PRIVATE_TOKEN",
    safe: { exact: "keep" },
  };
  document.world.extensions["org.example.private"] = {
    version: 1,
    sync: { token: "PRIVATE_SYNC" },
    safe: 7,
  };
  document.entities[0]!.extensions["org.example.private"] = {
    version: 1,
    email: "PRIVATE_EMAIL",
    unknown: { id: "source:id" },
  };
  document.world.extensions["ai.believein.studio"] = {
    version: 1,
    sections: {},
    records: [
      {
        id: "native:game",
        kind: "minigame",
        fields: { source, apiKey: "PRIVATE_NATIVE_KEY" },
      },
    ],
  };
  const filtered = parsePortableWorld(document);
  for (const secret of ["PRIVATE_TOKEN", "PRIVATE_SYNC", "PRIVATE_EMAIL", "PRIVATE_NATIVE_KEY"]) assert.ok(!JSON.stringify(filtered).includes(secret));
  assert.ok(JSON.stringify(document).includes("PRIVATE_TOKEN"));
  const native = filtered.world.extensions["ai.believein.studio"]!.records as {
    fields: { source: string };
  }[];
  assert.equal(native[0]!.fields.source, source);
  assert.ok(
    filtered.omissions.some(
      (o) => o.sourcePath === "/extensions/org.example.private/apiToken",
    ),
  );
  assert.ok(
    filtered.omissions.some((o) =>
      o.sourcePath.includes("/entities/0/extensions/"),
    ),
  );
  const again = parsePortableWorld(filtered);
  assert.deepEqual(again, filtered);
});
test("native authored container hosts and opening references survive privacy filtering and archive round trips", async () => {
  const document = parsePortableWorld(await fixture("neutral.json"));
  const records: JsonValue[] = [
    {
      id: "instance:stored",
      kind: "itemInstance",
      fields: {
        itemTypeId: "type:key",
        containerId: "container:chest",
        ownerId: "PRIVATE_OWNER",
        metadata: { containerId: "PRIVATE_NESTED" },
      },
    },
    {
      id: "instance:ground",
      kind: "itemInstance",
      fields: { itemTypeId: "type:key", containerId: null },
    },
    {
      id: "opening:container",
      kind: "startEvent",
      fields: {
        event_type: "CONTAINER_REVEAL",
        location_id: "location:quay",
        displayData: {
          containerId: "container:chest",
          apiToken: "PRIVATE_TOKEN",
        },
      },
    },
    {
      id: "opaque:record",
      kind: "unknown",
      fields: { containerId: "PRIVATE_UNKNOWN" },
    },
    {
      id: "opening:narrator",
      kind: "startEvent",
      fields: {
        event_type: "NARRATOR",
        displayData: {
          content: "Safe narration",
          containerId: "PRIVATE_UNDECLARED",
        },
      },
    },
  ];
  const native: { version: number; [key: string]: JsonValue } = {
    version: 1,
    sections: {},
    records,
    containerId: "PRIVATE_WORKSPACE",
  };
  document.extensions["ai.believein.studio"] = structuredClone(native);
  document.world.extensions["ai.believein.studio"] = structuredClone(native);
  document.entities[0]!.extensions["ai.believein.studio"] =
    structuredClone(native);
  document.extensions["io.craftrpgs.cdf"] = {
    version: 1,
    rawData: { containerId: "PRIVATE_CRAFT_WORKSPACE" },
  };
  const filtered = parsePortableWorld(document);
  const expected = [
    {
      id: "instance:stored",
      kind: "itemInstance",
      fields: {
        itemTypeId: "type:key",
        containerId: "container:chest",
        metadata: {},
      },
    },
    {
      id: "instance:ground",
      kind: "itemInstance",
      fields: { itemTypeId: "type:key", containerId: null },
    },
    {
      id: "opening:container",
      kind: "startEvent",
      fields: {
        event_type: "CONTAINER_REVEAL",
        location_id: "location:quay",
        displayData: { containerId: "container:chest" },
      },
    },
    { id: "opaque:record", kind: "unknown", fields: {} },
    {
      id: "opening:narrator",
      kind: "startEvent",
      fields: {
        event_type: "NARRATOR",
        displayData: { content: "Safe narration" },
      },
    },
  ];
  for (const extensions of [
    filtered.extensions,
    filtered.world.extensions,
    filtered.entities[0]!.extensions,
  ]) {
    assert.deepEqual(extensions["ai.believein.studio"]!.records, expected);
  }
  for (const secret of ["PRIVATE_OWNER", "PRIVATE_NESTED", "PRIVATE_TOKEN", "PRIVATE_UNKNOWN", "PRIVATE_UNDECLARED", "PRIVATE_WORKSPACE", "PRIVATE_CRAFT_WORKSPACE"]) assert.ok(!JSON.stringify(filtered).includes(secret));
  assert.equal(
    document.extensions["ai.believein.studio"]!.containerId,
    "PRIVATE_WORKSPACE",
  );
  assert.ok(
    filtered.omissions.some(
      (o) =>
        o.sourcePath === "/extensions/io.craftrpgs.cdf/rawData/containerId",
    ),
  );
  assert.deepEqual(parsePortableWorld(filtered), filtered);
  const roundTrip = await parseWorldFile(
    await encodeWorldArchive(filtered),
    "world.zip",
  );
  assert.deepEqual(roundTrip.document, filtered);
});
test("OBJ and ASCII/binary STL are real self-contained geometry assets; includes and malformed refs reject", async () => {
  const triangle = textBytes("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  const asciiStl = textBytes(
    "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n",
  );
  const binaryStl = new Uint8Array(134);
  const view = new DataView(binaryStl.buffer);
  view.setUint32(80, 1, true);
  view.setFloat32(92, 1, true);
  view.setFloat32(108, 1, true);
  view.setFloat32(124, 1, true);
  for (const [bytes, mediaType, ext] of [
    [triangle, "text/plain", "obj"],
    [asciiStl, "model/stl", "stl"],
    [binaryStl, "model/stl", "stl"],
  ] as const) {
    const document = parsePortableWorld(await fixture("neutral.json"));
    const hash = await sha256(bytes);
    const path = `assets/${hash}.${ext}`;
    document.assets = [
      {
        id: `asset:${hash}`,
        path,
        sha256: hash,
        byteLength: bytes.length,
        mediaType,
        role: "model",
        rights: { basis: "creator-owned" },
      },
    ];
    const parsed = await parseWorldFile(
      await encodeWorldArchive(document, { [path]: bytes }),
      "model.zip",
    );
    assert.equal(parsed.document.assets[0]!.mediaType, mediaType);
  }
  assert.throws(
    () =>
      sniffMedia(
        textBytes(new TextDecoder().decode(triangle) + "mtllib external.mtl\n"),
      ),
    expectCode("UNSAFE_MEDIA_INCLUDE"),
  );
  assert.throws(
    () => sniffMedia(textBytes("v 0 0 0\nf 1 2 3\n")),
    expectCode("INVALID_MEDIA"),
  );
  assert.throws(
    () =>
      sniffMedia(
        textBytes(
          new TextDecoder()
            .decode(asciiStl)
            .replace("endfacet", "not-endfacet"),
        ),
      ),
    expectCode("INVALID_MEDIA"),
  );
});
