import express from "express";
import { connectToDatabase } from "./src/db/db.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { githubRouter } from "./src/Router/login.router.js";
import { generateSlug } from "random-word-slugs";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { Server } from "socket.io";
import Valkey from "ioredis";
import http from "http";
import logger from "./src/utils/logger.js";
import { projectRouter } from "./src/Router/Project.router.js";
import { User } from "./src/models/user.models.js";
import { verifyJWT } from "./src/middlewares/auth.middlewares.js";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: ["https://cloud-kit.app", "http://localhost:5173"] },
});

const corsOptions = {
    origin: ["https://cloud-kit.app", "http://localhost:5173"],
    credentials: true,
    methods: "GET, POST, DELETE, PATCH, HEAD, PUT, OPTIONS",
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Access-Control-Allow-Credentials",
        "cache-control",
        "svix-id",
        "svix-timestamp",
        "svix-signature",
    ],
    exposedHeaders: ["Authorization"],
};

//////////////////// Helper function for GitHub App ////////////////////
async function getInstallationOctokit(installationId) {
    const auth = createAppAuth({
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId,
    });
    const { token } = await auth({ type: "installation" });
    return new Octokit({ auth: token });
}

//////////////////// ECS Client ////////////////////
const ecsClient = new ECSClient({
    region: "ap-south-1",
    credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_KEY,
    },
});

const CONFIG = {
    CLUSTER: "arn:aws:ecs:ap-south-1:320524884162:cluster/builder-cluster",
    TASK: "arn:aws:ecs:ap-south-1:320524884162:task-definition/builder-task",
};

//////////////////// Webhook CI/CD ////////////////////
const activeBuilds = new Set();

app.post(
    "/webhook/github",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        let repoId = null;

        try {
            console.log("🔥 WEBHOOK HIT");

            // ✅ STEP 1: Verify signature
            const signature = req.headers["x-hub-signature-256"];
            if (!signature) {
                console.log("❌ No signature header");
                return res.sendStatus(401);
            }

            const hmac = crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET);
            const digest = "sha256=" + hmac.update(req.body).digest("hex");

            const sigBuf = Buffer.from(signature);
            const digestBuf = Buffer.from(digest);

            if (sigBuf.length !== digestBuf.length || !crypto.timingSafeEqual(sigBuf, digestBuf)) {
                console.log("❌ Signature mismatch", {
                    sigLen: sigBuf.length,
                    digestLen: digestBuf.length,
                    secretSet: !!process.env.GITHUB_WEBHOOK_SECRET,
                    secretLength: process.env.GITHUB_WEBHOOK_SECRET?.length,
                });
                return res.sendStatus(401);
            }

            console.log("✅ Signature verified");

            // ✅ STEP 2: Parse payload
            const payload = JSON.parse(req.body.toString());

            repoId = Number(payload.repository?.id);
            const repoUrl = payload.repository?.clone_url;
            const branch = payload.ref;
            const repoName = payload.repository?.name;
            const sender = payload.sender?.login;

            // 🔍 DEBUG: log what GitHub is sending
            console.log("📦 Webhook payload:", {
                repoId,
                repoName,
                repoUrl,
                branch,
                sender,
            });

            // ✅ Only deploy main branch
            if (branch !== "refs/heads/main") {
                console.log(`⏭️ Skipping branch: ${branch}`);
                return res.sendStatus(200);
            }

            if (!repoId || !repoUrl) {
                console.log("❌ Missing repoId or repoUrl");
                return res.sendStatus(400);
            }

            // ✅ Prevent duplicate builds
            if (activeBuilds.has(repoId)) {
                console.log("⚠️ Build already running for repoId:", repoId);
                return res.sendStatus(200);
            }

            activeBuilds.add(repoId);

            // 🔍 DEBUG: check what's actually in the DB before querying
            const allUsers = await User.find(
                { "repos.0": { $exists: true } },
                { email: 1, "repos.name": 1, "repos.repoId": 1 }
            ).lean();

            console.log("🗄️ All users with repos in DB:");
            allUsers.forEach(u => {
                u.repos.forEach(r => {
                    console.log(`  user=${u.email} | repo=${r.name} | repoId=${r.repoId} | type=${typeof r.repoId}`);
                });
            });

            // ✅ STEP 3: Find user by repoId
            // Try Number match first, then String match as fallback
            let user = await User.findOne({ "repos.repoId": repoId });

            if (!user) {
                console.log(`⚠️ Number match failed for repoId: ${repoId}, trying string match...`);
                // Fallback: try string match in case repoId was saved as string
                user = await User.findOne({ "repos.repoId": String(repoId) });
            }

            if (!user) {
                console.log(`❌ No user found for repoId: ${repoId} (tried both Number and String)`);
                return res.sendStatus(404);
            }

            console.log(`✅ User found: ${user.email}`);

            // ✅ Bug 1 fix: cast both sides when finding repo
            const repo = user.repos.find(r => Number(r.repoId) === repoId);

            if (!repo) {
                console.log(`❌ Repo not found in user.repos for repoId: ${repoId}`);
                return res.sendStatus(404);
            }

            const project = repo?.Projects?.slice(-1)[0];

            if (!project) {
                console.log(`❌ No project found for repo: ${repo.name}`);
                return res.sendStatus(404);
            }

            console.log(`✅ Project found: slug=${project.slug}`);

            // ✅ STEP 4: Trigger ECS build
            const command = new RunTaskCommand({
                cluster: CONFIG.CLUSTER,
                taskDefinition: CONFIG.TASK,
                launchType: "FARGATE",
                count: 1,
                networkConfiguration: {
                    awsvpcConfiguration: {
                        assignPublicIp: "ENABLED",
                        subnets: [
                            "subnet-030ec22e04300ec0b",
                            "subnet-0689bf932718d6641",
                            "subnet-0b7070c717b0d1cfe",
                        ],
                        securityGroups: ["sg-004a16e50dcc52dfe"],
                    },
                },
                overrides: {
                    containerOverrides: [{
                        name: "builder-image",
                        environment: [
                            { name: "GIT_REPOSITORY_URL", value: repoUrl },
                            { name: "PROJECT_ID", value: project.slug },
                            // ✅ Bug 5 fix: Mongoose Map → plain object before stringify
                            {
                                name: "PROJECT_ENVS",
                                value: JSON.stringify(
                                    project.envs instanceof Map
                                        ? Object.fromEntries(project.envs)
                                        : (project.envs || {})
                                ),
                            },
                            {
                                name: "REDIS_CONNECTION_STRING",
                                value: process.env.REDIS_CONNECTION_STRING,
                            },
                        ],
                    }],
                },
            });

            await ecsClient.send(command);

            console.log(`🚀 Auto deploy triggered for ${repo.name} → ${project.slug}`);
            return res.sendStatus(200);

        } catch (error) {
            console.error("❌ Webhook error:", error);
            return res.sendStatus(500);
        } finally {
            if (repoId) activeBuilds.delete(repoId);
        }
    }
);

//////////////////// Middleware ////////////////////
app.use(express.json());
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.static("/tmp", { index: false }));

const port = process.env.PORT || 3000;

app.use("/auth", githubRouter);
app.use("/api", projectRouter);

app.get("/", (req, res) => {
    res.status(200).json({ msg: "API Service is active.." });
});

//////////////////// GitHub App Installation ////////////////////
app.post("/api/save-installation", verifyJWT, async (req, res) => {
    try {
        const { installationId } = req.body;

        const parsedId = Number(installationId);

        if (!parsedId || isNaN(parsedId)) {
            return res.status(400).json({ error: "Invalid installationId" });
        }

        await User.findByIdAndUpdate(req.user.id, {
            installationId: parsedId,
        });

        return res.json({ success: true });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to save installation" });
    }
});

//////////////////// Socket.IO ////////////////////
io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "Client connected");

    socket.on("subscribe", (channel) => {
        socket.join(channel);
        logger.info({ socketId: socket.id, channel }, "Client subscribed");
        socket.emit("message", `Joined ${channel}`);
    });

    socket.on("disconnect", () => {
        logger.info({ socketId: socket.id }, "Client disconnected");
    });
});

//////////////////// Redis Log Subscriber ////////////////////
const service_url = process.env.REDIS_CONNECTION_STRING;
logger.info({ service_url }, "Redis connection string loaded");

const subscriber = new Valkey(service_url);

const LogFunction = async () => {
    console.log("Redis subscriber connected");
    subscriber.psubscribe("logs:*");
    subscriber.on("pmessage", (pattern, channel, message) => {
        const parsed = JSON.parse(message);
        io.to(channel).emit("message", parsed.log);
    });
};
LogFunction();

//////////////////// Project Deployment ////////////////////
app.post("/project", verifyJWT, async (req, res) => {
    try {
        const { gitURL, userSlug, envs, repoName } = req.body;
        const userId = req.user.id;

        if (!gitURL || !repoName) {
            return res.status(400).json({ msg: "gitURL and repoName required" });
        }

        logger.info({ gitURL }, "Project creation started");

        // STEP 1: Generate slug
        let projectSlug = "";
        let existingProject = null;

        if (userSlug) {
            // Check if project with this slug already exists
            const user = await User.findOne({
                _id: userId,
                "repos.name": repoName,
                "repos.Projects.slug": userSlug,
            });

            if (user) {
                // Existing project found - this is a redeploy
                const repo = user.repos.find(r => r.name === repoName);
                existingProject = repo?.Projects?.find(p => p.slug === userSlug);
            } else {
                // New project - check if slug is taken by someone else
                const nameExisted = await User.findOne({
                    "repos.Projects.slug": userSlug,
                });

                if (nameExisted) {
                    return res.status(409).json({ msg: "Name already exists" });
                }
            }

            projectSlug = userSlug;
        } else {
            projectSlug = generateSlug();
        }

        logger.info({ projectSlug }, "Generated project slug");

        if (envs && typeof envs !== "object") {
            return res.status(400).json({ msg: "Invalid env format" });
        }

        // Determine final envs: use from body if provided, otherwise use existing
        const finalEnvs = envs !== undefined ? envs : (existingProject?.envs || {});

        // STEP 2: Store project in DB
        if (existingProject) {
            // Update existing project
            await User.updateOne(
                { 
                    _id: userId, 
                    "repos.name": repoName,
                    "repos.Projects.slug": projectSlug
                },
                {
                    $set: {
                        "repos.$[repo].Projects.$[project].updatedAt": new Date(),
                    },
                },
                {
                    arrayFilters: [
                        { "repo.name": repoName },
                        { "project.slug": projectSlug }
                    ]
                }
            );
        } else {
            // Create new project
            const updateResult = await User.updateOne(
                { _id: userId, "repos.name": repoName },
                {
                    $push: {
                        "repos.$.Projects": {
                            project_url: `https://${projectSlug}.cloud-kit.app`,
                            slug: projectSlug,
                            repoName,
                            envs: finalEnvs,
                        },
                    },
                }
            );

            if (updateResult.modifiedCount === 0) {
                return res.status(404).json({ msg: "Repo not found" });
            }
        }

        logger.info({ projectSlug }, "Project stored in DB");

        // STEP 3: Trigger ECS task
        const command = new RunTaskCommand({
            cluster: CONFIG.CLUSTER,
            taskDefinition: CONFIG.TASK,
            launchType: "FARGATE",
            count: 1,
            networkConfiguration: {
                awsvpcConfiguration: {
                    assignPublicIp: "ENABLED",
                    subnets: [
                        "subnet-030ec22e04300ec0b",
                        "subnet-0689bf932718d6641",
                        "subnet-0b7070c717b0d1cfe",
                    ],
                    securityGroups: ["sg-004a16e50dcc52dfe"],
                },
            },
            overrides: {
                containerOverrides: [
                    {
                        name: "builder-image",
                        environment: [
                            { name: "GIT_REPOSITORY_URL", value: gitURL },
                            { name: "PROJECT_ID", value: projectSlug },
                            {
                                name: "PROJECT_ENVS",
                                value: JSON.stringify(finalEnvs),
                            },
                            {
                                name: "REDIS_CONNECTION_STRING",
                                value: process.env.REDIS_CONNECTION_STRING,
                            },
                        ],
                    },
                ],
            },
        });

        await ecsClient.send(command);
        logger.info({ projectSlug }, "Build queued");

        return res.status(200).json({
            status: "queued",
            data: {
                projectSlug,
                url: `https://${projectSlug}.cloud-kit.app`,
            },
        });

    } catch (error) {
        logger.error(error, "Project creation failed");
        return res.status(500).json({
            msg: "Internal server error",
            error: error.message,
        });
    }
});

//////////////////// Request Logger ////////////////////
app.use((req, res, next) => {
    logger.info(
        { method: req.method, url: req.url, ip: req.ip },
        "Incoming request"
    );
    next();
});

//////////////////// Start Server ////////////////////
connectToDatabase().then(() => {
    server.listen(port, () => {
        logger.info({ port }, "Server started");
    });
});
