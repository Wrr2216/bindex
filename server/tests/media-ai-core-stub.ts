import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny stand-in for an OpenAI-compatible provider, speaking just enough of
 * chat/completions and audio/transcriptions to exercise the AI helpers without
 * a key or a network. Tests start it in-process; for poking at a running
 * server, start it on its own:
 *
 *   pnpm --filter bindex-server exec tsx tests/media-ai-core-stub.ts 4102
 *
 * then run the server with LLM_BASE_URL=http://127.0.0.1:4102/v1,
 * STT_BASE_URL=http://127.0.0.1:4102/v1 and any LLM_API_KEY.
 */

export type StubResponse = { status?: number; json?: unknown; text?: string; delayMs?: number };

export type CapturedChat = { headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
export type CapturedTranscription = {
  headers: http.IncomingHttpHeaders;
  fields: Record<string, string>;
  file: { name: string; type: string; size: number } | null;
};

export type AiStub = {
  /** Base URL to use as LLM_BASE_URL / STT_BASE_URL. */
  url: string;
  chats: CapturedChat[];
  transcriptions: CapturedTranscription[];
  close: () => Promise<void>;
};

/** A chat/completions reply whose assistant message is `content`. */
export const chatReply = (content: unknown): StubResponse => ({
  json: {
    id: "stub",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  },
});

/** A data plate as a well-behaved vision model would describe it. */
export const SAMPLE_DATA_PLATE = {
  brand: "Dell",
  model: "Model: Latitude 5440",
  serial: "S/N: 7XK2P93",
  partNumber: "P/N 0R9KW3",
  assetTag: null,
  mac: "a4-bb-6d-12-34-56",
  manufactureDate: "03/2024",
  ratings: { voltage: "19.5V", amperage: "3.34A", wattage: "65W", frequency: null },
  otherIdentifiers: [{ label: "Service Tag", value: "7XK2P93" }, "FCC ID: E2K-AX211NG"],
  confidence: { brand: 0.98, model: 0.95, serial: 0.62, partNumber: 0.4, mac: "high", manufactureDate: 0.7 },
  rawText: "DELL\nLatitude 5440\nS/N: 7XK2P93\nP/N 0R9KW3\nMAC A4-BB-6D-12-34-56\nMFG 03/2024\n19.5V 3.34A 65W\nFCC ID: E2K-AX211NG",
};

export const SAMPLE_TRANSCRIPTION = {
  task: "transcribe",
  language: "english",
  duration: 9.5,
  text: "Remove the four screws on the back panel. Then lift the cover.",
  segments: [
    { id: 0, start: 0, end: 4.2, text: " Remove the four screws on the back panel." },
    { id: 1, start: 4.2, end: 9.5, text: " Then lift the cover." },
  ],
};

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

export async function startAiStub(
  handlers: {
    chat?: (c: CapturedChat) => StubResponse;
    transcription?: (t: CapturedTranscription) => StubResponse;
  } = {},
  port = 0,
): Promise<AiStub> {
  const chats: CapturedChat[] = [];
  const transcriptions: CapturedTranscription[] = [];

  const send = async (res: http.ServerResponse, r: StubResponse) => {
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    res.statusCode = r.status ?? 200;
    if (r.text !== undefined) {
      res.setHeader("Content-Type", "text/plain");
      res.end(r.text);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(r.json ?? {}));
    }
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        const captured: CapturedChat = { headers: req.headers, body: JSON.parse(body.toString("utf8")) };
        chats.push(captured);
        return send(res, (handlers.chat ?? (() => chatReply(JSON.stringify(SAMPLE_DATA_PLATE))))(captured));
      }
      if (req.method === "POST" && req.url?.endsWith("/audio/transcriptions")) {
        // Let the platform parse the multipart body the same way a provider would.
        const form = await new Response(body, {
          headers: { "content-type": req.headers["content-type"] ?? "" },
        }).formData();
        const fields: Record<string, string> = {};
        let file: CapturedTranscription["file"] = null;
        for (const [key, value] of form.entries()) {
          if (typeof value === "string") fields[key] = value;
          else file = { name: value.name, type: value.type, size: value.size };
        }
        const captured: CapturedTranscription = { headers: req.headers, fields, file };
        transcriptions.push(captured);
        return send(res, (handlers.transcription ?? (() => ({ json: SAMPLE_TRANSCRIPTION })))(captured));
      }
      return send(res, { status: 404, json: { error: { message: "not found" } } });
    })().catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });

  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}/v1`,
    chats,
    transcriptions,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

if (require.main === module) {
  const port = Number(process.argv[2] ?? 4102);
  void startAiStub({}, port).then((stub) => {
    process.stdout.write(`AI stub listening at ${stub.url}\n`);
    const log = setInterval(() => {
      if (stub.chats.length || stub.transcriptions.length) {
        process.stdout.write(`chat calls: ${stub.chats.length}, transcription calls: ${stub.transcriptions.length}\n`);
        stub.chats.length = 0;
        stub.transcriptions.length = 0;
      }
    }, 1000);
    process.on("SIGTERM", () => {
      clearInterval(log);
      void stub.close().then(() => process.exit(0));
    });
  });
}
