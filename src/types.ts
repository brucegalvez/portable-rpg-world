export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Extensions = Record<
  string,
  { version: number; [key: string]: JsonValue }
>;
export type EntityKind =
  | "place"
  | "person"
  | "item"
  | "group"
  | "lore"
  | "objective"
  | "event";
export interface AssetRights {
  basis: string;
  attribution?: string;
}
export interface PortableAsset {
  id: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  path: string;
  role: string;
  rights: AssetRights;
  sourceUrl?: string;
}
export interface PortableRelation {
  type: string;
  target: string;
}
export interface PortableEntity {
  id: string;
  kind: EntityKind;
  name: string;
  description?: string;
  relations: PortableRelation[];
  assetIds?: string[];
  extensions: Extensions;
}
export interface PortableOmission {
  scopeId: string;
  sourcePath: string;
  code: string;
  message: string;
  disposition:
    | "unmapped"
    | "unsupported"
    | "missing"
    | "external"
    | "rights-restricted"
    | "invalid";
  targetKind?: string;
  sourceFormat?: string;
}
export interface PortableWorld {
  format: "portable-rpg-world";
  version: 1;
  world: {
    id: string;
    title: string;
    description?: string;
    assetIds?: string[];
    extensions: Extensions;
  };
  entities: PortableEntity[];
  assets: PortableAsset[];
  omissions: PortableOmission[];
  extensions: Extensions;
}
export interface ParsedWorld {
  document: PortableWorld;
  assets: Record<string, Uint8Array>;
  sourceFormat: string;
}
export interface ParseOptions {
  mediaRights?: AssetRights;
}
