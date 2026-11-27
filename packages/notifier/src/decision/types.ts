export interface DecisionInput {
  guildName: string;
  channelName: string;
  // 古い順。isNew は今回判定する投稿
  // images は投稿に付いた画像の URL（モデルに渡せなかった画像は、プロンプトに URL を文字で書く）
  // isTarget は本人（TARGET_USER_ID）の投稿。プロンプトの行頭の [本人] は名前ではなくこれで付ける
  messages: { author: string; at: string; content: string; isNew: boolean; isTarget?: boolean; images?: { url: string; filename?: string }[] }[];
  // モデルに画像として渡す画像（ダウンロード済み）。url は images の url と同じ
  attachedImages?: LoadedImage[];
}

export interface LoadedImage {
  url: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

export const dataUrl = (img: LoadedImage) => `data:${img.mediaType};base64,${img.base64}`;

export interface Decision {
  relevant: boolean;
  reason: string;
  // Clef だけ：relevant の確率（0〜1）と重要度（0〜3）。ログと試験用スクリプトで使う
  probability?: number;
  priority?: number;
}

export interface DecisionModel {
  readonly name: string;
  decide(input: DecisionInput): Promise<Decision>;
}

// 判定モデルの呼び出しの失敗のうち、メッセージをこちらで書いたもの（投稿やモデルの出力を含まない）。
// これ以外の例外のメッセージには、モデルの出力や接続先の URL が入ることがあるので、通知とログには出さない
export class DecisionError extends Error {
  override readonly name = "DecisionError";
  // モデルのサーバーが返した HTTP の状態（あれば）。画像つきの呼び出しを画像なしでやり直すかの判断に使う
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
