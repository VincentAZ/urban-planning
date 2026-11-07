import { afterEach, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSmtpIdentityTransport } from "./identity-mail.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function smtp(
  options: { startTls?: boolean; stall?: boolean } = { startTls: true },
) {
  const directory = await mkdtemp(join(tmpdir(), "urban-local-smtp-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(certPath, "utf8"),
    key = await readFile(keyPath, "utf8");
  const secureContext = createSecureContext({ key, cert }),
    connections = new Set<Socket>(),
    received: string[] = [],
    commands: string[] = [];
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    if (options.stall) return;
    const attach = (stream: Socket, encrypted: boolean) => {
      let buffer = "",
        data: string[] | undefined;
      const consume = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\r\n")) {
          const end = buffer.indexOf("\r\n"),
            line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data) {
            if (line === ".") {
              received.push(data.join("\r\n"));
              data = undefined;
              stream.write("250 queued locally\r\n");
            } else data.push(line);
            continue;
          }
          const command = line.split(" ")[0];
          commands.push(command);
          if (command === "EHLO")
            stream.write(
              `250-localhost\r\n250-${encrypted ? "AUTH PLAIN" : "SIZE 200000"}\r\n${!encrypted && options.startTls ? "250-STARTTLS\r\n" : ""}250 OK\r\n`,
            );
          else if (command === "STARTTLS" && options.startTls) {
            stream.removeListener("data", consume);
            stream.write("220 ready for TLS\r\n");
            const secure = new TLSSocket(stream, {
              isServer: true,
              secureContext,
            });
            secure.on("error", () => {});
            attach(secure, true);
            return;
          } else if (command === "AUTH" && encrypted)
            stream.write("235 authenticated\r\n");
          else if (command === "MAIL" || command === "RCPT")
            stream.write("250 OK\r\n");
          else if (command === "DATA") {
            data = [];
            stream.write("354 end with dot\r\n");
          } else if (command === "QUIT") stream.end("221 bye\r\n");
          else stream.write("500 unsupported\r\n");
        }
      };
      stream.on("data", consume);
    };
    attach(socket, false);
    socket.write("220 localhost isolated SMTP test\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local SMTP did not bind.");
  const transport = createSmtpIdentityTransport({
    host: "localhost",
    port: address.port,
    from: "sender@example.test",
    origin: "https://app.example.test",
    user: "fixture",
    password: "fixture-only",
    ca: cert,
  });
  cleanup.push(async () => transport.close?.());
  return { transport, received, commands, connections };
}
it("sends one bounded message over verified STARTTLS to a local-only SMTP server", async () => {
  const f = await smtp();
  await f.transport.send(
    {
      to: "recipient@example.test",
      subject: "Local integration test",
      text: "Synthetic local-only body",
    },
    randomUUID(),
    new AbortController().signal,
  );
  expect(f.commands.filter((c) => c === "STARTTLS")).toHaveLength(1);
  expect(f.commands.filter((c) => c === "RCPT")).toHaveLength(1);
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toContain("Synthetic local-only body");
});
it("refuses plaintext delivery when the SMTP endpoint cannot negotiate TLS", async () => {
  const f = await smtp({ startTls: false });
  await expect(
    f.transport.send(
      { to: "recipient@example.test", subject: "Test", text: "Private body" },
      randomUUID(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("rejected");
  expect(f.commands).not.toContain("AUTH");
  expect(f.commands).not.toContain("MAIL");
  expect(f.received).toHaveLength(0);
});
it("closes the actual socket when a stalled delivery is cancelled", async () => {
  const f = await smtp({ stall: true }),
    controller = new AbortController();
  const delivery = f.transport.send(
    { to: "recipient@example.test", subject: "Test", text: "Private body" },
    randomUUID(),
    controller.signal,
  );
  const assertion = expect(delivery).rejects.toThrow("not confirmed");
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await assertion;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.connections.size).toBe(0);
});
