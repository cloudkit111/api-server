import mongoose from "mongoose";
import dotenv from "dotenv";
import logger from "../utils/logger.js";

dotenv.config();

const mongo_uri = process.env.MONGODB_URI;

const connectToDatabase = async () => {
  try {
    logger.info("Connecting to database");
    const dbConnection = await mongoose.connect(mongo_uri);
    logger.info({ host: dbConnection.connection.host }, "Database connected");
  } catch (error) {
    logger.error({ error }, "Database connection failed");
    process.exit(0);
  }
};

export { connectToDatabase };
