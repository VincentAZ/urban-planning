import { spawn } from "node:child_process";
import { ApiError } from "./errors.js";

/** A failed daemon command is uncertainty, not proof of process termination. */
export async function confirmDockerContainerAbsent(
  container: string,
): Promise<void> {
  if (!/^urban-[a-z0-9-]+$/.test(container))
    throw new Error("Invalid native container identity.");
  const confirmed = await new Promise<boolean>((resolve) => {
    const child = spawn(
      "docker",
      [
        "ps",
        "--all",
        "--filter",
        `name=^/${container}$`,
        "--format",
        "{{.Names}}",
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      consume(chunk);
      output += chunk.toString();
    });
    child.stderr.on("data", consume);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && bytes <= 65536 && output.trim() === "");
    });
  });
  if (!confirmed)
    throw new ApiError(
      503,
      "NATIVE_CLEANUP_UNCONFIRMED",
      "The native process may still be running. Shared capacity remains blocked until an operator confirms termination.",
    );
}
