import express from "express";
import { connectToDatabase } from "./src/db/db.js";
import cors from "cors";
import cookieParser from "cookie-parser"

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
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.static("/tmp", { index: false }));

const port = process.env.PORT;


app.get("/", (req, res) => {
    res.status(200).json({ msg: "backend is running" });
});

connectToDatabase().then(() => {
    app.listen(port, () => {
        console.log(`api server is running on port ${port}`)
    })
});

