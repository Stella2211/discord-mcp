English | [日本語](#セキュリティポリシー)

# Security Policy

## Supported versions

Only the latest `main` is supported. Please check that the problem still exists on the latest `main` before you report it.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a vulnerability.

Please include:

- The affected component (the notifier bot, the MCP Worker, the shared code, or the Cloudflare Access setup)
- Steps to reproduce
- The impact you expect
- The commit you tested on

Please do not include real tokens, hostnames, user IDs or message contents in the report. Redact them.

This is a small personal project. I will respond on a best-effort basis and cannot promise a response time or a fix date.

## Scope

In scope:

- **MCP Worker** (`packages/mcp`): authentication and JWT checks, the 8 tools, and handling of text written by Discord users (`wrapUntrusted`, `allowed_mentions`)
- **Notifier bot** (`packages/notifier`): forwarding and judging of messages, and handling of the bot token
- **Shared code** (`packages/discord`)
- **Cloudflare Access setup** as documented in this repository (the steps in `docs/mcp/`)

Out of scope:

- Vulnerabilities in Discord, Cloudflare, Claude or other third-party services (please report them to the vendor)
- Problems in a fork's own configuration, such as a leaked token or a wrongly set Access policy

---

# セキュリティポリシー

## サポート対象

サポートするのは最新の `main` だけです。報告の前に、最新の `main` でも問題が再現するかを確かめてください。

## 脆弱性の報告方法

脆弱性は GitHub の非公開の脆弱性報告で連絡してください。リポジトリの **Security** タブから **Report a vulnerability** を選びます。脆弱性については、公開の issue や pull request を作らないでください。

報告には次のことを書いてください。

- 影響を受けるコンポーネント（通知Bot、MCP の Worker、共通部品、Cloudflare Access の設定のどれか）
- 再現手順
- 想定される影響
- 確かめたコミット

実際のトークン・ホスト名・ユーザー ID・メッセージの中身は、報告に書かずに伏せてください。

小さな個人プロジェクトなので、対応はできる範囲で行います。返信の時期や修正の時期は約束できません。

## 対象範囲

対象になるもの：

- **MCP の Worker**（`packages/mcp`）：認証と JWT の検査、8つのツール、Discord の利用者が書いた文字列の扱い（`wrapUntrusted`、`allowed_mentions`）
- **通知Bot**（`packages/notifier`）：メッセージの転送と判定、Bot トークンの扱い
- **共通部品**（`packages/discord`）
- このリポジトリの手順（`docs/mcp/`）で案内している **Cloudflare Access の設定**

対象にならないもの：

- Discord・Cloudflare・Claude などの外部サービスそのものの脆弱性（各サービスに報告してください）
- フォークした側の設定の問題（トークンの漏えい、Access のポリシーの設定ミスなど）
