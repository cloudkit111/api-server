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

app.use("/auth", githubRouter);
app.use("/api", projectRouter);

app.get("/", (req, res) => {
  res.status(200).json({ msg: "API Service is active.." });
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

app.post("/project", async (req, res) => {
  try {
    const { gitURL, userSlug } = req.body;

    logger.info({ gitURL }, "Project creation started");

    let projectSlug = ""; // ✅ use let

    if (userSlug) {
 
      const nameExisted = await User.findOne({
        "repos.Projects.slug": userSlug
      });

      if (nameExisted) {
        return res.status(409).json({ msg: "Name already exists" });
      }

      projectSlug = userSlug;
    } else {
      projectSlug = generateSlug();
    }

    logger.info({ projectSlug }, "Generated project slug");

    //   spin container
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
                name: "REDIS_CONNECTION_STRING",
                value:
                  "rediss://default:AVNS_nI6Ca309PlYXB3tIIwY@valkey-2e0f160c-cloudkit111.g.aivencloud.com:28310",
              },
            ],
          },
        ],
      },
    });

    await ecsClient.send(command);

    // 🔥 start fake logs here
    // startFakeLogs(`logs:${projectSlug}`);

    logger.info({ projectSlug }, "Build queued");
    return res.json({
      status: "queued",
      data: { projectSlug, url: `https://${projectSlug}.cloud-kit.app` },
    });
  } catch (error) {
    logger.error({ service_url }, "Redis connection string loaded");
    return res.status(500).json({ error });
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
