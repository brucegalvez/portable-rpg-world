import { sniffGeometry } from "./models.ts";
import {
  crc32,
  decodeBase64,
  insist,
  json,
  utf8,
  WORLD_FILE_LIMITS,
} from "./safety.ts";

export function pngChunks(
  bytes: Uint8Array,
): { type: string; bytes: Uint8Array }[] {
  insist(
    bytes.length >= 33 &&
      bytes[0] === 137 &&
      utf8(bytes.subarray(1, 4)) === "PNG" &&
      bytes[4] === 13 &&
      bytes[5] === 10 &&
      bytes[6] === 26 &&
      bytes[7] === 10,
    "INVALID_MEDIA",
    "Invalid PNG signature.",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; bytes: Uint8Array }[] = [];
  let p = 8;
  let ended = false;
  while (p < bytes.length) {
    insist(
      p + 12 <= bytes.length && chunks.length < WORLD_FILE_LIMITS.members,
      "INVALID_MEDIA",
      "Truncated or excessive PNG chunks.",
    );
    const size = view.getUint32(p);
    const type = utf8(bytes.subarray(p + 4, p + 8));
    insist(
      p + 12 + size <= bytes.length && /^[A-Za-z]{4}$/.test(type),
      "INVALID_MEDIA",
      "Invalid PNG chunk.",
    );
    insist(
      crc32(bytes.subarray(p + 4, p + 8 + size)) ===
        view.getUint32(p + 8 + size),
      "CRC_MISMATCH",
      "PNG chunk CRC mismatch.",
    );
    if (chunks.length === 0)
      insist(
        type === "IHDR" &&
          size === 13 &&
          view.getUint32(p + 8) > 0 &&
          view.getUint32(p + 12) > 0,
        "INVALID_MEDIA",
        "Missing PNG image header.",
      );
    chunks.push({ type, bytes: bytes.subarray(p + 8, p + 8 + size) });
    p += 12 + size;
    if (type === "IEND") {
      insist(
        size === 0 && p === bytes.length,
        "INVALID_MEDIA",
        "Invalid PNG ending.",
      );
      ended = true;
      break;
    }
  }
  insist(
    ended && chunks.some((c) => c.type === "IDAT"),
    "INVALID_MEDIA",
    "PNG has no image data or ending.",
  );
  return chunks;
}
export function cardFromPng(bytes: Uint8Array): unknown {
  const cards = pngChunks(bytes).filter(
    (c) =>
      c.type === "tEXt" &&
      c.bytes[0] === 99 &&
      utf8(c.bytes.subarray(0, 5)) === "ccv3\0",
  );
  insist(
    cards.length === 1,
    "INVALID_CHARACTER_CARD",
    "Expected exactly one ccv3 PNG text payload.",
  );
  return json(decodeBase64(utf8(cards[0]!.bytes.subarray(5))));
}
/** Keep image/animation chunks, not embedded card, EXIF, private comments or executable text. */
export function pngImageBytes(bytes: Uint8Array): Uint8Array {
  const chunks = pngChunks(bytes).filter((c) =>
    [
      "IHDR",
      "PLTE",
      "IDAT",
      "IEND",
      "tRNS",
      "acTL",
      "fcTL",
      "fdAT",
      "sRGB",
      "iCCP",
      "gAMA",
      "cHRM",
      "sBIT",
      "pHYs",
      "bKGD",
    ].includes(c.type),
  );
  const result = new Uint8Array(
    8 + chunks.reduce((n, c) => n + c.bytes.length + 12, 0),
  );
  result.set(bytes.subarray(0, 8));
  const view = new DataView(result.buffer);
  let p = 8;
  for (const chunk of chunks) {
    view.setUint32(p, chunk.bytes.length);
    result.set(new TextEncoder().encode(chunk.type), p + 4);
    result.set(chunk.bytes, p + 8);
    view.setUint32(
      p + 8 + chunk.bytes.length,
      crc32(result.subarray(p + 4, p + 8 + chunk.bytes.length)),
    );
    p += chunk.bytes.length + 12;
  }
  return result;
}
export function sniffMedia(bytes: Uint8Array): string {
  insist(
    bytes.length > 0 && bytes.length <= WORLD_FILE_LIMITS.assetBytes,
    "LIMIT_EXCEEDED",
    "Asset exceeds byte limit or is empty.",
  );
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 137 && ascii(1, 4) === "PNG") {
    pngChunks(bytes);
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    insist(
      bytes.length > 4 &&
        bytes[bytes.length - 2] === 0xff &&
        bytes[bytes.length - 1] === 0xd9,
      "INVALID_MEDIA",
      "Invalid JPEG ending (polyglot avatars are not neutral media).",
    );
    return "image/jpeg";
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    insist(
      bytes.length >= 20 &&
        view.getUint32(4, true) + 8 === bytes.length &&
        ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16)),
      "INVALID_MEDIA",
      "Invalid WebP container.",
    );
    return "image/webp";
  }
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
    insist(
      bytes.length >= 14 && bytes[bytes.length - 1] === 0x3b,
      "INVALID_MEDIA",
      "Invalid GIF container.",
    );
    return "image/gif";
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
    insist(
      bytes.length >= 44 && view.getUint32(4, true) + 8 === bytes.length,
      "INVALID_MEDIA",
      "Invalid WAVE container.",
    );
    return "audio/wav";
  }
  if (ascii(0, 4) === "OggS") {
    insist(
      bytes.length >= 27 && bytes[4] === 0,
      "INVALID_MEDIA",
      "Invalid Ogg container.",
    );
    return "audio/ogg";
  }
  if (ascii(0, 4) === "fLaC") {
    insist(
      bytes.length >= 42 && (bytes[4]! & 127) === 0,
      "INVALID_MEDIA",
      "Invalid FLAC stream.",
    );
    return "audio/flac";
  }
  if (
    ascii(0, 3) === "ID3" ||
    (bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0)
  ) {
    insist(bytes.length >= 10, "INVALID_MEDIA", "Truncated MPEG audio.");
    return "audio/mpeg";
  }
  if (["ftyp", "free", "skip"].includes(ascii(4, 8))) {
    let p = 0;
    let fileType = false;
    let movie = false;
    let media = false;
    let boxes = 0;
    while (p < bytes.length) {
      insist(
        p + 8 <= bytes.length && ++boxes <= WORLD_FILE_LIMITS.members,
        "INVALID_MEDIA",
        "Truncated or excessive MP4 boxes.",
      );
      let length = view.getUint32(p);
      const type = ascii(p + 4, p + 8);
      let header = 8;
      if (length === 1) {
        insist(
          p + 16 <= bytes.length,
          "INVALID_MEDIA",
          "Truncated extended MP4 box.",
        );
        const extended = view.getBigUint64(p + 8);
        insist(
          extended <= BigInt(bytes.length - p),
          "INVALID_MEDIA",
          "MP4 box exceeds container.",
        );
        length = Number(extended);
        header = 16;
      } else if (length === 0) length = bytes.length - p;
      insist(
        length >= header && p + length <= bytes.length,
        "INVALID_MEDIA",
        "Invalid MP4 box length.",
      );
      if (type === "ftyp") {
        insist(
          !fileType && length >= header + 8,
          "INVALID_MEDIA",
          "Invalid MP4 file type.",
        );
        const brand = ascii(p + header, p + header + 4);
        insist(
          [
            "isom",
            "iso2",
            "iso3",
            "iso4",
            "iso5",
            "iso6",
            "mp41",
            "mp42",
            "avc1",
            "M4V ",
            "MSNV",
          ].includes(brand),
          "UNSUPPORTED_MEDIA",
          "Unsupported ISO-BMFF media brand.",
        );
        fileType = true;
      } else if (!fileType)
        insist(
          type === "free" || type === "skip",
          "INVALID_MEDIA",
          "MP4 file type must precede content.",
        );
      if (type === "moov") movie = true;
      if (type === "mdat") media = true;
      p += length;
    }
    insist(
      fileType && movie && media,
      "INVALID_MEDIA",
      "MP4 lacks file type, movie metadata or media data.",
    );
    return "video/mp4";
  }
  if (ascii(0, 4) === "glTF") {
    insist(
      bytes.length >= 20 &&
        view.getUint32(4, true) === 2 &&
        view.getUint32(8, true) === bytes.length,
      "INVALID_MEDIA",
      "Invalid GLB container.",
    );
    return "model/gltf-binary";
  }
  const geometry = sniffGeometry(bytes);
  if (geometry) return geometry;
  return insist(
    false,
    "UNSUPPORTED_MEDIA",
    "Unrecognized or unsafe media; SVG, HTML and executable attachments are not bundled.",
  ) as never;
}
