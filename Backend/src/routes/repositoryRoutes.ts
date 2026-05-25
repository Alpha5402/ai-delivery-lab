import { Router } from "express";
import { getRepositorySnapshot } from "../services/repositoryService.js";

export const repositoryRoutes = Router();

repositoryRoutes.get("/", async (_req, res) => {
  res.json(await getRepositorySnapshot());
});

