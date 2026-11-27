// 判定モデルを呼び、知らせるかを決める。見逃しを避けるため、呼び出しに失敗したとき（エラー、タイムアウト、
// 使用量の上限、読めない応答、回答の拒否）は「未判定のまま知らせる」側に倒す（fail-open）。通知Botと試験用スクリプトで共通に使う
import { DecisionError, type Decision, type DecisionInput, type DecisionModel } from "./types";

export type Judgment = { notify: boolean; decision: Decision; error?: undefined } | { notify: true; decision?: undefined; error: string };

// 失敗の理由を、投稿やモデルの出力を含まない文にする（通知の区切りの外とログに出すため）
export function failureReason(err: unknown): string {
  if (err instanceof DecisionError) return err.message;
  const e = err as { name?: unknown; status?: unknown } | null;
  if (e?.name === "TimeoutError" || e?.name === "APIConnectionTimeoutError") return "時間内に応答がなかった";
  // Anthropic の SDK の APIError など。HTTP の状態だけを出す
  if (typeof e?.status === "number") return `判定モデルが ${e.status} を返した${e.status === 429 ? "（使用量の上限）" : ""}`;
  if (e?.name === "TypeError" || e?.name === "APIConnectionError") return "判定モデルに接続できなかった";
  const name = typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "不明";
  return `判定モデルの呼び出しで想定外のエラー（${name}）`;
}

// 画像つきの呼び出しが「画像を受け付けない」ことを示す HTTP の状態（認証・使用量・サーバーの障害は画像のせいではない）
const IMAGE_REJECTED = new Set([400, 413, 415, 422]);

export async function judge(model: DecisionModel, input: DecisionInput): Promise<Judgment> {
  try {
    const decision = await model.decide(input);
    return { notify: decision.relevant, decision };
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if ((input.attachedImages?.length ?? 0) > 0 && typeof status === "number" && IMAGE_REJECTED.has(status)) {
      // モデルが画像を受け付けなかったので、画像は URL を文字で書くだけにしてやり直す
      try {
        const decision = await model.decide({ ...input, attachedImages: undefined });
        return { notify: decision.relevant, decision };
      } catch (err2) {
        return { notify: true, error: failureReason(err2) };
      }
    }
    return { notify: true, error: failureReason(err) };
  }
}
