export type JsonValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

export function parseJson(value: string): JsonValidationResult {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "JSON 解析失败",
    };
  }
}

export function hasRequiredKeys(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}
