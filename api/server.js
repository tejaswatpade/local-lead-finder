import { waitUntil } from "@vercel/functions";
import { handleRequest } from "../src/server.js";

export default function handler(req, res) {
  return handleRequest(req, res, { waitUntil });
}
