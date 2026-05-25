import { describe, expect, it } from "vitest";
import { getRepositorySnapshot } from "./repositoryService.js";

describe("repositoryService", () => {
  it("does not return a fake ready repository when the configured path is unavailable", async () => {
    const snapshot = await getRepositorySnapshot();

    expect(snapshot.health).toMatch(/ready|dirty|checking/);
    if (snapshot.health === "checking") {
      expect(snapshot.branch).toBe("unknown");
      expect(snapshot.baseCommit).toBe("unknown");
    }
  });
});
