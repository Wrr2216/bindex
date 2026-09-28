import fs from "node:fs";
import type { Readable } from "node:stream";
import { env } from "../../env";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { parseTranscription, type Transcript } from "./reply";

/**
 * Speech to text through any OpenAI-compatible /audio/transcriptions endpoint
 * (OpenAI, Groq, a local Whisper server), asking for verbose_json so the
 * transcript comes back with timestamps. Null on any failure; never throws.
 *
 * Providers cap the upload (OpenAI at 25 MB), so send extracted audio rather
 * than a whole video where you can: `ffmpeg -i in.mp4 -vn -ac 1 -b:a 48k out.m4a`
 * turns an hour into about 20 MB.
 */

export type TranscribeInput = {
  /** One of bytes, stream or path. A path is streamed from disk. */
  bytes?: Buffer;
  stream?: Readable;
  path?: string;
  mime: string;
  filename?: string;
  /** ISO-639-1 hint, such as "en". */
  language?: string;
  /** Vocabulary hint: part names, brand names. */
  prompt?: string;
};

export type { Transcript };

const TIMEOUT_MS = 5 * 60_000;
// A stream has to be held in memory to be posted; refuse to hold more than this.
const STREAM_MAX = 50 * 1024 * 1024;

const EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

async function toBlob(input: TranscribeInput): Promise<Blob | null> {
  if (input.bytes) return new Blob([new Uint8Array(input.bytes)], { type: input.mime });
  if (input.path) return fs.openAsBlob(input.path, { type: input.mime });
  if (input.stream) {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of input.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > STREAM_MAX) {
        input.stream.destroy();
        return null;
      }
      parts.push(buf);
    }
    return new Blob([new Uint8Array(Buffer.concat(parts))], { type: input.mime });
  }
  return null;
}

export async function transcribe(input: TranscribeInput): Promise<Transcript | null> {
  if (!env.sttConfigured) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const blob = await toBlob(input);
    if (!blob) {
      logger.warn("ai.transcribe.input_too_large", { limitMb: STREAM_MAX / 1024 / 1024 });
      return null;
    }
    const form = new FormData();
    const mime = input.mime.split(";")[0]!.trim().toLowerCase();
    form.append("file", blob, input.filename || `audio.${EXT[mime] ?? "bin"}`);
    form.append("model", env.STT_MODEL);
    form.append("response_format", "verbose_json");
    if (input.language) form.append("language", input.language);
    if (input.prompt) form.append("prompt", input.prompt);

    const resp = await fetch(`${env.sttBaseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.sttApiKey}` },
      body: form,
      signal: controller.signal,
    });
    const body = await resp.text();
    if (!resp.ok) {
      logger.warn("ai.transcribe.http_error", { status: resp.status, model: env.STT_MODEL, detail: body.slice(0, 300) });
      return null;
    }
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      // A server that ignores response_format answers with plain text.
      const text = body.trim();
      return text ? { text, segments: [] } : null;
    }
    const parsed = parseTranscription(data);
    if (!parsed) logger.warn("ai.transcribe.unparseable", { model: env.STT_MODEL });
    return parsed;
  } catch (err) {
    logger.warn("ai.transcribe.fetch_error", { err: describeError(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
