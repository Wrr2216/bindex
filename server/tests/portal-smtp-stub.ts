import net from "node:net";

/**
 * A tiny SMTP server that accepts every message and keeps it, for testing
 * portal email without a mail server. It speaks just enough SMTP for
 * nodemailer (EHLO, MAIL, RCPT, DATA, QUIT), offers no STARTTLS and no AUTH.
 *
 * Run it on its own to watch a development server's mail:
 *
 *   pnpm --filter bindex-server exec tsx tests/portal-smtp-stub.ts 2525
 *   SMTP_URL=smtp://127.0.0.1:2525 pnpm dev
 */

export type StubMessage = { from: string; to: string[]; data: string };

export function startSmtpStub(port = 0): Promise<{ port: number; messages: StubMessage[]; close: () => Promise<void> }> {
  const messages: StubMessage[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.setEncoding("utf8");
    let buf = "";
    let inData = false;
    let current: StubMessage = { from: "", to: [], data: "" };
    sock.write("220 portal-smtp-stub ESMTP\r\n");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            current = { from: "", to: [], data: "" };
            sock.write("250 2.0.0 queued\r\n");
          } else {
            current.data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") sock.write("250-portal-smtp-stub\r\n250 8BITMIME\r\n");
        else if (verb === "MAIL") {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          sock.write("250 2.1.0 ok\r\n");
        } else if (verb === "RCPT") {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          sock.write("250 2.1.5 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          sock.write("354 end with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          sock.write("221 2.0.0 bye\r\n");
          sock.end();
        } else if (verb === "RSET" || verb === "NOOP") sock.write("250 2.0.0 ok\r\n");
        else sock.write("502 5.5.1 not implemented\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        messages,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2] ?? 2525);
  void startSmtpStub(port).then((stub) => {
    console.log(`portal SMTP stub listening on 127.0.0.1:${stub.port}`);
    let shown = 0;
    setInterval(() => {
      for (; shown < stub.messages.length; shown++) {
        const m = stub.messages[shown]!;
        console.log(`--- mail ${shown + 1} from ${m.from} to ${m.to.join(", ")}\n${m.data}`);
      }
    }, 250);
  });
}
