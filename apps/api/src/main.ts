import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { loadConfig, type AppConfig } from "./config.js";
import { makeServer } from "./server.js";

let config: AppConfig | undefined;
try {
  config = loadConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : "Could not start.";
  console.error(message);
  process.exitCode = 1;
}

if (config !== undefined) {
  console.log(`Intake API listening on http://${config.host}:${config.port}`);
  NodeRuntime.runMain()(Layer.launch(makeServer(config)));
}
