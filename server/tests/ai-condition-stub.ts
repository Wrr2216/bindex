import {
  SAMPLE_DATA_PLATE,
  chatReply,
  startAiStub,
  type AiStub,
  type CapturedChat,
  type StubResponse,
} from "./media-ai-core-stub";

/**
 * The media-ai-core provider stand-in, answering the condition prompts with
 * plausible replies: a container read, an assessment and a comparison, told
 * apart by their system message. For trying the screens without a key:
 *
 *   pnpm --filter bindex-server exec tsx tests/ai-condition-stub.ts 4112
 *   LLM_BASE_URL=http://127.0.0.1:4112/v1 LLM_API_KEY=stub LLM_VISION_MODEL=stub pnpm dev
 */

export const SAMPLE_CONTAINER = {
  sizeClass: "Medium box",
  handwrittenText: "KITCHEN\nplates + bowls\nFRAGILE",
  room: "Kitchen",
  contentsSummary: "Dinner plates and bowls",
  contents: [
    { name: "Dinner plates", category: "Dishes and glassware", qty: 12, condition: "good", fragile: true },
    { name: "Cereal bowls", category: "dishes", qty: 6, condition: "like new", fragile: true },
    { name: "Tea towels", category: "linens", qty: 3, condition: null, fragile: false },
  ],
  flags: ["Fragile", "this way up"],
  confidence: { sizeClass: 0.9, handwrittenText: 0.55, room: 0.9, contents: 0.7 },
};

export const SAMPLE_ASSESSMENT = {
  rating: "fair",
  summary: "Light scratches on the top and a small dent on the front edge.",
  defects: [
    { area: "top, left side", type: "scratch", severity: "minor", description: "Fine scratches" },
    { area: "front edge", type: "dent", severity: "moderate", description: "Small dent" },
  ],
  handlingNote: "Handle with care to prevent further scratching of the top.",
  confidence: 0.8,
};

export const SAMPLE_COMPARISON = {
  summary: "A new crack on the right door since the first photos.",
  newDefects: [{ area: "right door", type: "crack", severity: "major", description: "Cracked panel" }],
  resolvedDefects: [],
  ratingAfter: "damaged",
  changed: true,
};

/** The reply for a condition prompt, or the data plate for anything else. */
export function conditionReply(c: CapturedChat): StubResponse | null {
  const system = String((c.body.messages as { content: unknown }[] | undefined)?.[0]?.content ?? "");
  if (system.includes("catalogue packed containers")) return chatReply(JSON.stringify(SAMPLE_CONTAINER));
  if (system.includes("compare photos")) return chatReply(JSON.stringify(SAMPLE_COMPARISON));
  if (system.includes("condition inspector")) return chatReply(JSON.stringify(SAMPLE_ASSESSMENT));
  return null;
}

/** Condition replies, and the data plate for "Read from label", so both features can be tried at once. */
export function startConditionStub(port = 0): Promise<AiStub> {
  return startAiStub({ chat: (c) => conditionReply(c) ?? chatReply(JSON.stringify(SAMPLE_DATA_PLATE)) }, port);
}

if (require.main === module) {
  const port = Number(process.argv[2] ?? 4112);
  void startConditionStub(port).then((stub) => {
    process.stdout.write(`Condition AI stub listening at ${stub.url}\n`);
    process.on("SIGTERM", () => void stub.close().then(() => process.exit(0)));
  });
}
