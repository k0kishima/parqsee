# ローカル探索テスト

実施日: 2026-09-12。アプリ対象コミット: `5903c2e`（spec2監査完了）。開始時に `git fetch origin` で origin/main=`9a10356`、PR #29 の CI 導入が main に含まれることを確認した。spec2 の成果物は監査レポート・再現パッチだけで、追跡済み未コミット変更はなかったため、ローカル main を `qa/code-test-audit` へ fast-forward し、`qa/exploratory-tests` を作成した。

テスト・再現コードのコミットは `9c37727`。今回の変更は探索テスト・基盤の期待値・記録のみ。アプリの修正は行っていない。成果物コミットは `git log -1 --format=%H qa/exploratory-tests -- docs/qa/exploratory-testing.md` で特定できる。ユーザーの指示に従いローカルで完了し、push・PR 作成・リモート CI・spec3 の main マージは行っていない。

## 環境・再現方法

macOS 26.6.2 (25G83)、Node 22.22.2、pnpm 10.13.1、Rust 1.91.1。Playwright 1.62.1 / WebKit 26.5 (revision 2336) と実 Rust bridge、production frontend を `csp-server.mjs` で配信。CSP は `backend/tauri.conf.json` から読み込む。ブラウザ・bridge ごとに専用 dataDir を使い、S17 のみ2回の起動で共有した。通常 CI は Node 24 / macos-15 であり、このローカル環境と同一ではない。

```sh
# repository root
cargo build --locked --example bridge --manifest-path backend/Cargo.toml
pnpm --dir frontend build
uv run scripts/qa/gen_fixtures.py /private/tmp/parqsee-spec3-fixtures
pnpm --dir scripts/qa/e2e csp-server
# another terminal, scripts/qa/e2e
DEV_URL=http://localhost:1421/ BRIDGE_QUIET=1 \
  FIXTURES=/private/tmp/parqsee-spec3-fixtures E2E_OUT=/private/tmp/parqsee-spec3-out pnpm suite
DEV_URL=http://localhost:1421/ BRIDGE_QUIET=1 pnpm test
DEV_URL=http://localhost:1421/ BRIDGE_QUIET=1 \
  FIXTURES=/private/tmp/parqsee-spec3-fixtures E2E_OUT=/private/tmp/parqsee-spec3-diagnostics \
  node exploratory-diagnostics.mjs
```

fixture generator の数値乱数 seed は `20250820`。UUID と破損用 bytes は生成ごとに変わるが、今回の追加 assertion はその値に依存しない。新規ランダム操作は使わない。既存 fixture を生成して利用し、S16 の失敗先・出力、session はすべて専用ディレクトリ内。ユーザーの設定・ファイル・購入状態を変更していない。uv キャッシュと localhost/WebKit は sandbox で拒否されたため、許可された実行で検証した。これはアプリの失敗に数えない。

## 探索単位と結果

| 対象 | 既存ケースとの差分・選定理由 | 入力・順序・期待結果 | 結果 |
|---|---|---|---|
| S15 非同期 | S2/S3 の同じ tab 内の順序逆転から、監査 H-01 の close/evict 境界へ拡張 | multi_rowgroup の grp=3 の実 read 応答を gate で保留。tab close → eviction 完了 → one_row open → 応答解放 →元 file reopen → Next。別 tab は1行のまま、reopen は filter なし id=0、Next は id=50、spinner 残留なし | 3確認 PASS |
| S16 ファイル・export | S6 の書込失敗表示と別 export 成功から、同じ modal・同じ filter の再試行へ拡張。CT-01 の生成後 copy 障害とは区別 | id=5 の1行を表示。通常ファイルを親とする保存先へ JSON export → ENOTDIR → 同じ modal で正常先へ再試行。親ファイルの bytes を保全し、出力1行 id=5/name=row-5 と表示が一致、modal を閉じて操作継続 | 3確認 PASS |
| S17 保存・復元 | S11 の debounce 待ちと unit の save 呼出し確認から、pagehide後の実ディスク・新プロセスへ拡張 | multi_rowgroup、one_row の順で open →先頭選択→ Next → synthetic pagehide → bookmarks.json に page=2/active/順序が書かれるまで確認 → fresh browser/bridge。2 tabs、先頭が active、最初の表示 id=50 | 2確認 PASS。実 Quit 完了保証ではない |
| S18 課金 UI | S14 の取消→購入→返金と別起動の復元から、同一sessionの失敗→保留→外部承認→返金→復元失敗→再試行へ拡張 | 無料3 tabsで4件目拒否→purchase failure→pending→unlocked event→4件目open→refund→5件目拒否→restore failure→owned restore成功→5件目open。各失敗後 busy解除、既存tab保持、枠・badge一致 | 4確認 PASS。scripted store の UI のみ |
| EX-01 保存失敗 | 監査 H-02 の再試行欠落を動的確認 | page1 の実disk保存後、次の save_session だけ reject。page2表示→exact console.error確認→pagehide→実bridge往復。diskはpage1、保存試行1回。page3への変更は2回目のsaveで保存成功 | **不具合を再現**。diagnostic の OBSERVE は合格扱いではない |

最初の H-01 探索では count 応答を保留して close/evict 後に解放し、古い filtered read がその後完了することも観測した（他 tab と reopen の UI は正常）。これは cache/grant 件数の証明ではない。通常の S15 は filtered **read** 応答を保留して UI の正しい結果を検証する。将来不要な read が抑止されても回帰テストがそれを要求しないよう、古い read の発生自体を合格条件にはしていない。

## 検証・証拠

| 検証 | 結果 |
|---|---|
| production frontend build / Rust bridge build | 成功 |
| 追加 S15–S18 | 12 PASS、0 FAIL/ERROR、1 OBSERVE（既知 screenshot CSP） |
| S9 fixture override 修正後 | 31 PASS、0 FAIL/ERROR、4 OBSERVE |
| runner の browser error gate | 3 tests 成功 |
| EX-01 独立診断 | exact console照合1 PASS、EX-01/回復/既知CSPを3 OBSERVE、0 FAIL/ERROR。不具合解消ではない |
| 通常全 suite（S9固定名修正前のプロセス） | 243 PASS、5 FAIL、63 OBSERVE。失敗は下記S9固定名5件だけ。修正後のS9は上記31 PASS |
| syntax / git diff --check | 成功 |

[通常全suiteの生結果](exploratory-evidence/full-suite-results.json)、[追加・S9・診断の生結果](exploratory-evidence/results.json)、[EX-01: UI page2 のスクリーンショット](exploratory-evidence/EX-01-save-failure.png)、[S18:復元後の5 tabs](exploratory-evidence/S18-recovered.png)を保存した。EX-01のdisk page1と試行数はJSONの診断結果に記録している。

全suiteは修正前のsuite.mjsを読み込んだプロセスで走ったため、S9.rootStored / workspaceWithoutTabs / crumbBounded / search / secondRoot が `fixtures` 固定期待値で失敗した。他の243確認は成功。最終コードのS9を別のdataDirで再実行し、5件を含む31確認すべて成功した。全suiteを再度一括実行したという意味ではなく、変更部分の再検証で失敗を解消した。

初回のS16は成功画面のCloseがiconと本文buttonの2件に一致し、テスト側のstrict locator errorになった。本文buttonへ限定して再実行し、上記12確認が成功した。これはアプリのエクスポート失敗とは区別する。

追加回帰テストは [exploratory.mjs](../../scripts/qa/e2e/exploratory.mjs) の S15–S18（S17は保存・再起動の2 scenario）。[suite.mjs](../../scripts/qa/e2e/suite.mjs) が通常実行で呼ぶため、既存 CI の `pnpm ... suite` に含まれる。独立したエントリを置いただけではない。

通常ファイルを親にする ENOTDIR は root/host権限に依存しない。遅延は実応答を保留する gate で順序を固定し、IPCの到着・DOM状態・disk保存に待機する。S9 の5つの folder 名 assertion は `fixtures` 固定から `base(FIX)` に変更し、専用 FIXTURES override で同じ機能を検証できるようにした。

`exploratory-diagnostics.mjs`（`9c37727` 時点、EX-01 修正の merge 後に削除）は EX-01 の独立再現コード。通常 CI には含めない。期待した console.error を exact message 1件だけ照合し、追加エラーは既存 runner の FAIL 対象のまま。スクリーンショットには runner wrapper を使い、既知の Playwright CSP 警告1件だけを OBSERVE に記録する。

## 新規所見と対応

**EX-01（中）: セッション保存失敗後、同じ状態を pagehide で再試行できない。**

追記（修正後）: 成功応答後だけ保存済みと判定し、最新の未保存状態を保持するよう修正。
保存を直列化し、pagehide・画面内の「再試行」・次の永続状態変更を再送契機とする。
失敗自体による即時リトライは行わない。失敗通知は英日対応の非モーダル表示で、
最新状態の保存成功時に消える。console.error も診断用に残す。
通常 suite の `S11-session-save-retry` が同じ状態の再送・実ディスク保存・通知の解消を検証する。
以下の診断結果は修正前の履歴であり、旧独立診断は修正後の合格判定には使用しない。
実 macOS Quit 時の IPC 完了保証は引き続き手動検証の範囲。
検証: `cargo build --locked --example bridge`、`pnpm --dir frontend build`、
`pnpm --dir frontend test`（32 files / 281 tests）が成功。
CSP サーバーに対して専用 E2E_OUT を使った `ONLY=S11 pnpm suite` は
21 PASS / 0 FAIL・ERROR / 既知スクリーンショット CSP の 1 OBSERVE。
修正前の独立診断で UI page2 / disk page1 / 保存試行1回を再現し、
新規単体テストの失敗も確認してから修正した。

`frontend/src/contexts/WorkspaceContext.tsx` の235–263行付近で、lastSavedSession は保存成功前に更新され、pendingSession は呼出し前に消される。失敗後の同じ状態では保存が予定されず、pagehide にも送るものがない。表示 page2 / disk page1 / attempts=1 を観測。状態を page3 に変えると disk page3 / attempts=2 になり、永続化サービス全体の停止とは区別できる。

修正は本節と保存済み診断だけから再開できる。修正時は成功済み snapshot と未保存 snapshot を区別し、最新状態の失敗後再試行を残すこと、古い成功・失敗が新しい pending を消さないこと、復元中の空 snapshot 保存抑止をテストする。無制限の即時リトライは避ける。診断の悪い現状を通常 CI の期待値にはせず、修正と正しい期待値の回帰テストを同じ修正ブランチで検証する。

監査時点で CT-01〜CT-05 は未修正だった。着手優先順位は監査の CT-01 → CT-03 → CT-02 → CT-04 → CT-05 を基準とし、EX-01 は中優先の保存修正として独立実施できる。詳細は [code-test-audit.md](code-test-audit.md)。

## 未検証範囲

- CT-01 の別 volume・最終 copy 中の容量不足/I/O障害: OS/volume障害を注入していない。S16のENOTDIR成功では既存出力の最終置換安全性を保証しない。
- CT-02/CT-04/H-01 の実 grant 解放・cache資源計数: NoopBookmarks基盤では観測していない。UI正常を資源解放の証拠にしない。実行中 SQL/export の close も今回未追加。
- StoreKit実購入・返金・遅い初期成功、ネイティブのFinderイベント・grant: scripted store / seedイベントと別。MQ-8/9/11/12 の署名済み実機検証が必要。
- 実⌘Q/window close直前250ms未満の保存完了、強制kill、保存のbackend到達逆転: 今回は synthetic pagehide の後に disk書込を待つ。EX-01はAPI rejectを注入したfrontend再試行の診断で、実disk故障や終了の再現ではない。
- restore途中のnative drop、型不正settingsからのopen、Recent Files初期一覧の競合: 今回は保存失敗・実ディスク復元を優先し未追加。既存 S8 / CT-05 の監査結果を超える保証はしない。

既存 S1 の破損/空/特殊値、S10 の置換/消失、S11 の一部消失、S12 の復元後open、S14のcapped restoreは通常suiteで併せて実行する。ローカルの合格はTestFlight相当、リリース可否、バグ不存在の保証ではない。

## 後片付け・ローカル状態

テスト・再現コードは `9c37727` にコミット済み。レポートと証拠は同じ `qa/exploratory-tests` に保存。起動したCSPサーバーを停止し、browser/bridgeはrunnerで終了、今回作成した一時fixture・app data・export・ログを削除した。生結果・スクリーンショット・[runnerログ](exploratory-evidence/runner.log)・[buildログ](exploratory-evidence/frontend-build.log)はリポジトリに保存した。完了した一時指示 `spec3.md` だけを削除し、既存CT修正specと新規EX-01修正specは保全した。mainはspec2まで、spec3は作業ブランチのローカルコミットまで。
