import { chatReply, startAiStub, type CapturedChat } from "./media-ai-core-stub";
import { STEPS_REPLY, TEARDOWN_TRANSCRIPTION } from "./teardown-fixtures";

/**
 * The AI stand-in from media-ai-core-stub.ts, answering as a teardown
 * narration: transcription returns the lab workstation fixture, the language
 * model its steps and parts, and the vision model renames the M4 screws. For
 * trying teardown guides on a running server without a provider:
 *
 *   pnpm --filter bindex-server exec tsx tests/teardown-stub.ts 4120
 *
 * then run the server with LLM_BASE_URL and STT_BASE_URL set to
 * http://127.0.0.1:4120/v1, any LLM_API_KEY, and LLM_VISION_MODEL=stub-vision.
 * The transcript is the same whatever video is uploaded.
 */

const hasImages = (c: CapturedChat) =>
  (c.body.messages as { content: unknown }[]).some(
    (m) => Array.isArray(m.content) && m.content.some((p: { type?: string }) => p.type === "image_url"),
  );

function refine(c: CapturedChat) {
  const text = JSON.stringify(c.body.messages);
  const id = text.match(/(p\d+): M4 screw /)?.[1];
  return chatReply(JSON.stringify({ parts: id ? [{ id, name: "M4 x 6 mm pan head screw", kind: "hardware" }] : [] }));
}

if (require.main === module) {
  const port = Number(process.argv[2] ?? 4120);
  void startAiStub(
    {
      chat: (c) => (hasImages(c) ? refine(c) : chatReply(JSON.stringify(STEPS_REPLY))),
      transcription: () => ({ json: TEARDOWN_TRANSCRIPTION }),
    },
    port,
  ).then((stub) => {
    process.stdout.write(`Teardown AI stub listening at ${stub.url}\n`);
    const log = setInterval(() => {
      for (const t of stub.transcriptions.splice(0)) process.stdout.write(`transcription: ${t.file?.name} ${t.file?.type} ${t.file?.size} bytes\n`);
      for (const c of stub.chats.splice(0)) process.stdout.write(`chat: ${hasImages(c) ? "vision" : "text"} model=${String(c.body.model)}\n`);
    }, 500);
    process.on("SIGTERM", () => {
      clearInterval(log);
      void stub.close().then(() => process.exit(0));
    });
  });
}
