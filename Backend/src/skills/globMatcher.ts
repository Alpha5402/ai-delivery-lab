/**
 * 轻量 glob matcher — 不依赖外部库。
 * 支持：
 *   - `*` 单段通配（匹配 / 之外的任意字符）
 *   - `**` 跨目录通配
 *   - 普通字符串精确匹配
 */
export function globToRegex(pattern: string): RegExp {
  let regex = "";
  const parts = pattern.split("**");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      // ** 匹配零或多个路径段：可以没有、可以有一层、可以有多层
      // 用 (.*/)? 表示"可选地匹配任意前缀并以 / 结尾"
      // 但如果 ** 后面没有内容（pattern 以 ** 结尾），直接用 .*
      const isLast = i === parts.length - 1 && parts[i] === "";
      regex += isLast ? ".*" : "(.*/)?";
    }
    let seg = parts[i];
    // 如果前一个 token 是 **，当前段开头的 / 已被 (.*/)? 覆盖，去掉避免要求 double-slash
    if (i > 0 && seg.startsWith("/")) {
      seg = seg.slice(1);
    }
    let escaped = "";
    for (const ch of seg) {
      if (ch === "*") {
        escaped += "[^/]*"; // * → 非 / 任意字符
      } else if (".+^${}()|[]\\".includes(ch)) {
        escaped += "\\" + ch;
      } else {
        escaped += ch;
      }
    }
    regex += escaped;
  }
  return new RegExp(`^${regex}$`);
}

/**
 * 检查 filePath 是否命中 patterns 中的任意一个。
 * 返回命中的 pattern 列表。
 */
export function matchFileGlobs(filePath: string, patterns: string[]): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.filter((p) => globToRegex(p).test(normalized));
}

/**
 * 检查 text 或 filePaths 中是否包含 hint 字符串（case-insensitive）。
 * 返回命中的 hint 列表。
 */
export function matchRouteHints(
  hints: string[],
  sources: { fileTree?: string[]; keyFileNames?: string[]; textCorpus?: string },
): string[] {
  const lowerText = (sources.textCorpus ?? "").toLowerCase();
  const fileNames = new Set((sources.keyFileNames ?? []).map((f) => f.toLowerCase()));
  const paths = new Set((sources.fileTree ?? []).map((f) => f.toLowerCase()));

  return hints.filter((hint) => {
    const lower = hint.toLowerCase();
    // hit in textCorpus, keyFile filename, or fileTree path
    if (lowerText.includes(lower)) return true;
    for (const name of fileNames) {
      if (name.includes(lower)) return true;
    }
    for (const path of paths) {
      if (path.includes(lower)) return true;
    }
    return false;
  });
}
