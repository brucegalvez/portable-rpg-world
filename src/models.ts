import { insist, utf8 } from "./safety.ts";

/** Independent self-contained geometry parser. No material/include resolution or rendering. */
export function sniffGeometry(
  bytes: Uint8Array,
): "text/plain" | "model/stl" | undefined {
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (count > 0 && count <= 50000 && bytes.length === 84 + count * 50) {
      for (let p = 84; p < bytes.length; p += 50)
        for (let i = 0; i < 12; i++)
          insist(
            Number.isFinite(view.getFloat32(p + i * 4, true)),
            "INVALID_MEDIA",
            "STL contains non-finite geometry.",
          );
      return "model/stl";
    }
  }
  let text: string;
  try {
    text = utf8(bytes);
  } catch {
    return;
  }
  if (/\u0000/.test(text)) return;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (/^solid(?:\s|$)/.test(lines[0] ?? "")) {
    insist(
      /^endsolid(?:\s|$)/.test(lines[lines.length - 1] ?? ""),
      "INVALID_MEDIA",
      "STL ending missing.",
    );
    let p = 1;
    let triangles = 0;
    while (p < lines.length - 1) {
      const facet = /^facet\s+normal\s+(.+)$/.exec(lines[p++] ?? "");
      insist(facet, "INVALID_MEDIA", "Invalid STL facet.");
      const normal = facet[1]!.trim().split(/\s+/);
      insist(
        normal.length === 3 &&
          normal.every((n) => n !== "" && Number.isFinite(Number(n))),
        "INVALID_MEDIA",
        "Invalid STL normal.",
      );
      insist(
        /^outer\s+loop$/.test(lines[p++] ?? ""),
        "INVALID_MEDIA",
        "Invalid STL loop.",
      );
      for (let vertex = 0; vertex < 3; vertex++) {
        const match = /^vertex\s+(.+)$/.exec(lines[p++] ?? "");
        insist(match, "INVALID_MEDIA", "Invalid STL vertex.");
        const coordinates = match[1]!.split(/\s+/);
        insist(
          coordinates.length === 3 &&
            coordinates.every((n) => n !== "" && Number.isFinite(Number(n))),
          "INVALID_MEDIA",
          "Non-finite STL vertex.",
        );
      }
      insist(
        lines[p++] === "endloop" &&
          lines[p++] === "endfacet" &&
          ++triangles <= 50000,
        "INVALID_MEDIA",
        "Invalid or excessive STL facets.",
      );
    }
    insist(
      p === lines.length - 1 && triangles > 0,
      "INVALID_MEDIA",
      "STL has no complete triangles.",
    );
    return "model/stl";
  }
  // Recognize OBJ by actual vertex records, not by filename or generic text MIME.
  if (!lines.some((line) => /^v\s/.test(line))) return;
  let vertices = 0;
  let normals = 0;
  let textures = 0;
  let faces = 0;
  for (const line of lines) {
    const tokens = line.split("#")[0]!.trim().split(/\s+/);
    const directive = tokens[0];
    const values = tokens.slice(1);
    if (
      !directive ||
      directive === "o" ||
      directive === "g" ||
      directive === "s"
    )
      continue;
    if (directive === "v" || directive === "vn" || directive === "vt") {
      insist(
        (directive === "vt"
          ? values.length >= 2 && values.length <= 3
          : values.length === 3) &&
          values.every((n) => n !== "" && Number.isFinite(Number(n))),
        "INVALID_MEDIA",
        "Invalid OBJ coordinates.",
      );
      if (directive === "v") vertices++;
      else if (directive === "vn") normals++;
      else textures++;
      insist(
        vertices <= 50000 && normals <= 50000 && textures <= 50000,
        "LIMIT_EXCEEDED",
        "OBJ geometry exceeds element limits.",
      );
    } else if (directive === "f") {
      insist(
        values.length >= 3 && values.length <= 4 && ++faces <= 50000,
        "INVALID_MEDIA",
        "Invalid or excessive OBJ faces.",
      );
      for (const vertex of values) {
        const refs = vertex.split("/");
        insist(
          refs.length <= 3 &&
            /^[1-9]\d*$/.test(refs[0] ?? "") &&
            Number(refs[0]) <= vertices,
          "INVALID_MEDIA",
          "OBJ vertex reference unresolved.",
        );
        if (refs[1])
          insist(
            /^[1-9]\d*$/.test(refs[1]) && Number(refs[1]) <= textures,
            "INVALID_MEDIA",
            "OBJ texture reference unresolved.",
          );
        if (refs[2])
          insist(
            /^[1-9]\d*$/.test(refs[2]) && Number(refs[2]) <= normals,
            "INVALID_MEDIA",
            "OBJ normal reference unresolved.",
          );
      }
    } else
      insist(
        false,
        "UNSAFE_MEDIA_INCLUDE",
        "Only self-contained OBJ geometry is accepted; material files, includes and extensions are excluded.",
      );
  }
  insist(
    vertices >= 3 && faces > 0,
    "INVALID_MEDIA",
    "OBJ has no complete faces.",
  );
  return "text/plain";
}
