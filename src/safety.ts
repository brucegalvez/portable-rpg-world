import { Gunzip, Inflate } from "fflate";

export const WORLD_FILE_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  members: 12000,
  nesting: 2,
  assetBytes: 32 * 1024 * 1024,
  memberBytes: 64 * 1024 * 1024,
  jsonDepth: 80,
  jsonNodes: 2000000,
  compressionRatio: 1000,
});
export class WorldFormatError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorldFormatError";
  }
}
export function fail(code: string, message: string): never {
  throw new WorldFormatError(code, message);
}
export function insist(
  test: unknown,
  code: string,
  message: string,
): asserts test {
  if (!test) fail(code, message);
}
export interface ArchiveBudget {
  expanded: number;
  members: number;
}
export function budget(): ArchiveBudget {
  return { expanded: 0, members: 0 };
}
export function charge(b: ArchiveBudget, bytes: number, members = 0): void {
  b.expanded += bytes;
  b.members += members;
  insist(
    b.expanded <= WORLD_FILE_LIMITS.expandedBytes &&
      b.members <= WORLD_FILE_LIMITS.members,
    "LIMIT_EXCEEDED",
    "Archive exceeds cumulative expanded-byte or member limit.",
  );
}
export function safePath(path: string): string {
  insist(
    path.length > 0 &&
      path.length <= 1024 &&
      !/[\\\u0000-\u001f\u007f]/.test(path) &&
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path),
    "UNSAFE_PATH",
    "Unsafe archive path.",
  );
  const parts = path.replace(/\/$/, "").split("/");
  insist(
    parts.every(
      (p) => p && p !== "." && p !== ".." && !/%(?:2e|2f|5c)/i.test(p),
    ),
    "UNSAFE_PATH",
    "Unsafe or ambiguous archive path.",
  );
  return path;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export const utf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("INVALID_UTF8", "Text is not valid UTF-8.");
  }
};
export const textBytes = (text: string): Uint8Array =>
  new TextEncoder().encode(text);
export function json(bytes: Uint8Array): unknown {
  insist(
    bytes.length <= WORLD_FILE_LIMITS.memberBytes,
    "LIMIT_EXCEEDED",
    "JSON exceeds member limit.",
  );
  const text = utf8(bytes);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const c of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") {
      depth++;
      insist(
        depth <= WORLD_FILE_LIMITS.jsonDepth,
        "LIMIT_EXCEEDED",
        "JSON nesting exceeds limit.",
      );
    } else if (c === "}" || c === "]") depth--;
  }
  try {
    const value: unknown = JSON.parse(text);
    validateJson(value);
    return value;
  } catch (error) {
    if (error instanceof WorldFormatError) throw error;
    return fail("INVALID_JSON", "Invalid JSON document.");
  }
}
export function validateJson(value: unknown): void {
  let nodes = 0;
  function visit(v: unknown, depth: number) {
    insist(
      ++nodes <= WORLD_FILE_LIMITS.jsonNodes &&
        depth <= WORLD_FILE_LIMITS.jsonDepth,
      "LIMIT_EXCEEDED",
      "JSON node or nesting limit exceeded.",
    );
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      insist(Number.isFinite(v), "INVALID_JSON", "Non-finite JSON number.");
      return;
    }
    insist(
      typeof v === "object" && v !== null,
      "INVALID_JSON",
      "Expected JSON data.",
    );
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    insist(
      Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null,
      "INVALID_JSON",
      "Expected plain JSON object.",
    );
    for (const [key, x] of Object.entries(v)) {
      insist(
        !["__proto__", "prototype", "constructor"].includes(key),
        "UNSAFE_JSON_KEY",
        "Unsafe JSON object key.",
      );
      visit(x, depth + 1);
    }
  }
  visit(value, 0);
}
function expand(
  compressed: Uint8Array,
  expected: number,
  gzip: boolean,
): Uint8Array {
  insist(
    expected <= WORLD_FILE_LIMITS.memberBytes &&
      expected <=
        Math.max(
          1024 * 1024,
          compressed.length * WORLD_FILE_LIMITS.compressionRatio,
        ),
    "LIMIT_EXCEEDED",
    "Compressed member exceeds size or ratio limit.",
  );
  const result = new Uint8Array(expected);
  let length = 0;
  const ondata = (chunk: Uint8Array) => {
    insist(
      length + chunk.length <= expected,
      "SIZE_MISMATCH",
      "Expanded bytes exceed declared size.",
    );
    result.set(chunk, length);
    length += chunk.length;
  };
  const stream = gzip ? new Gunzip(ondata) : new Inflate(ondata);
  try {
    for (let p = 0; p < compressed.length; p += 4096)
      stream.push(
        compressed.subarray(p, p + 4096),
        p + 4096 >= compressed.length,
      );
  } catch (error) {
    if (error instanceof WorldFormatError) throw error;
    return fail("INVALID_ARCHIVE", "Invalid compressed stream.");
  }
  insist(
    length === expected,
    "SIZE_MISMATCH",
    "Expanded size does not match declared size.",
  );
  return result;
}
export function gunzipBounded(bytes: Uint8Array, b: ArchiveBudget): Uint8Array {
  insist(bytes.length >= 18, "INVALID_ARCHIVE", "Truncated gzip file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expected = view.getUint32(bytes.length - 4, true);
  charge(b, expected, 1);
  const result = expand(bytes, expected, true);
  insist(
    crc32(result) === view.getUint32(bytes.length - 8, true),
    "CRC_MISMATCH",
    "Gzip integrity check failed.",
  );
  return result;
}
/** Central-directory preflight happens before decompression; cumulative budget spans nested containers. */
export function unzipBounded(
  bytes: Uint8Array,
  b: ArchiveBudget,
  depth = 1,
): Record<string, Uint8Array> {
  insist(
    bytes.length <= WORLD_FILE_LIMITS.fileBytes &&
      depth <= WORLD_FILE_LIMITS.nesting,
    "LIMIT_EXCEEDED",
    "Archive size or nesting exceeds limit.",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) {
      end = p;
      break;
    }
  insist(end >= 0, "INVALID_ARCHIVE", "Missing ZIP end directory.");
  insist(
    u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === u16(end + 10),
    "UNSUPPORTED_ARCHIVE",
    "Split ZIP files are unsupported.",
  );
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const relativeDirectory = u32(end + 16);
  insist(
    count !== 65535 &&
      directorySize !== 0xffffffff &&
      relativeDirectory !== 0xffffffff,
    "UNSUPPORTED_ARCHIVE",
    "ZIP64 is unsupported.",
  );
  const directory = end - directorySize;
  const prefix = directory - relativeDirectory;
  insist(
    directory >= 0 && prefix >= 0,
    "INVALID_ARCHIVE",
    "Invalid ZIP offsets.",
  );
  // Only the documented JPEG-prefix CHARX polyglot may precede a ZIP.
  insist(
    prefix === 0 || (bytes[0] === 0xff && bytes[1] === 0xd8),
    "INVALID_ARCHIVE",
    "Unexpected ZIP prefix.",
  );
  const names = new Set<string>();
  const folded = new Set<string>();
  const spans: [number, number][] = [];
  const entries: {
    name: string;
    start: number;
    size: number;
    expanded: number;
    method: number;
    crc: number;
  }[] = [];
  let p = directory;
  for (let i = 0; i < count; i++) {
    insist(
      p + 46 <= end && u32(p) === 0x02014b50,
      "INVALID_ARCHIVE",
      "Invalid ZIP directory entry.",
    );
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const size = u32(p + 20);
    const expanded = u32(p + 24);
    const nameLength = u16(p + 28);
    const extraLength = u16(p + 30);
    const commentLength = u16(p + 32);
    const offset = u32(p + 42) + prefix;
    insist(
      p + 46 + nameLength + extraLength + commentLength <= end,
      "INVALID_ARCHIVE",
      "Truncated ZIP member metadata.",
    );
    const name = safePath(utf8(bytes.subarray(p + 46, p + 46 + nameLength)));
    const normalized = name.normalize("NFC").toLowerCase().replace(/\/$/, "");
    insist(
      !names.has(name) && !folded.has(normalized),
      "DUPLICATE_ENTRY",
      "Duplicate or ambiguous ZIP member.",
    );
    names.add(name);
    folded.add(normalized);
    insist(
      !(flags & 1) &&
        (method === 0 || method === 8) &&
        u16(p + 34) === 0 &&
        size !== 0xffffffff &&
        expanded !== 0xffffffff,
      "UNSUPPORTED_ARCHIVE",
      "Encrypted, split, ZIP64 or unsupported compression member.",
    );
    const mode = u32(p + 38) >>> 16;
    insist(
      (mode & 0xf000) !== 0xa000,
      "UNSAFE_PATH",
      "ZIP symbolic links are unsupported.",
    );
    insist(
      offset + 30 <= directory && u32(offset) === 0x04034b50,
      "INVALID_ARCHIVE",
      "Invalid ZIP local header.",
    );
    const localNameLength = u16(offset + 26);
    const start = offset + 30 + localNameLength + u16(offset + 28);
    insist(
      start + size <= directory &&
        u16(offset + 8) === method &&
        u16(offset + 6) === flags &&
        utf8(bytes.subarray(offset + 30, offset + 30 + localNameLength)) ===
          name,
      "INVALID_ARCHIVE",
      "Inconsistent ZIP local metadata.",
    );
    if (!(flags & 8))
      insist(
        u32(offset + 14) === crc &&
          u32(offset + 18) === size &&
          u32(offset + 22) === expanded,
        "INVALID_ARCHIVE",
        "Inconsistent ZIP member sizes.",
      );
    spans.push([offset, start + size]);
    charge(b, expanded, 1);
    entries.push({ name, start, size, expanded, method, crc });
    p += 46 + nameLength + extraLength + commentLength;
  }
  insist(p === end, "INVALID_ARCHIVE", "Invalid ZIP directory size.");
  spans.sort((a, c) => a[0] - c[0]);
  for (let i = 1; i < spans.length; i++)
    insist(
      spans[i]![0] >= spans[i - 1]![1],
      "INVALID_ARCHIVE",
      "Overlapping ZIP members.",
    );
  const out: Record<string, Uint8Array> = Object.create(null);
  for (const e of entries) {
    insist(
      e.expanded <= WORLD_FILE_LIMITS.memberBytes,
      "LIMIT_EXCEEDED",
      "ZIP member exceeds limit.",
    );
    const compressed = bytes.subarray(e.start, e.start + e.size);
    const data =
      e.method === 0 ? compressed : expand(compressed, e.expanded, false);
    insist(
      data.length === e.expanded && crc32(data) === e.crc,
      "CRC_MISMATCH",
      "ZIP size or CRC integrity check failed.",
    );
    if (depth === WORLD_FILE_LIMITS.nesting)
      insist(
        !(
          (data[0] === 80 && data[1] === 75) ||
          (data[0] === 0x1f && data[1] === 0x8b)
        ),
        "LIMIT_EXCEEDED",
        "Nested archive exceeds the two-layer limit.",
      );
    if (!e.name.endsWith("/")) out[e.name] = data;
  }
  return out;
}
export function decodeBase64(value: string): Uint8Array {
  insist(
    value.length <= Math.ceil((WORLD_FILE_LIMITS.memberBytes * 4) / 3) + 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    "INVALID_BASE64",
    "Invalid or excessive base64 data.",
  );
  const decoded = atob(value);
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
