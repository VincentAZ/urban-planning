import { mediaServiceFromEnvironment } from "./media-config.js";
import { buildApp } from "./app.js";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { identityMailFromEnvironment } from "./identity-mail.js";
if (existsSync(".env")) loadEnvFile(".env");
const app = await buildApp({
  logger: true,
  identityMailFactory: identityMailFromEnvironment,
  mediaServiceFactory: mediaServiceFromEnvironment,
});
const stop = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await app.listen({
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? "127.0.0.1",
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
