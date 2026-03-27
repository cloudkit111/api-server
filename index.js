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

const app = express();

const corsOptions = {
  origin: "*",
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

app.get("/", (req, res) => {
  res.status(200).json({ msg: "API Service is active.." });
});


// socket io and ioredis config /////////
const io = new Server({cors : { origin : "*"}});

io.listen(9001,() => {
  console.log(`socket is running on port ${port} `)
})

io.on('connection', (socket) => {
   socket.on('subscribe' , channel => {
      socket.join(channel);
      socket.emit("message", `joined ${channel}`)
   })
});


const service_url = process.env.REDIS_CONNECTION_STRING;

console.log(service_url)

const subscriber = new Valkey(service_url);

/////////////////////////////////////////

app.post("/project", async (req,res) => {
  try{
  const { gitURL } = req.body;
  const projectSlug = generateSlug();

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
            {name:"REDIS_CONNECTION_STRING",value:"rediss://default:AVNS_nI6Ca309PlYXB3tIIwY@valkey-2e0f160c-cloudkit111.g.aivencloud.com:28310"}
          ],
        },
      ],
    },
  });

  await ecsClient.send(command);
  return res.json({
    status: "queued",
    data: { projectSlug, url: `http://${projectSlug}.localhost:8000` },
  });
  } catch(error){
    console.log(error)
    return res.status(500).json({error})
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

connectToDatabase().then(() => {
  app.listen(port, () => {
    console.log(`api server is running on port ${port}`);
  });
});
