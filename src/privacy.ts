import type { JsonValue } from "./types.ts";

export const PRIVATE_SOURCE_KEY =
  /^(?:__proto__|constructor|prototype|(?:access|refresh|api|auth|session)[_-]?(?:token|key)|password|secret|credentials?|cookies?|email|phone|permissions?|accounts?|users?|members|owner(?:[_-]?id)?|user[_-]?id|creator[_-]?id|created[_-]?by|updated[_-]?by|deleted[_-]?by|created[_-]?at|updated[_-]?at|deleted[_-]?at|creation_date|modification_date|exportId|exportedAt|export_id|exported_at|tracking|analytics|telemetry|billing|onboarding_widget|campaign_id|remote|projectId|containerId|clonedAt|sync|syncMetadata|accessLevel|userType)$/i;
export type PrivacyReport = (
  path: string,
  code: string,
  message: string,
) => void;
const NATIVE_RECORD_PATH =
  /^(?:\/extensions|\/world\/extensions|\/entities\/\d+\/extensions)\/ai\.believein\.studio\/records\/\d+$/;
const NATIVE_RECORD_FIELDS_PATH =
  /^(?:\/extensions|\/world\/extensions|\/entities\/\d+\/extensions)\/ai\.believein\.studio\/records\/\d+\/fields$/;
/** Called only after JSON validation. Copy on change, preserving every safe unknown value exactly. */
export function filterSourceData(
  value: JsonValue,
  path: string,
  report: PrivacyReport,
  nativeSource = false,
  authoredContainerFields = false,
): JsonValue {
  if (typeof value === "string") {
    // Native authored source is inert code. Never silently rewrite its literal URLs or semantics.
    if (nativeSource) return value;
    if (/^data:[^,\s]*,/i.test(value)) {
      report(
        path,
        "EMBEDDED_MEDIA_DESCRIPTOR",
        "Inline binary is represented separately, not retained in authored JSON.",
      );
      return {
        embedded: true,
        declaredMediaType: value.slice(
          5,
          value.indexOf(";") >= 0 ? value.indexOf(";") : value.indexOf(","),
        ),
      };
    }
    let changed = false;
    const text = value.replace(/https?:\/\/[^\s<>"')]+/g, (candidate) => {
      try {
        const url = new URL(candidate);
        if (url.username || url.password) {
          changed = true;
          return "[private URL removed]";
        }
        if (url.search || url.hash) {
          changed = true;
          url.search = "";
          url.hash = "";
          return url.toString();
        }
      } catch {
        return candidate;
      }
      return candidate;
    });
    if (changed)
      report(
        path,
        "PRIVATE_URL_DATA_REMOVED",
        "URL credentials, query or fragment data removed from preserved content.",
      );
    return text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const values = value.map((v, i) =>
      filterSourceData(v, `${path}/${i}`, report, nativeSource),
    );
    return values.some((v, i) => v !== value[i]) ? values : value;
  }
  let result = value;
  for (const [key, v] of Object.entries(value)) {
    // Craft's workspace containerId is private sync metadata; Studio's declared
    // item host and opening-event argument are authored graph references.
    const authoredContainerId =
      authoredContainerFields &&
      key === "containerId" &&
      (typeof v === "string" || v === null);
    if (PRIVATE_SOURCE_KEY.test(key) && !authoredContainerId) {
      if (result === value) result = { ...value };
      delete result[key];
      report(
        `${path}/${key}`,
        "PRIVATE_SOURCE_DATA_REMOVED",
        "Account, access, tracking or synchronization data intentionally excluded.",
      );
      continue;
    }
    const inertNativeSource =
      nativeSource ||
      (key === "source" && path.includes("/ai.believein.studio/"));
    const containerFields =
      (key === "fields" &&
        value.kind === "itemInstance" &&
        NATIVE_RECORD_PATH.test(path)) ||
      (key === "displayData" &&
        value.event_type === "CONTAINER_REVEAL" &&
        NATIVE_RECORD_FIELDS_PATH.test(path));
    const filtered = filterSourceData(
      v,
      `${path}/${key}`,
      report,
      inertNativeSource,
      containerFields,
    );
    if (filtered !== v) {
      if (result === value) result = { ...value };
      result[key] = filtered;
    }
  }
  return result;
}
