import { Router } from "express";
import { getCurrentUser, githubLogin, logout } from "../controllers/login.controller.js";
import { verifyJWT } from "../middlewares/auth.middlewares.js";

export const githubRouter = Router();

githubRouter.route("/callback").get(githubLogin);
githubRouter.get("/me", verifyJWT, getCurrentUser);
githubRouter.get("/logout",logout)