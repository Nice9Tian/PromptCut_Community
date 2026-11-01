<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="PromptCut ロゴ">
</p>

<h1 align="center">PromptCut Community</h1>

<p align="center">
  <strong>AI エージェントに話しかけて動画を編集。いつでも手動に切り替えられます。</strong>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-3a3f4b?style=for-the-badge" alt="English"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/简体中文-3a3f4b?style=for-the-badge" alt="简体中文"></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/日本語-00A3A3?style=for-the-badge" alt="日本語"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6F69FC" alt="MIT ライセンス"></a>
  <a href="https://github.com/Nice9Tian/PromptCut_Community/actions/workflows/test.yml"><img src="https://github.com/Nice9Tian/PromptCut_Community/actions/workflows/test.yml/badge.svg" alt="テスト状態"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A3A3" alt="Node.js 22 以上">
  <img src="https://img.shields.io/badge/desktop-Windows%20x64-3a3f4b" alt="デスクトップ版：Windows x64">
  <a href="CONTRIBUTING.en.md"><img src="https://img.shields.io/badge/PRs-welcome-00A3A3" alt="PR 歓迎"></a>
</p>

<p align="center">
  <a href="#できること">できること</a> ·
  <a href="#はじめかた">はじめかた</a> ·
  <a href="#ドキュメント">ドキュメント</a> ·
  <a href="CONTRIBUTING.en.md">コントリビュート</a>
</p>

<p align="center">
  <img src="docs/assets/editor.webp" width="900" alt="PromptCut のエディタ画面：左に素材ライブラリ、中央にプレビュー、右にエージェントパネル、下にタイムライン">
</p>

PromptCut は AI 動画編集ワークベンチです。自然な言葉でエージェントに指示することも、自分の手でカットやパラメータ調整をすることもでき、同じプロジェクトで両方を同時に進められます。

**このリポジトリはコミュニティ版です。** お使いのマシンとローカルネットワーク内で動作します（デスクトップアプリとローカルブラウザ）。同じネットワーク上の別のコンピュータやスマートフォンからコードをスキャンして共有プロジェクトに参加し、一緒に編集できます。アカウント登録は不要です。Web サイトのアカウント、クラウドプロジェクト、ホスティングサービス、Web オンライン版はクローズドな商用版に含まれます。

> [!NOTE]
> アプリの画面は現在中国語のみです（スクリーンショットのとおり）。英語と日本語への対応は [issue #6](https://github.com/Nice9Tian/PromptCut_Community/issues/6) で進めています。

## できること

| | |
|---|---|
| **エージェントによる編集** | ローカルの CLI / API エージェントと連携し、タイムラインの構成、カードの追加、パラメータの調整を任せられます。他のエージェントから呼び出せる MCP サーバーとしても動作します。 |
| **手動編集** | タイムライン、マルチトラック、カットのネスト、パラメータパネル、プレビュー。 |
| **カード** | モーショングラフィックス、グラフ、字幕などを React コンポーネントとして実装した「カード」。内蔵ライブラリが付属し、自作もできます。 |
| **レンダリングと書き出し** | プリレンダリングによるスナップショット生成、ローカルの Chrome によるフレーム単位のレンダリング、ffmpeg による最終動画の合成。 |
| **素材** | ローカルからの読み込み、Web リンクからの取得（yt-dlp）、ショット境界検出、被写体検出、トラッキング、音声文字起こし。 |
| **LAN 共有** | プロジェクトをローカルネットワークに共有し、別のコンピュータやスマートフォンからコードをスキャンして参加すると、双方がリアルタイムに同期します。スマートフォンには専用の画面があります。 |
| **デスクトップアプリ** | Tauri v2 のシェルに Node、Chrome for Testing、ffmpeg、内蔵 Python をまとめた Windows インストーラー。 |

## はじめかた

Node.js 22 以上（24.x を推奨）が必要です。最終動画の書き出しには `PATH` 上の ffmpeg も必要です（Windows の場合：`winget install --id Gyan.FFmpeg -e`）。

```bash
npm ci
npm run dev        # ローカルエディタ：http://127.0.0.1:5190
```

| コマンド | 内容 |
|---|---|
| `npm run dev` | ローカルエディタを起動します。バックエンドは Vite 開発サーバーのプラグインミドルウェアにあるため、開発サーバーがアプリ本体を兼ねます。 |
| `npm test` | 全ユニットテスト |
| `npm run build` | 型チェックのあとビルド |
| `npx tsc -b` | 型チェックのみ |

Python 側（音声文字起こし、ショット検出、被写体検出、トラッキング、素材収集）の依存関係とモデルの重みは必要に応じてインストールされ、足りないものは `status` に正直に表示されます。詳しくは [python/README.md](python/README.md) を参照してください。デスクトップアプリのビルドは [desktop/README.md](desktop/README.md) を参照してください。

## ドキュメント

ドキュメントは中国語で書かれています。`docs/semantics/` はこのプロジェクトの**契約**であり、セマンティクスとコードが食い違う場合はセマンティクスが優先されます。コードを変更する前に、[docs/semantics/README.md](docs/semantics/README.md) の表で読むべき文書を確認してください。

| 知りたいこと | 参照先 |
|---|---|
| 製品が存在する理由と目標 | [docs/semantics/product-purpose.md](docs/semantics/product-purpose.md) |
| システムの構成 | [docs/semantics/architecture.md](docs/semantics/architecture.md)、製品機能は [product/](docs/semantics/product/)、具体的な仕組みは [mechanism/](docs/semantics/mechanism/) |
| 使い方 | [docs/semantics/user-workflow.md](docs/semantics/user-workflow.md)、詳細は [workflow/](docs/semantics/workflow/) |
| 用語集 | [docs/semantics/glossary.md](docs/semantics/glossary.md) |
| 設計の理由 | [docs/rationale/](docs/rationale/) |
| トラブルシューティングと運用の知識 | [docs/guides/](docs/guides/) |
| コントリビュートの方法 | [CONTRIBUTING.en.md](CONTRIBUTING.en.md)（英語） |

<details>
<summary><strong>このリポジトリの外を指す参照について</strong></summary>

コードのコメントやセマンティクス文書には、このリポジトリに含まれないものへの参照がときどき出てきます。次の 2 種類です。

- **上流の内部文書**：`docs/plan/…`（計画と契約）、`docs/reports/…`（受け入れレポート）、および `docs/local.md`（マシンごとのメモ。設計上どのリポジトリにもコミットされません。`docs/semantics/guide_files/constraints.md` を参照）。
- **商用版のみのコード**：商用版リポジトリの `cloud/` 以下にあります（例：`cloud/src/account/…`、`cloud/server/hosted/…`。古いコメントでは移動前の `src/account/…`、`server/hosted/…` と書かれていることがあります）。`ONLINE_BUILD` のように、コミュニティ版では常に偽となるコンパイル時定数も含みます。

どちらも意図的に残しています。判断の出どころを示すものであり、結論はコメント自体に書かれているので、参照先を開けなくてもコードの理解に支障はありません。ローカルとクラウドの境界はすでに分離されています。共有コードはインターフェースとレジストリだけを知っており、商用版は `cloud/` から自身の実装を登録し、コミュニティ版ではこれらのスロットに内蔵のローカル実装が使われます。

</details>

<details>
<summary><strong>コーディングエージェント向けの入口</strong></summary>

このリポジトリには `AGENTS.md` と `CLAUDE.md` を**置いていません**。これらのファイルは各ツールが無条件にコンテキストへ読み込むため、このプロジェクトの作業習慣が他の人のエージェントに持ち込まれてしまいます。必要な場合は、作業コピーに下の内容で作成してください。コミットはしないでください（`.gitignore` で除外済みです）。

````markdown
# PromptCut

AI 動画編集ワークベンチ。このリポジトリを変更する前に、次のことを把握してください。

- セマンティクスは `docs/semantics/` にあります。製品の約束は `product/`、実装の仕組みは `mechanism/`、ユーザーフローは `workflow/`。セマンティクスとコードが食い違う場合はセマンティクスが優先されます。
- 厳守すべき制約は `docs/semantics/guide_files/constraints.md` にあります。レイヤー構成は kernel ← render ← editor / mcp / ai で、下位層は上位層を参照しません。ゲートキーパーテストで検査されます。
- 検証方法と、変更の種類ごとに必要なチェックは `docs/semantics/guide_files/verification.md` にあります。
- 変更範囲ごとに読むべきセマンティクスは `docs/semantics/README.md` にあります。
````

</details>

## ライセンスと名称

コードは [MIT](LICENSE) ライセンスですが、**「PromptCut」という名称と関連する標章はライセンスの対象外です**。自由にフォーク、改変、再配布できますが、公式リリースと誤解されないよう、配布物に「PromptCut」という名前は使わないでください。
