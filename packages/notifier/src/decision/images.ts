// 判定モデルに渡す画像のダウンロード。Discord の CDN にある画像だけを取る（投稿の埋め込みは外部の URL を指せるので、
// 内部ネットワークのアドレスなどに取りに行かないよう、ホストを限る）。取れなかった画像は黙って飛ばす（呼び出し側が URL を文字で書く）
import type { ImageRef } from "@discord-mcp/discord";
import type { LoadedImage } from "./types";

// Clef の上限に合わせる: 4枚、1枚4MiB、合計8MiB。PNG・JPEG・WebP だけ（どのモデルでも読める形式）
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const TYPES: Record<string, LoadedImage["mediaType"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
};

export function isDiscordCdn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.port === "" && /(^|\.)discordapp\.(com|net)$/.test(u.hostname);
  } catch {
    return false;
  }
}

// 本体を上限まで読む。上限を超えたらストリームを止めて null を返す
async function readCapped(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return buf;
}

export async function loadImages(refs: ImageRef[], o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<LoadedImage[]> {
  const f = o.fetch ?? fetch;
  const out: LoadedImage[] = [];
  let total = 0;
  for (const ref of refs) {
    if (out.length >= MAX_IMAGES) break;
    if (!isDiscordCdn(ref.url)) continue;
    if (ref.size && ref.size > MAX_IMAGE_BYTES) continue;
    try {
      // リダイレクトは辿らない（CDN の外に連れ出されないように）
      const res = await f(ref.url, { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
      if (!res.ok) {
        await res.body?.cancel();
        continue;
      }
      if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) {
        await res.body?.cancel();
        continue;
      }
      const type = TYPES[(res.headers.get("content-type") ?? ref.contentType ?? "").split(";")[0]!.trim().toLowerCase()];
      if (!type) {
        await res.body?.cancel();
        continue;
      }
      // Content-Length が無い（チャンク転送）応答でも全部をメモリに載せないよう、上限を超えた時点で読むのをやめる
      const buf = await readCapped(res, Math.min(MAX_IMAGE_BYTES, MAX_TOTAL_BYTES - total));
      if (!buf || buf.byteLength === 0) continue;
      total += buf.byteLength;
      out.push({ url: ref.url, mediaType: type, base64: Buffer.from(buf).toString("base64") });
    } catch {
      // 取れなかった画像は飛ばす
    }
  }
  return out;
}
