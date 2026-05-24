export type RepositorySnapshot = {
  name: string;
  branch: string;
  baseCommit: string;
  health: "ready" | "dirty" | "checking";
};
