import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkspaceContext } from "../domain/workspace.js";

export type RouteBindingFact = {
  component: string;
  importerFile: string;
  importSource: string;
  boundFile: string;
};

const routeFileExtensions = [".jsx", ".tsx", ".js", ".ts"];
const routeEntryFileRe = /(^|\/)(main|app|router|routes)\.(jsx?|tsx?)$/i;
const defaultImportRe = /import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+["']([^"']+)["']/g;

export function analyzeRouteBindings(workspace: WorkspaceContext): RouteBindingFact[] {
  const fileSet = new Set(workspace.repositoryScan.fileTree);
  const entryFiles = workspace.repositoryScan.fileTree.filter((file) => routeEntryFileRe.test(file));
  const facts: RouteBindingFact[] = [];

  for (const importerFile of entryFiles) {
    const content = readKnownFile(workspace, importerFile);
    if (!content) continue;

    for (const match of content.matchAll(defaultImportRe)) {
      const component = match[1];
      const importSource = match[2];
      if (!/(routes|pages|views|screens)\//i.test(importSource)) continue;

      const boundFile = resolveImportTarget(workspace, fileSet, importerFile, importSource);
      if (!boundFile) continue;

      facts.push({ component, importerFile, importSource, boundFile });
    }
  }

  return dedupeFacts(facts).slice(0, 40);
}

export function findShadowedRouteBinding(file: string, facts: RouteBindingFact[]) {
  const normalized = normalize(file);
  const parsed = parseRoutePageName(normalized);
  if (!parsed) return null;

  return facts.find((fact) => {
    if (normalize(fact.boundFile) === normalized) return false;
    if (!normalize(fact.boundFile).startsWith(parsed.routeRoot)) return false;
    return fact.component.toLowerCase() === parsed.pageName.toLowerCase()
      || normalize(fact.boundFile).toLowerCase().includes(`/${parsed.pageName.toLowerCase()}/`);
  }) ?? null;
}

function readKnownFile(workspace: WorkspaceContext, file: string) {
  const keyFile = workspace.repositoryScan.keyFiles[file];
  if (keyFile) return keyFile;

  if (!workspace.workspaceDir) return "";
  const absolutePath = path.resolve(workspace.workspaceDir, file);
  const workspaceRoot = path.resolve(workspace.workspaceDir);
  if (!absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) return "";
  if (!existsSync(absolutePath)) return "";

  try {
    return readFileSync(absolutePath, "utf-8").slice(0, 40_000);
  } catch {
    return "";
  }
}

function resolveImportTarget(
  workspace: WorkspaceContext,
  fileSet: Set<string>,
  importerFile: string,
  importSource: string,
) {
  if (!importSource.startsWith(".")) return null;

  const importerDir = path.posix.dirname(normalize(importerFile));
  const base = path.posix.normalize(path.posix.join(importerDir, importSource));
  const candidates = [
    base,
    ...routeFileExtensions.map((ext) => `${base}${ext}`),
    ...routeFileExtensions.map((ext) => `${base}/index${ext}`),
  ];

  return candidates.find((candidate) => (
    fileSet.has(candidate) || Boolean(workspace.workspaceDir && existsSync(path.resolve(workspace.workspaceDir, candidate)))
  )) ?? null;
}

function parseRoutePageName(file: string) {
  const match = normalize(file).match(/^(.*\/(?:routes|pages|views|screens)\/)([^/]+)\.(jsx?|tsx?)$/i);
  if (!match) return null;
  return {
    routeRoot: match[1],
    pageName: match[2],
  };
}

function normalize(file: string) {
  return file.replaceAll("\\", "/");
}

function dedupeFacts(facts: RouteBindingFact[]) {
  return Array.from(new Map(facts.map((fact) => [
    `${fact.component}:${fact.importerFile}:${fact.boundFile}`,
    fact,
  ])).values());
}
