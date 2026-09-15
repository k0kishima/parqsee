# リリース前クラッシュ探索（2026-09-15）

追記: EX-20260915-01はユーザーの修正依頼を受けて修正済み。以下の調査本文と証拠は修正前の記録であり、修正内容・検証結果は末尾を参照。

対象: `b9ec591f4e3457033cb3b186247e85392d333078`、Parqsee 1.0.0。調査のみ。アプリ・既存テストのコード変更、コミット、push、Issue作成は行っていない。

## 結論

保存設定に不正な `rowDensity` があると、ファイル表示時に React の描画が落ちて画面全体が白くなる不具合を再現した。保存済みタブがあれば再起動直後にも繰り返す。これはフロントエンド全体の操作不能であり、ネイティブプロセス終了を確認したという意味ではない。

通常操作から不正な値が保存される経路は未確認。設定破損を注入した条件付き所見で、通常の初回起動で誰にでも起きる問題とは判断しない。過去の監査の U-04（型不正settingsから実ファイルをopen）の追加調査に相当する。

## EX-20260915-01 — 中 — 不正な表示密度の保存値で画面全体が操作不能

影響は大きいが、発生には不正な保存値が必要なため優先度は中とした。

再現手順（隔離したブラウザ設定と実バックエンド）:

1. `parqsee-settings` に `{"rowDensity":null}` を保存した状態で起動する。`"dense"` など未知の文字列でも再現。
2. 正常な `one_row.parquet` を開く。
3. `TypeError: undefined is not an object (evaluating 'Yl[y].header')` が発生し、画面全体が白くなる。設定やタブを操作する UI も消える。
4. 別の確認では、正常設定でファイルを開き、`bookmarks.json` にセッションが保存されたことを確認して終了。その設定の `rowDensity` だけを `null` に変更して、同じ dataDir で新しいブラウザ・bridge を起動すると、操作前に白画面になる。
5. 新規プロセスで2回再現。両方とも `#root.childElementCount = 0`、bodyの文字列は空。bridge は終了していない。
6. `rowDensity` だけを `comfortable` に戻すと、同じファイル・セッションで正常復旧し、ブラウザエラーは0件。

期待: 不正な保存値を既定値に戻すなどして、ファイルを開き、設定を修正できること。

原因:

- [settings-storage.ts](../../frontend/src/lib/settings-storage.ts) の `loadSettings`（56–66行）は JSON をパースした結果をそのまま既定値に重ね、値域を検証しない。JSONとして正しい `null` / 未知の値はcatchされない。
- [data-table.tsx](../../frontend/src/features/file-viewer/components/data-table.tsx) の226行で `ROW_DENSITY_CLASSES[density].header` を参照するため、未知のキーでTypeErrorになる。252行のcell参照も同じ前提。
- [main.tsx](../../frontend/src/main.tsx) から描画するツリーに、このエラーを局所化するError Boundaryがない。エラー発生後にルート全体が空になったことを実測した。
- Query側の [query-results.tsx](../../frontend/src/features/query/components/query-results.tsx) も同じ辞書参照を使うが、この所見の動的再現はContent表示で行った。

修正する場合の方向性: 保存値の読み込み境界で enum・型・数値範囲を検証して既定値へ復帰させる。画面単位の例外復旧も検討対象。今回は未修正。

証拠: [初回open・設定別の生結果](crash-exploration-2026-09-15-evidence/exploration.json)、[セッション再起動2回と復旧](crash-exploration-2026-09-15-evidence/recheck.json)、[白画面](crash-exploration-2026-09-15-evidence/restart-blank.png)、[同じセッションの復旧画面](crash-exploration-2026-09-15-evidence/recovered.png)。

## 同じ原因に関連する観測

`rowsPerPage: 0` はクラッシュしないが、1行のファイルで行が表示されず `Showing 1 to 0 of 1 entries` / `of Infinity` になる。[画面](crash-exploration-2026-09-15-evidence/rows-zero.png)。負数と文字列 `"50"` はファイル表示エラーになる。後者の `missing limit` はbridgeの引数検証文言であり、ネイティブIPCの文言とは限らない。これらは不正設定の検証不足にまとめ、独立したクラッシュ件数に数えない。`language: null` はこのbridgeではファイル表示可能だったが、bridgeの `set_menu_language` は引数を検証しないため、ネイティブの同等性は主張しない。

## 探索範囲と結果

既存 S1–S18 の全suiteは **260 PASS / 0 FAIL・ERROR / 64 OBSERVE**、プロセス終了コード0。破損・空・特殊型・600列のファイル、ページング、filter/search、SQL、CSV/JSON export、tabs/recent、settings、folder explorer、ファイル置換・消失、session、Finderイベント相当、sample、scripted課金UI、非同期競合と失敗後の再試行を実行。[全結果JSON](crash-exploration-2026-09-15-evidence/suite-results.json)、[実行ログ](crash-exploration-2026-09-15-evidence/suite.log)。OBSERVEは合否を判定しない観測であり、PASS件数には含めない。

- 設定7通り: 正常、密度null、未知の密度、ページ件数0・負数・文字列、言語null。上記の白画面とページ表示異常を発見。
- SQL7通り: 重複エイリアス、最大i64のtimestamp変換、不正な数値cast、ゼロ除算、2000項目のIN、200段の括弧、正常な `SELECT 42 AS recovered`。重複名・cast・ゼロ除算・再帰上限の4件は表示されたSQLエラーとして確認し、その後正常SQLで42を表示。バックエンド終了と未捕捉JS例外は確認せず。
- SQLの実応答を保留し、タブを閉じて別ファイルを開いてから応答を解放。別タブは正常な1行のまま。これは応答到着の競合であり、長時間クエリのキャンセルを検証したものではない。
- nested/numericのopenとcloseを12サイクル実施し、最後のone_rowは正常表示。各サイクルで全データの一致まで保証するテストではない。
- 正常な411 bytesのParquetの32か所を、それぞれ1 byteだけXOR 255で変えた入力。各ケースを独立した実bridgeでmetadata取得・50行read・正常ファイルreadに渡し、8秒で打ち切る設定で検証。32/32で全3応答が返り、プロセスは正常終了、panicなし、正常ファイルのread成功。29ケースはmetadata/readのどちらかでエラーを返した。[生結果](crash-exploration-2026-09-15-evidence/mutations.json)。UIを介さないサービス検証であり、ファイル形式全体のfuzz網羅を意味しない。
- 正常セッション作成→不正密度で2回起動→密度だけ正常化、という4回の独立起動で再現性と復旧を確認。

24ファイル（付属サンプルのコピー）の一括drop、24タブのセッション復元、24タブをすべて閉じてサンプルを再openする操作も確認。3段階すべてでブラウザエラー0件、最後はサンプルの1,500行のメタデータとグリッドを表示した。[生結果](crash-exploration-2026-09-15-evidence/stress.json)。初回の追加スクリプトはボタン名を `Open sample` と誤指定し、最後のclickだけタイムアウトした。実表示の `Open the sample file` に合わせて再実行した上記結果を採用し、[初回ログ](crash-exploration-2026-09-15-evidence/stress-first.log)も保存した。製品の失敗には数えない。

## 環境・再実行

macOS 26.6.2 (25G83)。production frontend (`pnpm --dir frontend build`) と最新Rust debug bridge (`cargo build --locked --example bridge --manifest-path backend/Cargo.toml`) をビルド成功。CSPは `backend/tauri.conf.json` の設定をローカルHTTPサーバーに適用。WebKitはPlaywright 1.62.1経由。専用 `PARQSEE_DATA_DIR` 相当のdataDirと生成fixtureを使用し、実ユーザーのファイル・設定・購入状態は変更していない。

リポジトリルートでbuildとfixture生成を行い、`scripts/qa/e2e` でCSPサーバーを起動する。

```sh
cargo build --locked --example bridge --manifest-path backend/Cargo.toml
pnpm --dir frontend build
uv run scripts/qa/gen_fixtures.py /private/tmp/parqsee-crash-0915-fixtures
pnpm --dir scripts/qa/e2e csp-server
```

別の端末の `scripts/qa/e2e` で実行:

```sh
DEV_URL=http://localhost:1421/ \
  FIXTURES=/private/tmp/parqsee-crash-0915-fixtures \
  E2E_OUT=/private/tmp/parqsee-crash-0915/full node suite.mjs
```

追加探索の [explore.mjs](crash-exploration-2026-09-15-evidence/explore.mjs)、[recheck.mjs](crash-exploration-2026-09-15-evidence/recheck.mjs)、[stress.mjs](crash-exploration-2026-09-15-evidence/stress.mjs)、[mutations.py](crash-exploration-2026-09-15-evidence/mutations.py) は調査時の原本。Node版にはリポジトリの絶対importパスがあるため、別checkoutでは読み替える。`DEV_URL`、`FIXTURES` は上記と同じにし、`E2E_OUT` は各スクリプト用の別ディレクトリを指定する。Python版はリポジトリルートから実行。通常CIへの登録はしていない。

探索スクリプトのJSONは観測記録であり、終了コード0をバグ不存在の判定に使わない。SQLのconsoleエラーはその時点までの累積。異常SQL4件と一致し、以降のタブ操作では増えていない。スクリーンショット時だけ出る既知のPlaywright stylesheet CSP警告は既存runnerが1件限定で記録する。通常suiteは期待されたエラーをexact messageで照合し、それ以外を失敗にする。

初回のsandbox内実行はlocalhostアクセス制限で起動できず、許可された実行でやり直した。これはアプリの不具合として数えていない。

## 制限

実際のTauriシェル・署名済み `.app` は今回操作していない。macOSのウィンドウ管理・Finderイベント・Sandboxのアクセス権・実StoreKit・ネイティブ終了時の保存は未検証。bridgeはサービスを実行するが、Tauriコマンドのpanicを捕捉する `guarded` ラッパーを通らない。この差があるため、bridgeのpanic/hangをそのまま製品のクラッシュとは判定しない。今回はこの入力集合でbridgeのpanicは観測していない。

メモリ不足・ディスク容量不足・巨大データでのOOM・長時間SQLの停止操作は今回検証していない。debug bridgeの所要時間をリリース版性能の判定に使わない。結果はこの入力・操作範囲のもので、ネイティブプロセスのクラッシュ不存在やリリース可否を保証しない。

## 成果物・作業状態

このレポートと隣接するevidenceディレクトリのみを追加した。アプリの修正は未実施。実行時のfixture・出力は `/private/tmp/parqsee-crash-0915*` に残し、再現コード・結果・主要画面は本ディレクトリにも保存した。

## 修正追記（2026-09-15）

`loadSettings` で保存JSONのトップレベルと各項目を検証するよう修正した。不正なenum・型は項目ごとに既定値へ戻し、正常な他の設定は維持する。ページ件数はUIで選択できる25/50/100/200/500のみを許可し、選択肢をUIと共有することで0・負数・文字列・過大値が読み取り要求へ流れることも防ぐ。SettingsProviderの既存保存処理によって正規化した設定がlocalStorageへ保存される。汎用Error Boundaryの追加は行っていない。

- 修正前の回帰単体テスト: 不正密度・ページ件数など14ケースが失敗することを確認。
- 修正後のfrontend全体: 32 files / 329 tests成功。本番ビルド成功。
- CSP + 実Rust bridge + WebKitの `ONLY=S8` : **28 PASS / 0 FAIL・ERROR / 3 OBSERVE**。新規ケースは正常タブの実ディスク保存後、新規ブラウザ・bridgeでnull/未知文字列/constructorの密度と0/負数/文字列のページ件数を注入して起動。Contentの正常な1行、SQLの42、設定の正常化、正常なdarkテーマの保持を確認した。
- 新規E2Eの最初の実行では隠れたContentのtbodyとQueryのtbodyの両方を選択したテスト側のlocatorエラーが発生した。表示中の表へ限定し、最終コードでS8全体を再実行して上記成功を確認した。
- syntax / git diff --check成功。アプリ修正後に全S1–S18を再実行したという意味ではない。冒頭の260 PASSは調査時点の修正前の記録。

回帰ケースは通常suiteの `S8-settings-seed` / `S8-settings-restore-*` に追加済み。`ONLY=S8` でseedを含めて実行する。

証拠: [修正後E2E結果](crash-exploration-2026-09-15-evidence/fixed-s8-results.json)、[修正後E2Eログ](crash-exploration-2026-09-15-evidence/fixed-s8.log)、[frontendテストログ](crash-exploration-2026-09-15-evidence/fixed-frontend-tests.log)。未コミット・未push。
