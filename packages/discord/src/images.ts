// 投稿に付いた画像（添付と埋め込み）を取り出す。Bun と Workers の両方で動く
import { clean } from "./text";
import type { APIMessage } from "./types";

export interface ImageRef {
  // 画像の URL（Discord の CDN。署名付きで、期限が切れることがある）
  url: string;
  filename?: string;
  size?: number;
  contentType?: string;
  source: "attachment" | "embed";
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|heic)(?:[?#]|$)/i;

function fileNameOf(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

// 添付の画像（content_type が image/*、または拡張子が画像）と、埋め込みの画像（image、または画像そのものの埋め込みの thumbnail）。
// 埋め込みは外部サイトの URL を指すので、Discord のプロキシ（proxy_url）があればそちらを使う
export function messageImages(msg: Pick<APIMessage, "attachments" | "embeds">): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  const add = (ref: ImageRef) => {
    if (seen.has(ref.url)) return;
    seen.add(ref.url);
    out.push(ref);
  };
  for (const a of msg.attachments ?? []) {
    const url = a.url ?? a.proxy_url;
    if (!url) continue;
    if (a.content_type ? !a.content_type.startsWith("image/") : !IMAGE_EXT.test(a.filename)) continue;
    add({ url, filename: a.filename, size: a.size, contentType: a.content_type, source: "attachment" });
  }
  for (const e of msg.embeds ?? []) {
    const media = e.image ?? (e.type === "image" || e.type === "gifv" ? e.thumbnail : undefined);
    const url = media?.proxy_url ?? media?.url;
    if (url) add({ url, filename: fileNameOf(media?.url ?? url), source: "embed" });
  }
  return out;
}

function sizeLabel(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

// 「画像1: ファイル名 (サイズ) URL」の1行。投稿者が付けた値なので clean を通す（URL の < > も無害にする）
export function imageLine(ref: ImageRef, index: number): string {
  const name = ref.filename ? `${clean(ref.filename, 80)} ` : "";
  const size = ref.size ? `(${sizeLabel(ref.size)}) ` : "";
  return `画像${index + 1}: ${name}${size}${clean(ref.url, 500)}`;
}
