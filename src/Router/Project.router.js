import { Router } from "express";
import { verifyJWT } from "../middlewares/auth.middlewares.js";
import { GetAllProjectsFlat, StoreProject } from "../controllers/Project.controller.js";

export const projectRouter = Router();

projectRouter.post("/add",verifyJWT,StoreProject);
projectRouter.get("/projects",verifyJWT,GetAllProjectsFlat);
