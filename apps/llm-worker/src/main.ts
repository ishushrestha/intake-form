import { loadWorkerConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { runWorker } from "./run.js";

try {
  loadEnvFile();
  const config = loadWorkerConfig();
  console.log(`[worker] intake ${config.intakeApiUrl}`);
  console.log(`[worker] records ${config.recordsApiUrl}`);
  console.log(`[worker] ollama ${config.ollamaModel} at ${config.ollamaUrl}`);
  console.log(`[worker] polling every ${config.pollSeconds}s. This process does not listen on a port.`);
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
  });
  process.on("SIGTERM", () => {
    controller.abort();
  });
  await runWorker({
    config,
    signal: controller.signal,
    log: (message) => {
      console.log(message);
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Could not start.";
  console.error(`[worker] ${message}`);
  process.exitCode = 1;
}
