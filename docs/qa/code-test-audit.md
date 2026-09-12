# リリース前コード・テスト対応監査

監査日: 2026-09-12。対象コミット: `9a10356d29e880661d8a3ce38d4be97b8291ecaf`。
開始時に PR #29 がマージ済みであることを `gh pr view` で確認し、`git fetch origin` 後の HEAD と origin/main の一致を確認した。ローカルブランチは `qa/code-test-audit`。

監査結果は5件（高1・中3・低1）。以下の「確認できた不具合」は、静的に確定した失敗経路と、診断で再現した状態をそれぞれ明記している。署名済みアプリでの発生頻度や OS 資源枯渇を測定したという意味ではない。本監査の対象は実装経路とテストの照合、および問題の再現・報告であり、アプリコードの修正と署名済みアプリの実機検証は含まない。

## 範囲と証拠の取り方

課金、ファイルアクセス、非同期処理、セッション復元について、UI の入口、Tauri command、サービス、外部境界、UI への結果反映を追跡した。`CLAUDE.md` のテスト説明には古い StoreKit 往復テストの記述が残るため、現在の実装・テスト・[CI 定義](../../.github/workflows/ci.yml)を根拠にした。

### 実施した検証

| 検証 | 結果と解釈 |
|---|---|
| Rust 1.91.1、`cargo test --locked --lib audit_ -- --nocapture` | 一時診断2件成功、107件対象外。失敗オープン後の grant 残留と、実時間20秒の status timeout 後の通知欠落を再現 |
| Vitest 4.0.18、3つの一時 `*.audit.test.tsx` を `-t audit` で実行 | 診断3件成功、既存52件対象外。連続オープン、課金の古い応答、Recent Files 初期一覧の競合を再現。課金はさらに初回mountでの逆転を1件再実行して成功 |
| Rust 1.91.1 公式ソース確認 | macOS の `std::fs::copy` が既存出力を truncate した後に失敗し得ることを確認。CT-01 の実ディスク容量不足は再現していない |
| 診断差分の保存・撤去 | [再現用パッチ](code-test-audit-repro.patch)に診断だけを保存し、元の Rust ファイルを復元、一時 frontend テストを撤去。アプリコードの最終差分なし |

診断の成功は「悪い現状を期待する assertion が成立した」という意味であり、回帰テスト合格や不具合解消ではない。全テスト・全 E2E の再実行はしていない。今回の疑問は指定順序のモック応答・grant 計数で切り分けられるため。Swift テストはコードを読んで経路を確認し、この監査では実行していない。

再現用パッチは対象コミットの既存テストに診断を追加する。独立した診断 checkout で `git apply docs/qa/code-test-audit-repro.patch` を実行し、backend で上記 Cargo コマンド、frontend で次を実行できる。

```sh
pnpm exec vitest run src/contexts/__tests__/WorkspaceContext.test.tsx src/contexts/__tests__/LicenseContext.test.tsx src/contexts/__tests__/RecentFilesContext.test.tsx -t audit
```

パッチの frontend 診断本体は今回実行したものと同じだが、実行時には既存ハーネスを複製した一時ファイルへ追加していた。実 StoreKit、Sandbox、IPC 配送順序をモックで証明するものではない。

## 実装とテストの対応

### 課金

入口は Settings / UpgradePrompt の購入・復元ボタン → [LicenseContext](../../frontend/src/contexts/LicenseContext.tsx) → [license API](../../frontend/src/features/license/api/index.ts) → [iap commands](../../backend/src/commands/iap.rs) → [License](../../backend/src/services/store/mod.rs) → [SwiftStore](../../backend/src/services/store/storekit.rs) → [Bridge.swift](../../backend/storekit/Sources/ParqseeStoreKit/Bridge.swift)。

- Swift は入力 C string を同期コピーして detached Task へ渡す。成功は JSON array/object、失敗は error string。Rust は callback 内で文字列を所有コピーし、one-shot の `Box<Sender>` を回収する。updates の sink はプロセス寿命。callback の panic は `catch_unwind` で包むが、不正ポインタ・二重 callback・Objective-C exception を回復できる仕組みではない。
- 購入成功は verified transaction の finish → purchased → Rust が entitlements 再取得。cancelled / pending は再取得せず現在の status と返す。復元は `AppStore.sync` → `{}` → entitlements 再取得。UI は busy を解除し、エラー表示・保留表示・アンロックを reducer で反映する。
- updates は entitlements 一覧 → Rust の snapshot 更新と `iap-status` emit → UI reducer。返金で新規タブが制限されるが、既存タブは閉じない。これは S14 の期待動作であり所見にしない。
- 起動時は LicenseProvider が最初の status を待ってから WorkspaceProvider を mount する。通常は無料枠が確定してから復元するが、CT-03 の timeout 後の成功は別経路。

| テスト | 実際に通る部分 | 通らない境界 |
|---|---|---|
| Rust `services::store::tests` | FakeStore による購入、取消、保留、復元、更新、既購入、エラー、商品選別 | StoreKit の実 transaction・認証画面・配送タイミング |
| Rust `storekit::tests` の通常実行 | 不正商品 ID の実 Swift entry point → detached callback。手作り JSON のコピー・parse、payload 不在 | 正常購入・復元・entitlements の実 StoreKit 成功 |
| Swift `EncodeJSONTests` / `DeliveryTests` | `{}`、`[]`、購入結果等の encode、NSNull 等の拒否、deliver が callback を1回呼ぶこと | 全 entry point が実 StoreKit 応答時に必ずその helper へ到達すること |
| frontend LicenseContext / reducer / purchase UI テスト | API をモックした status、エラー後再試行、pending 後 update、返金表示 | Rust / Swift、初期応答とイベントの逆転（今回追加診断） |
| E2E S14 | 本物の UI に対する scripted store と無料枠・復元 | `iap_*` をブラウザ内で置換。Rust License にすら届かない |

現在の CI は default / app-store の Rust tests、Swift tests を実行する。ただし実 StoreKit 往復3件は `#[ignore]` で通常 CI から除外される。明示実行しても成功または非空エラーを許すため、購入済みアカウントの復元成功の証拠にはならない。過去の NSNull クラッシュ対策は現在の helper テストにあり、未修正扱いにはしない。

### ファイルアクセス

ファイル選択・drop・Recent Files → `check_file_exists` / `open_parquet_file` → [ParquetCache](../../backend/src/services/parquet.rs) の metadata → [FileAccess](../../backend/src/services/access/mod.rs) の acquire。ユーザーオープンは `remember_file` で bookmark を保存し grant を保持。DataViewer は metadata を再取得し、無フィルタは blocking reader、フィルタ・SQL はキャッシュした DataFusion session から読む。タブ閉鎖 → `evict_cache` → metadata/session 削除と release。

roots は追加・起動復元から削除まで grant を保持。probe は一時 grant を取り、呼び出し終了で解放する。stale bookmark は更新するが、解決先の path が変わると Recent / session は unavailable、root は削除される。bookmark が移動先を追跡できることと、アプリが移動先へタブを追従することは別である。

| テスト | 実際に通る部分 | 残る範囲 |
|---|---|---|
| `access::tests` / `access::store::tests` | FakeBookmarks の starts/stops、再起動、stale 更新、revoked、root、session bookmark 再利用、破損 JSON / base64、atomic store 書込 | OS が本当にアクセスを許可・拒否するか。fake token は filesystem read を制限しない |
| `macos::tests::bookmarks_round_trip_and_follow_a_move` | 本物の Foundation bookmark 作成・解決・移動・削除 | 未署名テストでの往復。Sandbox の grant 強制を保証しない |
| `a_cache_entry_holds_the_files_grant_until_evicted` | 正常 metadata/session fill → evict の grant 解放 | fill が失敗した時点の解放（CT-02） |
| `eviction_cannot_reinsert_metadata_created_before_it` | 作成中の metadata に evict が待ち、作成結果を消す | evict 後に別の read が開始する順序、実行中 SQL に必要な grant |
| E2E S6 / S9 / S10 | 実 Rust export・ディレクトリ・外部変更後 Refresh | NoopBookmarks、モック save panel。署名済みアプリの保存先権限 |

export は [ExportModal](../../frontend/src/features/file-viewer/components/export-modal.tsx) → save panel → `export_data` → 一時ディレクトリで生成 → rename、失敗時 copy → 成功行数・パス表示。export folder の記録は成功後だけ。既存 export テストは不正 filter / missing source / unsupported format を使っており、最終 copy 自体の失敗は通していない（CT-01）。

### 非同期処理

- DataViewer の `loadSeq` は metadata / count / rows の古い成功・失敗の UI commit を抑止する。読取失敗時は lastGood の page/filter/total を戻し、初回読取失敗は file-level error にする。component tests の filter/page rollback と Refresh 時の eviction failure、E2E S3 の遅延競合・S10 の外部変更が対応する。
- QueryView は実行中のボタン・run-query を QueryEditor の `isLoading` で抑止し、catch/finally で再操作可能にする。単に sequence guard がないことを二重実行バグとは判定しない。同一 tick の native command 連打は未確認。
- Workspace reducer は最新状態に対してタブ追加・閉鎖を行うため、UI の無料枠超過は防ぐ。ただし非同期処理の副作用は reducer 外で進む（CT-04）。
- [commands::guarded](../../backend/src/commands/mod.rs) は future の Rust unwind を String error にする。単体テストは panic 後の次の呼び出しまで確認する。spawn_blocking の JoinError は page/export で変換する。プロセス abort、OOM、Swift/ObjC の致命エラー、poison された任意の共有状態まで復旧する保証ではない。
- [E2E bridge](../../backend/examples/bridge.rs) はサービスを直接呼び、Tauri IPC と command の `guarded` を丸ごと通すわけではない。browser の console.error / pageerror / rejection を FAIL にする既存 runner は有効だが、実行されなかった経路は検出できない。

### セッション復元

Settings は localStorage を同期ロード。License の初回 status 後、roots と session を取得し、available なファイルを順に reopen、無料枠の残りを capped notice にする。`sessionReady` になるまで保存せず、その後250ms debounce で snapshot を保存する。保存先は FileAccess の mutex 下の `bookmarks.json`（temp + rename）。

Finder 起動のファイルは [PendingOpen](../../backend/src/services/opened.rs) が保持し、frontend が listener 登録完了かつ sessionReady 後に take する。Finder の通常経路は restore 後に開いて active にする。native drop は backend が直接 emit するため、cold Finder buffer と完全に同じ入口ではない。

| テスト | 確認する内容 | 保証しないこと |
|---|---|---|
| WorkspaceContext session tests | 初期保存抑止、order / active / view / page / filter、失敗ファイル通知、無料枠、restore OFF | 実 bookmark / 実ディスク書込 |
| `writes a pending change at once when the page is hidden` | synthetic pagehide でモック saveSession を呼ぶ | macOS 終了時に event が来るか、非同期 IPC / disk write の完了を待つか |
| Rust store / access / PendingOpen tests | session 正規化・cap・bookmark 再利用、ファイル消失、URL decode、take 前後の振分け | native Opened event の配送と WebView 終了 |
| E2E S8 / S11 / S12 / S14 | 破損 store 起動、同じ dataDir で再起動、missing/capped、seeded Finder ファイルを最後に open | 本物の Quit、署名済み sandbox、StoreKit 状態確定の遅延 |

破損 JSON / 不正 base64 は空 store として起動し、次回変更で置換する既存仕様。保存データの救出保証はない。S8 の settings 破損ケースは `rowsPerPage: "x"` を入れて Welcome が表示されることまでで、そこからファイルを開く検証ではない。

## 確認できた不具合

### CT-01 — 高 — 最終 copy 失敗時に既存エクスポートを壊し得る

- **証拠:** [export.rs](../../backend/src/services/export.rs) 170–179行。rename が失敗すると既存の export_path へ `std::fs::copy` を行い、結果の成否によらず staging を削除する。[Rust 1.91.1 公式実装](https://github.com/rust-lang/rust/blob/1.91.1/library/std/src/sys/fs/unix.rs#L1966)では既存宛先を truncate してから macOS の fcopyfile を行う（同ファイル2048–2092行）。これは復元可能な置換ではない。
- **再現条件:** 既存の CSV/JSON へ上書きし、別 volume 等で rename を失敗させ、copy 開始後に容量不足 / I/O error を発生させる。静的に確認できた失敗経路。実 volume・Sandbox での障害注入は未実施。
- **影響:** export がエラーになっても以前の出力は元に戻らず、完全な新出力である staging も失われる。ユーザーデータ破損のため高。rename 成功時や生成段階の失敗とは分ける。
- **既存テストの穴:** `a_failed_export_leaves_an_existing_destination_untouched`（464行以降）の3失敗は copy 前。保存先の途中書込・置換失敗を注入していない。
- **対応案:** 出力先の既存内容を壊さない確定処理にする。Sandbox で必要な権限を含めて設計し、安全な置換ができない場合は既存ファイルを変更せず失敗させる。copy failure を再現できる I/O 境界の回帰テストが必要。
- **着手順・依存関係:** 最優先、依存なし。

### CT-02 — 中 — 失敗した cache fill に grant の後始末がない

- **証拠:** [parquet.rs](../../backend/src/services/parquet.rs) 129–136行、179–180行で acquire 後に `?` で戻り、release は evict（194–208行）だけ。[WorkspaceContext](../../frontend/src/contexts/WorkspaceContext.tsx) の open/restore の catch は失敗パスを evict しない。
- **再現:** 一度記録したファイルを壊す → grant を解放した状態から get_or_create_metadata → decode error。診断で metadata/session とも0件なのに FakeBookmarks の active が1件残ることを確認。明示 evict でのみ0件に戻る。
- **影響:** オープンできずタブもないファイルの grant がプロセス終了まで残る。異なる失敗ファイルを開き続けると保持数が増える。OS の上限値・実際の枯渇は未測定。同じ path を繰り返すだけでは acquire が idempotent なので数は増えない。
- **既存テストの穴:** grant 計数テストは正常 fill → evict だけで、エラー return を検査しない。E2E は NoopBookmarks。
- **対応案:** fill の所有権を明確にし、失敗時にその操作が取った不要な grant を解放する。metadata と session が共有する grant を、片方の失敗で使用中に解放しない設計・テストを含める。
- **着手順・依存関係:** CT-01 / CT-03 の次。依存なし。

### CT-03 — 中 — 課金状態が最新の backend 状態へ収束しない

同じ表示状態の同期問題として、次の2経路をまとめる。

1. **遅い初期成功:** [store/mod.rs](../../backend/src/services/store/mod.rs) 166–186行の init / refresh は snapshot を更新するだけ。on_change を呼ぶのは start_updates の callback。status（201–207行）が20秒で Free を返した後に init が成功しても通知されない。[LicenseContext](../../frontend/src/contexts/LicenseContext.tsx) 52–80行は mount 時に一度取得し、その後はイベントを待つ。診断で timeout Free → init 後 backend Unlocked、通知0件を確認した。テストの AlwaysUnlocked は「成功する entitlement 読取」の代用で、StoreKit の遅延は再現していない。
2. **古い status 応答:** 同 Context の getIapStatus の then はイベントと無条件に同じ reducer へ status を渡す。起動時の Unlocked 応答を保留 → refund Free イベントを届ける → 古い Unlocked 応答を完了、の診断で UI が Unlocked に戻った。実 IPC での発生頻度は未測定だが、到着順序を指定した UI 層の再現は成立する。

- **影響:** 購入済みでも無料表示が残り、新規タブが制限される。起動時の誤った Free は復元を3件に制限し、次の保存で capped 分を session から除く。逆方向では返金後の無料制限が古い応答で解除される。現状は手動復元・再取得・次の update 等で回復し得る。
- **既存テストの穴:** Rust の `status_before_init_reports_the_wait_instead_of_hanging` は init をすぐ実行し、実 timeout を通さない。frontend の refund test は応答保留中のイベント逆転を通さない。
- **対応案:** 遅れて確定した初期状態も配送し、subscribe / 初回取得の隙間と古い応答の上書きを防ぐ。単純な「最後に返った値」ではなく新旧を判別できる契約を検討。restore 中の read と update の逆転も同じ観点で検証する。
- **着手順・依存関係:** CT-01 の次、独立実施可。セッションへの影響も検証する。

### CT-04 — 中 — 無料枠へ同時に open すると、表示しないファイルが backend に残る

- **証拠:** [WorkspaceContext](../../frontend/src/contexts/WorkspaceContext.tsx) 324–368行では ref の現在タブ数を検査した後、exists → open → remember → dispatch を非同期実行。[workspace-tabs.ts](../../frontend/src/contexts/workspace-tabs.ts) 85–88行は最終的に上限なら state をそのまま返すが、backend の後始末や通知は行わない。
- **再現:** 無料枠でA/Bを開く → C/Dを並行 open。診断でUIは3タブ、Dにも open と remember が呼ばれ、Dの evict と upgrade 表示はいずれも0回。複数 drop イベント等が重なると到達可能。UI上限超過ではない。
- **影響:** タブに存在しない D の metadata / bookmark grant が残り、Recent Files にも記録される。ユーザーは表示されなかった理由を知らず、そのタブを閉じて解放することもできない。
- **既存テストの穴:** `holds the limit when files open back to back without a render in between` はUIタブ数だけを検査。S14 の通常4件目は前のタブを描画した後で開く。
- **対応案:** pending open を含む枠確保や open の直列化等で、拒否する path を backend で開かない。完了時に拒否する方式なら確実な後始末と通知が必要。同じ path の重複 open や成功タブの grant を誤って evict しないことも検証。
- **着手順・依存関係:** CT-02 の後を推奨（同じ cache/grant の終端を扱う）が必須依存はない。

### CT-05 — 低 — Recent Files の初期応答が新しい操作を上書きする

- **証拠:** [RecentFilesContext](../../frontend/src/contexts/RecentFilesContext.tsx) 39–53行で初期一覧を無条件 setRecentFiles。途中の upsert / clear / remove と世代を共有しない。backend の recent_files は [access/mod.rs](../../backend/src/services/access/mod.rs) 384–399行で一覧を clone してから遅い probe を行うため、古い一覧が後着する入口がある。
- **再現:** listRecentFiles の応答を保留 → new.parquet を upsert → old.parquet だけの初期応答を返す。診断でnewが消えてoldのみになる。clear の後なら古い一覧の復活も同じ処理で生じる。
- **影響:** 起動直後に開いた履歴が一覧から消える等のUI不整合。backend の記録はこの古い応答では書き戻されず、データ破損ではない。
- **既存テストの穴:** 一覧取得完了後の操作だけを検査し、取得中の操作を挟まない。
- **対応案:** 初期取得と差分操作を順序付ける、または古い snapshot を無効化して authoritative な一覧を再取得する。clear / remove 済みの項目をmergeで復活させない。
- **着手順・依存関係:** 他の4件の後、依存なし。

## 未検証経路

不具合とは断定せず、以下を実環境または専用テストで確認する。

| ID・重要度 | 根拠・不足 | 操作と期待結果 / 次の対応 |
|---|---|---|
| U-01・高 | Swift helper tests と scripted IAP は実ストアの成功を通さない | 署名済み StoreKit 環境で、既購入の復元成功・取消・ネットワーク失敗後再試行・pending 承認・返金。crash なし、busy 解除、UI と entitlement が一致。MQ-12 に記録 |
| U-02・中 | 未署名 Foundation と FakeBookmarks は Sandbox のアクセス拒否を再現しない | 外部folder/fileを開く→Quit→再起動、root削除後の開いているfile、move/delete/stale、export panelで選んだ既存file。実URLのstart/stopと読み書き結果を記録 |
| U-03・中 | synthetic pagehide は非同期保存の完了を観測しない | 250ms以内のpage/filter変更後に⌘Q、window close、通常の待機後Quitを比較。最後の正常snapshotが残り、空sessionにならない。強制killは通常Quitと分ける |
| U-04・中 | `loadSettings` はparse結果をdefaultsへspreadするだけ。S8は不正rowsPerPageからWelcomeまで | 型不正settingsで実ファイルをopen、session stateの0 / 範囲外pageもrestore。UIが操作可能で、不正値がIPCエラーのループを作らないことを確認 |

## 追加調査が必要な仮説

| ID・重要度 | 仮説と証拠 | 確定に必要な診断 |
|---|---|---|
| H-01・中 | DataViewer 149–155行はcount後に古い要求でもreadを送る。unmount時にcancelせず、cacheはtabの存否を知らない。タブ閉鎖/evict後にreadが到着するとsession/grantを再作成し得る。また実行中SQLはcloneしたsessionを使うがgrantはevictで解放される | countを保留→close→evict完了→count解放→read、及びSQL/export実行中closeを、cache件数と実Sandboxアクセスの両方で観測。現行evictionテストの順序とは別 |
| H-02・中 | WorkspaceContext 235–263行は保存成功前にlastSavedSessionを更新し、flush前にpendingを消す。reject後の同一snapshotは再試行せず、複数saveの完了を直列化しない | 保存失敗後pagehide / 同一状態、旧saveと新saveのbackend到達逆転を注入。実ディスクsnapshotの新旧とユーザーへの通知を観測。mutexは同時書込を防ぐが世代は判定しない |
| H-03・中 | License.init は初回entitlements完了後にupdates購読を開始する。初回が返らないと購読も始まらない。one-shot call に本番timeoutがないため購入/復元busyが長時間残る可能性 | 実StoreKitの配送・応答保証を公式仕様と署名環境で確認し、遅い/返らない呼出しを注入。安易なtimeoutでcallback用Boxを先にfreeしない。CT-03の通知欠落とは区別 |

仮説は表に示した診断で確定させてから修正対象とする。特にH-01の「タブを閉じれば確実にクラッシュする」、H-03の「実ストアが必ず返答を失う」といった断定はしない。

## 優先する探索的テスト

| 順位 | 操作・入力 | 期待する観測 |
|---|---|---|
| 1 | CT-01: 破棄可能な既存CSV/JSON、別volume、最終copy中の容量不足/I/O失敗 | 失敗前後のhash・sizeとstagingの有無を記録。既存出力を保全できることが合格条件 |
| 2 | U-01 / CT-03: 既購入アカウント、起動時20秒超の遅延、4件以上の保存session、復元・pending承認・返金 | backendとUIのstate、復元tab数、notice、更新後の新規open可否。timeout後の成功でUIが収束すること |
| 3 | CT-02 / CT-04: 記録済みファイルを破損、2tab状態で異なる2fileを連続drop | 失敗/rejectされたfileのcache/grantが残らず、拒否理由が表示されること |
| 4 | H-01: 大きいfileのfilter count / SQL / export中にtab close、直後に同じfileをreopen | 閉鎖後cacheの復活、権限error、stale表示、spinnerの持続を観測。新しいtabの正常操作を確認 |
| 5 | U-03 / H-02: page/filter変更直後Quit、保存失敗後Quit | 再起動後のsnapshotが直前の期待状態。IPCを送っただけで合格にしない |
| 6 | U-02: 外部rootの削除、file移動・消失、cold Finder openとrestore | 権限保持と解放を確認。現在の仕様では移動fileはunavailable、移動rootは除去。Finder指定fileがrestore後にactive |
| 7 | CT-05 / U-04: 起動時一覧遅延中のopen/clear、型不正settingsからfile open | 最新の操作を一覧が維持し、起動後もpage/filter/SQLを操作可能 |

探索的テストでは、ブラウザでの結果をnative項目の合格根拠にしない。リリース可否を保証する報告ではなく、CT-01の既存ファイル保全と実StoreKit成功経路は優先して解消・確認する。修正着手順は CT-01 → CT-03 → CT-02 → CT-04 → CT-05。各修正では本書の再現条件と期待結果を回帰テストにし、実機でのみ確認できる部分は別途結果を記録する。
