import express from "express";
import { connectToDatabase } from "./src/db/db.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { githubRouter } from "./src/Router/login.router.js";
import { generateSlug } from "random-word-slugs";
import {
  ECS,
  ECSClient,
  RunTaskCommand,
  RuntimePlatform$,
} from "@aws-sdk/client-ecs";
import { Server } from "socket.io";
import Valkey from "ioredis";
import http from "http";
import logger from "./src/utils/logger.js";
import { projectRouter } from "./src/Router/Project.router.js";
import { User } from "./src/models/user.models.js";
import { verifyJWT } from "./src/middlewares/auth.middlewares.js";
import crypto from "crypto";

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

// github bwehook ci/cd pipeline //
////////////////////////////////////////////
const activeBuilds = new Set();

app.post(
  "/webhook/github",express.raw({ type: "application/json" }),
  async (req, res) => {
    let repoName = "";

    try {
      console.log("🔥 WEBHOOK HIT");

      if (!verifySignature(req)) {
        console.log("❌ Signature failed");
        return res.sendStatus(401);
      }

      const payload = JSON.parse(req.body.toString());

      const repoUrl = payload.repository?.clone_url;
      repoName = payload.repository?.name;
      const branch = payload.ref;

      console.log({ repoName, branch });

      if (!branch?.endsWith("main")) {
  console.log("❌ Not main branch:", branch);
  return res.sendStatus(200);
}

      if (!repoUrl || !repoName) {
        return res.sendStatus(400);
      }

      if (activeBuilds.has(repoName)) {
        return res.sendStatus(200);
      }

      activeBuilds.add(repoName);

      const user = await User.findOne({
        "repos.name": repoName,
      });

      if (!user) return res.sendStatus(404);

      const repo = user.repos.find(r => r.name === repoName);
      const project = repo?.Projects?.slice(-1)[0];

      if (!project) return res.sendStatus(404);

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
                { name: "GIT_REPOSITORY_URL", value: repoUrl },
                { name: "PROJECT_ID", value: project.slug },
                {
                  name: "PROJECT_ENVS",
                  value: JSON.stringify(project.envs || {}),
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

      console.log("🚀 Auto deploy triggered");

      return res.sendStatus(200);

    } catch (error) {
      console.error(error);
      return res.sendStatus(500);

    } finally {
      if (repoName) {
        activeBuilds.delete(repoName);
      }
    }
  }
);

///////////////////////////////////////////

app.use(express.json());
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.static("/tmp", { index: false }));

const port = process.env.PORT;

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

// varify github signature
function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const hmac = crypto.createHmac(
    "sha256",
    process.env.GITHUB_WEBHOOK_SECRET
  );

  const digest =
    "sha256=" +
    hmac.update(req.body).digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(digest)
  );
}

app.use("/auth", githubRouter);
app.use("/api", projectRouter);

app.get("/", (req, res) => {
  res.status(200).json({ msg: "API Service is active.." });
});

app.get("/webhook/github", (req, res) => {
  res.send("Webhook route working");
});


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

const service_url = process.env.REDIS_CONNECTION_STRING;

logger.info({ service_url }, "Redis connection string loaded");

const subscriber = new Valkey(service_url);

/////////////////////////////////////////


app.post("/project", verifyJWT, async (req, res) => {
  try {
    const { gitURL, userSlug, envs, repoName } = req.body;
    const userId = req.user.id;

    // 🔥 Validate required fields
    if (!gitURL || !repoName) {
      return res.status(400).json({ msg: "gitURL and repoName required" });
    }

    logger.info({ gitURL }, "Project creation started");

    // 🔥 STEP 1: Generate slug
    let projectSlug = "";

    if (userSlug) {
      const nameExisted = await User.findOne({
        "repos.Projects.slug": userSlug,
      });

      if (nameExisted) {
        return res.status(409).json({ msg: "Name already exists" });
      }

      projectSlug = userSlug;
    } else {
      projectSlug = generateSlug();
    }

    logger.info({ projectSlug }, "Generated project slug");

    // 🔥 STEP 2: Validate envs
    if (envs && typeof envs !== "object") {
      return res.status(400).json({ msg: "Invalid env format" });
    }

    // 🔥 STEP 3: Store project in DB
    const updateResult = await User.updateOne(
      { _id: userId, "repos.name": repoName },
      {
        $push: {
          "repos.$.Projects": {
            project_url: `https://${projectSlug}.cloud-kit.app`,
            slug: projectSlug,
            repoName,
            envs: envs || {},
          },
        },
      }
    );

    if (updateResult.modifiedCount === 0) {
      return res.status(404).json({ msg: "Repo not found" });
    }

    logger.info({ projectSlug }, "Project stored in DB");

    // 🔥 STEP 4: Trigger ECS task
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

              // 🔥 ENV INJECTION (MOST IMPORTANT)
              {
                name: "PROJECT_ENVS",
                value: JSON.stringify(envs || {}),
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

    // 🔥 STEP 5: Response
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

const LogFunction = async () => {
  console.log("connected");
  subscriber.psubscribe('logs:*')
  subscriber.on('pmessage', (pattern, channel, message) => {
    const parsed = JSON.parse(message);
    io.to(channel).emit("message", parsed.log);
  });
}
LogFunction();

app.use((req, res, next) => {
  logger.info(
    {
      method: req.method,
      url: req.url,
      ip: req.ip,
    },
    "Incoming request",
  );

  next();
});

connectToDatabase().then(() => {
  server.listen(port, () => {
    logger.info({ port }, "Server started");
  });
});
