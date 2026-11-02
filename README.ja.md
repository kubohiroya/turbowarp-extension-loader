# turbowarp-extension-loader

[English](README.md) | 日本語

[Editor Issue #4](https://github.com/kubohiroya/turbowarp-plus-editor/issues/4) の GUI 非依存コアです。独立Gitリポジトリで管理し、`@kubohiroya/turbowarp-extension-loader` として npm に MPL-2.0 で公開しています。既存の配布ライブラリや npm パッケージを置き換えません。

```sh
npm install @kubohiroya/turbowarp-extension-loader
```

## 実装範囲

- `project.json` の独自フィールド `turboWarpPlus` に schema v1 の Manifest を配置します。標準 SB3 仕様ではありません。
- Manifest の厳格検証、未知フィールド拒否、重複・標準拡張 ID 拒否、依存順、循環・欠落依存拒否。
- 拡張ごとに4つの source 形式のいずれかで解決、SHA-256 必須固定、UTF-8 検証、コードごと・全体のサイズ上限。
- SHA-256 キーのキャッシュポート。読み出すたびに exact bytes を再検証し、キャッシュ利用時もホストの認可を要求します。
- 明示的なホスト認可後、全拡張の検証・認可が揃ってから登録を始めます。登録 ID 不一致・登録失敗はホスト transaction の rollback を要求します。
- キャンセル、取得・認可のタイムアウト、Remote の一時的な失敗の有限回の再試行、重複ロード拒否、unload、診断イベント。

標準拡張・汎用カスタム URL・従来の Data URL は読み替えません。Manifest がない作品ではホストポートを呼び出しません。作品内の `execution: "unsandboxed"` は要求値であり権限ではありません。`trusted` などの未知フィールドは拒否します。

### ソースの形式

`source` は拡張のバイト列の所在を示します。作者が決めるもので、4つの形式があります。この4つは SB3 の保存形式および選択画面と同じ名前なので、層の間で読み替えが起きません。

| 形式 | 構造 | バイト列の出どころ |
| --- | --- | --- |
| `remote-non-cacheable` | `{type, url}` | 毎回 `url` を HTTPS 取得 |
| `remote-cacheable` | `{type, url}` | cache port、無ければ `url` を HTTPS 取得 |
| `embedded-file` | `{type, path, url?}` | `path` のアーカイブ内エントリ、無ければ `url` |
| `embedded-data` | `{type, url?}` | 作品の文書の `data:` 運び手、無ければ `url` |

embedded の2つは兄弟です。どちらも「作品だけで、オフラインで、どこでも動く」を実現します。違いは運び手で、運び手が「ほかに誰が読めるか」を決めます。`embedded-data` は、標準 TurboWarp がこの Manifest を知らないまま作品を開けるようにする形です。標準ホストは作品の文書の中の URL を探すので、バイト列がその URL そのものになります。

持っている中身は弱いソースではありません。ManifestがSHA-256を固定しているため、固定されたコードそのものか、さもなくば `DIGEST_MISMATCH` で失敗します。運び手が欠けている場合は `retained-copy-unavailable` を診断として報告して `url` へ退避し、その URL は参照形と同じ redirect・最終URL方針のもとで固定バイト列を返さなければなりません。`path` は `extensions/*.js` 方針に従います。

キャッシュを読み書きするのは `remote-cacheable` だけです。embedded の作品は既に中身を持っているので、ブラウザーに2つ目の控えを置いても得るものがなく、作者もそれを求めていません。

古い版が使っていた3つの綴り（`remote`、`cached`、`embedded`）は**拒否します**。それぞれ、何が置き換えるかをメッセージで示します。対になった2つは読み替えもしません。古い名前は選択を暗黙にしていたので、それを決めるのは読む人です。

## ホスト側の接続

```js
import {createExtensionLoader, createFetchPort} from '@kubohiroya/turbowarp-extension-loader';

const loader = createExtensionLoader({
    embeddedReader: archiveReader,
    fetcher: createFetchPort(),
    trustProvider: {
        async authorize(resolved, {signal}) {
            const approved = await showHostPermissionDialog(resolved, signal);
            return {allowed: approved, scope: 'digest', sha256: resolved.sha256};
        }
    },
    registrar: hostTransactionalRegistrar,
    diagnostics: event => displayDiagnostic(event)
});

await loader.loadProject(parsedProjectJSON);
// A new project must unload the prior project first.
await loader.unload();
```

`trustProvider` はホストが所有します。要求 ID、バージョン、申告発行者、取得元、SHA-256、要求 capability を受け取り、承認 UI やホストの固定ポリシーを使って判断してください。作品内の名前・ドメイン・発行者文字列だけを承認の根拠にしません。SHA-256 は内容の一貫性を保証するだけで安全性や発行者の本人性は保証しません。ホストは承認履歴の保存・取消・有効期限を管理します。

登録ポートは `begin({signal})` → `register(authorizedCode,{signal})` → `commit({signal})` を実装し、どの登録が失敗しても `rollback()` で登録状態を復旧できる必要があります。`register()` は実際の `getInfo().id` と対応する登録結果 `{id}` を返します。ホストは既存 VM 内の ID 競合も拒否してください。`unload(ids)` は依存の逆順で呼ばれます。契約は TypeScript の型（`dist/*.d.ts` として公開）に記載しています。

実VMアダプターは `scratch-gui/src/lib/tw-plus-extension-registrar.js` が所有します。VMへ追加する `getExtensionServicePort()` と組み合わせ、同一VMの登録テーブル・dispatchサービスの所有権を追跡してrollback/unloadします。Editorと別バンドルのPackagerもVM内の同じサービスを利用します。標準VMを使用する同一バンドルではdispatch同一性を確認し、未対応の別バンドルでは拒否します。Loaderコア自身はVM private APIへ依存しません。

## セキュリティ境界と制約

- core は JS を評価しません。評価権限と VM 内部 API はホストに限定します。
- ロールバックはホストの拡張登録状態の保証です。一度評価した特権 JS の DOM / ネットワーク等の副作用を巻き戻すことはできません。安全なコードの承認は別途必要です。
- 初期版は Remote の HTTP、資格情報付き URL、フラグメント、リダイレクトをすべて拒否します。HTTPS URL の正常取得だけで認可しません。
- `createFetchPort()` はリダイレクト無効、credentials 不送信、referrer 不送信、ストリームの実サイズ制限を適用します。CORS / CSP / offline の fetch 拒否は `LOAD_FAILED` の `cause` に保持し、失敗した HTTP 応答はステータスも同じ `cause` に残します。ネットワーク層の詳細分類はcauseへ委ね、CORS/CSPはEditor側の実ブラウザーE2Eで検証します。
- injected fetch ポートは `finalURL` と明示的な空 `redirects` を返す必要があります。ポート自体は信頼済みホストが実装する境界であり、再試行もその境界に置いています（後述）。
- 取得・認可は応答しないポートでもタイムアウトします。登録処理はキャンセル後も完了を待ってから rollback します。遅れて完了する登録と rollback の競合を避けるため、登録ポートが `AbortSignal` に応答しない場合、登録中の有限時間終了は保証できません。
- キャッシュの容量・失効・永続化・出所ログはホストのポートが担当します。壊れたキャッシュを暗黙に無視して Remote へ切り替えません。
- `./packager` は source 形式の相互変換、明示承認付きData URL移行、lock/license metadata保持、offline SB3準備を提供します。外部依存資源がある拡張は同梱を推測せず拒否します。署名・発行者鍵のpinningはホスト側で追加できる設計で、初期実装は内容・取得元に束縛したセッション承認です。
- ZIP の実装は `createProjectIO({zip: JSZip})` に注入します。core の codec が ZIP central directory を直接検査し、重複・経路・宣言容量を検証してから、ストリーム展開の実容量と CRC32 を検査します。外部実装の archive port を使う場合も同等の検証が必要です。

既定値は最大64拡張、1拡張16 MiB、合計64 MiB、取得・認可30秒です。1拡張と合計の既定値は project codec の1 entry と全展開量の上限に揃えてあり、作品に格納できる拡張ファイルは Loader でも読めます。ホストは loader options で下げられます。データURLやHTTPの開発モード例外はありません。標準 TurboWarp / 非対応エディターが独自 Manifest と ZIP エントリを破棄する可能性があるため、保持対応のないホストでの再保存は移行手段になりません。

### Remote の一時的な失敗の再試行

再試行は fetch ポートに置いています。`createFetchPort()` は自身を `withFetchRetry()` で包むため、既定ポートを使うホストは変更不要です。独自ポートを注入するホストも `withFetchRetry(hostPort)` で同じように包めます。core 自身の解決ループに再試行を置かない理由は2つあります。再試行は転送層の方針である一方、同じループの他の失敗（digest 不一致、壊れたキャッシュ、認可の拒否）は決して繰り返してはならないこと。そして core は任意のポートが投げたものを分類できないため、ここで再試行すると推測するか、既存の全ポートに新しいエラー契約を強いることになること。**その帰結として、core は注入されたポートの挙動を強制できません。** 独自ポートを実装するホストが自分で決めることになり、`./project-catalog` と `./project-authoring` は渡されたポートと同じだけ再試行します。

| 失敗 | 再試行する | 再試行しない |
| --- | --- | --- |
| HTTP 応答があった | 408 / 425 / 429 と 5xx 全般 | それ以外の 4xx。404 は「無い」という答え |
| 応答が無かった | 接続できなかった場合 | `AbortSignal` による中止。タイムアウトも含む |
| 要求の前 | — | URL・HTTP・資格情報・フラグメントの拒否（`INVALID_SOURCE`） |
| 応答の後 | — | リダイレクトと最終 URL の不一致（`FETCH_FAILED` / `REDIRECT_DENIED`）、サイズ上限（`INVALID_BYTES`）、digest 不一致、壊れたキャッシュ、認可の拒否 |
| キャッシュヒット | — | ハッシュ固定のエントリは CDN に接触しないため対象外 |

分類は `isTransientFetchFailure(error)` として公開し、`createFetchPort()` が出す `FETCH_FAILED` は HTTP ステータスを `cause` に保持するので、包む側から読めます。ただし分類できない事象が1つあります。ブラウザーの `fetch()` は、接続できなかった場合・DNS 失敗・オフライン・CORS / CSP による拒否のいずれでも同一の `TypeError` を返します。仕様が意図して区別させていません。したがって CORS / CSP による拒否も、本来の対象である接続失敗と一緒に再試行されます。これが許容できるのは待ち時間の上限が小さいからであり、上限を小さくした理由でもあります。

**待ち時間は二重に制限されます。** `DEFAULT_FETCH_RETRY` は再試行2回、400 ms → 800 ms のバックオフで、最初の試行から5秒を超えて新しい試行を始めません。この上限はバックオフの待機も含むため、1回目が遅ければそれだけで使い切ります。その上に、取得・認可の既定タイムアウト30秒が操作全体を覆います。これは fetch 1件ごとのタイマーではなく、全拡張の取得・認可・登録を1つのタイマーで覆うものです。よって再試行でタイムアウトが倍になることはありません。30秒は本変更の前から最悪値であり、後も最悪値のままです。上限が決めるのは、その30秒のうち1つの URL が問い直しに使える分だけです。バックオフ待機は signal で中断され、待ち切ることはないので、キャンセルは即時のままです。`createFetchPort(fetchImpl, {retries: 0})` で従来の1回だけの挙動に戻せます。`onRetry` が各待機を通知するので、ホストは進捗を表示できます。

あきらめたら最後です。登録は全エントリの検証・認可が揃ってから始まるため、再試行を使い切ったエントリが1件あれば操作全体が失敗します。エントリは1件ずつ解決するので、その後のエントリは取得されません。操作の `AbortSignal` も中止するので、core がもう待っていないポートの処理は停止します。ホスト transaction は rollback し、元の作品が復元されます。そこから先は待っている人が再試行機構であり、ホストは作品を開き直すか拡張の追加をやり直すよう求めます。誰も見ていないため再試行で失敗を吸収しなければならないビルド時のカタログ生成とは、意図して方針を逆にしています。

## IndexedDB 永続キャッシュ（ブラウザホスト用）

固定された npm `name@exact-version` のCDN配信を想定し、**cache first** とします。ハッシュで固定されたキャッシュがあればオンライン・オフラインを問わずCDNへ問い合わせません。キャッシュミス時のみ既存Remote Fetch Portが取得します。URLに `latest`、semver範囲、バージョン省略等の可変指定を使わないことをホスト側で保証してください。キャッシュの保持にはTTLを設けず、容量超過時のLRU、明示消去、ブラウザのストレージ削除のみで削除します。gzip展開後のSHA-256照合とunsandboxed実行認可は毎回必要です。


`./indexeddb-cache` はリモートで取得・SHA-256 検証済みの JS バイト列を、ブラウザ再起動をまたいで再利用するための **任意の Cache Port アダプター**です。Loader コア側には IndexedDB 依存を持たせません。

```js
import {createIndexedDBContentCache}
    from '@kubohiroya/turbowarp-extension-loader/indexeddb-cache';

const cache = createIndexedDBContentCache({
    databaseName: 'turbowarp-plus-extension-cache',
    maxBytes: 32 * 1024 * 1024, // compressed storage quota
    maxDecompressedBytes: 16 * 1024 * 1024
});
const loader = createExtensionLoader({...hostPorts, cache});
// 終了・ログアウトなどの明示操作で await cache.clear() / await cache.close()
```

- キーは lowercase SHA-256 hex。**保存する値は生JSではなく gzip 圧縮されたバイト列**（format: `gzip-v1`、元サイズを併記）。取得時に展開して Loader に返します。既定32 MiB は**圧縮後の総保存容量**、展開後の最大サイズは16 MiB（1拡張の既定値）、有効期限なし。容量超過時は最終アクセス順LRUで削除します。旧形式の非圧縮エントリは読み込まず削除します。
- 展開は出力サイズを制限し、改ざん・gzip破損や展開超過を拒否します。ブラウザの `CompressionStream` / `DecompressionStream` が必要です。非対応環境で生JSへ黙って切り替えて保存することはありません。
- キャッシュを利用した際にも Loader コアが **取得バイト列の SHA-256 を再検証** し、毎回 trustProvider の権限判定を適用します。キャッシュが信頼判断を代行することはありません。
- キャッシュは IndexedDB を使用できるブラウザ origin に紐付き、ブラウザのストレージ削除・プライベートモード・容量不足等で消える場合があります。ブラウザからの永続化保証はありません。
- IndexedDB が利用できない環境では生成時に明示的に失敗します。ホストは必要に応じて `createMemoryContentCache` にフォールバックできます。ただしキャッシュ障害を無条件に無視してコード実行するのではなく、ホスト側で失敗方針を決めてください。
- 新たな Remote バイト列を取得し保存した場合も、権限承認は毎回別途必要です。コード内から追加取得される依存リソースや外部サービスはこのキャッシュの対象外です。
- Web/Editor はこのポートを初期化して注入するだけとし、`scratch-gui` と `turbowarp-plus-editor` に別のキャッシュロジックを実装しないでください。

## 機能拡張のバイト列がどこから来るか

このファミリーは、機能拡張に限らず何を保持するにも4つの形式で整理しています。どの形式かは
**作品の作者**が決めます。

| 形式 | ブラウザー（IndexedDB） | 作品（SB3） | 標準 TurboWarp |
| --- | --- | --- | --- |
| `remote-non-cacheable` | 残さない | 参照だけ | 開けない |
| `remote-cacheable` | 検証した控えを残してよい | 参照だけ | 開けない |
| `embedded-file` | 使わない | 作品が中身を持つ | 開けない |
| `embedded-data` | 使わない | 作品が中身を持つ | **開ける** |

### 作者が決めること、開く人が断れること

4つはすべて作者の決定で、既に Manifest に入っています。読み込み時に残る問いはもっと狭く、
**`remote-cacheable` の控えを、開く人が自分のブラウザーに残すかどうか**だけです。保存先は
その人の端末なので、作者が許した範囲の中でなら下げられます。範囲の中でだけです。

```js
await loader.load(manifest, {
    // 控えを残さない拡張の id。指定しなければ、作者が許したとおりになります。
    declineCaching: new Set(['someextension'])
});
```

Map ではなく Set なのは、これが**断ることしかできない**からです。`remote-non-cacheable` は
禁止であり、書ける反対がありません。作者には開く人から見えない理由があります——控えがあると、
URL が固定したバイト列を返さなくなったことを控えが尽きるまで隠してしまう。共用の機械に渡す
作品にコードを残したくない。断るのは常に安全で、代償はせいぜい取得1回です。他の形式を名指し
ても効果はありません。残り3つはどちらにしてもキャッシュの扱いが決まっています。

断る指定は両方向に効きます。その拡張についてキャッシュを読まず、書き込みもしません。
何も残したくないと言った人には、何も残りません。

### 参照形へ戻れるかどうか

embedded の `url` は、バイト列の取得元を記録します。

```json
{"type": "embedded-file", "path": "extensions/thing-<sha256>.js", "url": "https://example.test/thing.js"}
```

これは2つの働きをします。運び手が欠けたときに取得へ落ちられること、そして**参照形へ戻る道を
残す唯一の手がかり**であること。無ければ、その作品を `remote-cacheable` へ変換することは
二度とできません。指す先が存在しないからです。

`prepareCatalogExtensionChanges` の `distribution` も同じ4つの名前を取ります。カタログの拡張は
どこかから取得したものなので、embedded のどちらの形も、分かっている取得元を捨てずに中身の横へ
残します。URL は、どの形で保存されていても、固定したバイト列を返すか照合します。url が省略可能
なのは一般の場合のためで、どこからも取得していないバイト列 — コスチューム、音、エディター上で
書いた拡張 — には記録すべき取得元がありません。

## 作品を同定するもの

Manifest は `uri` を持てます。その作品をダウンロードできる住所で、同時にその作品を同定するもの
です。

```json
{"schemaVersion": 1, "uri": "https://example.test/editor/turbowarp-plus-projects/66/66aa/0193f0a1-2b3c-7d4e-8f01-2233445566aa.sb3", "extensions": []}
```

1つの作品に1つの URI。何度編集しても変わりません。だから指紋ではなく住所なのです。指紋は保存
するたびに変わるので、ブラウザーのキャッシュも開く人の選択の記録も、触るたびに同じ作品を別名で
綴じてしまいます。住所は中身が変わっても変わりません。

`./project-authoring` の `createProjectUUID` と `defaultProjectURI` が、作者が住所を選んで
いないときに与える住所を組みます。

```js
const uri = defaultProjectURI(location.origin + location.pathname, createProjectUUID());
```

オリジンはエディター自身のもので、配信していない host を名乗ることはありません。この住所は作品
を人に渡すとき SB3 の中に入って一緒に移動するからです。識別子は UUID version 7 なので、初回保存
の時刻順に並びます。2段のディレクトリは UUID の**末尾**から取ります。version 7 の先頭はミリ秒
時計の上位で、ほとんど動かないので、先頭でシャーディングすると**作られた全作品が1つの
ディレクトリに入ります**。

この住所は意図的に不透明です。読みやすい住所はタイトル由来になり、タイトルを変えると変わるので、
1つの作品が2つ目の名前で綴じられます。読みやすさは「公開する」という意図的な操作のもので、その
ときは作者が自分で住所を名乗ります。人が読む一覧には、これと並べて作品のタイトルを出します。

作者がそこへ公開するまで、この住所は何も返しません。それが想定どおりです。**解決しない URI は
何も語りません。** 保存したが公開していない作品と、公開したが住所が腐った作品は、まったく同じに
見えます。解決するかどうかで何かを決めてはいけません。まして何を消すかを決めてはいけません。
URI は作品自身の申告で、検証していません。作品は他の住所も名乗れます。それで壊れるのは帳簿だけ
です。キャッシュは digest をキーにしていて、ヒットごとに照合するからです。

## ソースとビルド

ソースもテストも TypeScript で、`src/*.ts` と `test/*.test.ts` に置き、他の `@kubohiroya/turbowarp-*` パッケージと同じ構成にしています。`tsconfig.json` が出力なしの型検査、`tsconfig.build.json` がそれを継承して出力、`test/tsconfig.json` がテスト用の継承設定です。`npm run build`（`tsc -p tsconfig.build.json`）が ES2022 の ESM と型宣言を `dist/` に出力し、`exports`・`main`/`module`・webpack 4 用のルートファイル（`packager.js` など）はすべて `dist/` を指します。`dist/` は Git に含めず、Git 依存としてインストールされるときに `prepare` スクリプトがビルドします。npm パッケージにはビルド済みの `dist/` を含めます。webpack 4 では従来どおり `./webpack4` の Babel 設定が `dist/` を変換します。

型の厳しさはコアを書いたときの設定を保っています（`strict` と `noUnusedLocals`・`noUnusedParameters`・`noImplicitOverride`・`noImplicitReturns`・`noFallthroughCasesInSwitch`・`verbatimModuleSyntax`）。兄弟パッケージの一部が有効にしている `noUncheckedIndexedAccess` と `exactOptionalPropertyTypes` は、まだ有効にしていません。

## 検証

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` は `src` と `test` の型検査、テスト、パッケージの dry-run を順に実行します。`npm test` は `dist/` をビルドしてから、パッケージ名経由（`exports` 解決）で公開APIを検証します。テストは Node.js の型除去実行で TypeScript のまま動かし、不正値が拒否されることを確かめるケースでは、公開型をゆるめる代わりにその値をキャストで明示的に渡します。Node.js >=26 の組み込み test runner / Web Crypto を使い、Loader 本体を実行時依存パッケージなしで headless 検証します。ZIP codec の fixture 検証には開発依存の `@turbowarp/jszip` を使います。`test/fixtures/extension.js` はホストに渡すバイト列の fixture で、テスト中に評価しません。実ネットワーク、CORS / CSP、VM の private API、ブラウザー拡張実行の検証とは区別します。

## 導入と切戻し

ホストの起動時固定・既定 OFF のフィーチャーフラグの内側に接続します。フラグ OFF で Loader ポートを呼び出さず、従来の作品読込経路へ戻せる設計とします。未知の Manifest を保持できないホストでは有効化せず、公開前に SB3 保存→再読込の fixture を検証してください。


## SB3 codec

`./project-codec` は `createProjectIO({zip: JSZip, ...limits})` と `inspectZip(bytes, limits)` を提供します。GUI は Manifest を解釈せず、`prepare` → `activate(context)` と `restoreJSON` / `restoreFiles` / `restoreArchive` を接続します。`embeddedReader` は同じインスタンスを Loader ports に渡します。

`prepare` は JSON object / string / UTF-8 bytes / ArrayBuffer / Blob と SB3 ZIP を受け取り、`{manifest, input, context}` を返します。Manifest があれば core で検証し、legacy input の Plus ID に対する `extensionURLs` を除去して自動 URL 実行を防ぎます。ID 自体は GUI の登録 hook 用に残します。保存時は Manifest・元の Plus URL metadata・embedded bytes・未知の ZIP entry・未知の top-level metadata を復元します。`restoreArchive` は GUI の `toJSON` hook が `project.json` を復元済みであることを前提とします。

未対応形式は ZIP64、multidisk、暗号化、STORE/DEFLATE 以外、UTF-8 以外の非 ASCII entry 名、Unicode path extra field です。既定上限は archive と全展開量64 MiB、1 entry16 MiB、project.json 32 MiB、4096 entry、圧縮比1000です。上限はホスト起動設定で変更できます。Manifest のない ZIP もこの安全検査を受け、通過後は元 input をそのまま返します。このため、従来 VM が許していた未対応 ZIP もフラグ有効時には拒否されます。フラグ OFF では codec 自体を呼びません。

## 追加のホスト向けAPI

- `isAuthorizedCode(value)` はコアが発行し現在登録中の認可証跡だけを識別します。コピー・作品データによる偽造を拒否し、transaction終了時に失効します。
- `./session-trust` の `createSessionTrustProvider` はid/digest/source/version/publisher/capabilities/dependenciesへ束縛した承認を保持します。明示された外部ホストのURL/execution方針をUI前に毎回適用し、判定できないEmbedded要求は拒否します。
- `./memory-cache` の `createMemoryContentCache` はコピー・容量（既定32 MiB、既定最大サイズの拡張2件分）・TTL・LRUを提供し、コアはヒット時にも内容を再検証します。
- `withFetchRetry(port, options)` は任意の fetch ポートを上記の有限回の再試行で包み、`isTransientFetchFailure(error)` はその分類器、`DEFAULT_FETCH_RETRY` は既定値（再試行2回、400 ms から倍々で上限2秒、合計5秒）です。
- `./webpack4` はGUI/Packager用の同一コアをwebpack 4でビルドするための構成補助です。

実GUI、実Packager 3.14.0の生成HTML、Desktop 1.17.0の互換性はEditor側のE2Eが担当します。標準Desktopや標準WebへLoaderを無断インストールしません。標準Desktopの保存は独自Manifest/ZIPエントリを破棄することを実測しているため、保持対応エディターで保存してください。

## JSファイル・URLからの作品追加API

`./project-authoring` の `prepareExtensionAddition` は、[Editor Issue #11](https://github.com/kubohiroya/turbowarp-plus-editor/issues/11) の専用UI（カスタム拡張画面）のために作りました。TurboWarp-Plus-Editor は2026-11-01にこの画面をやめ、拡張の入口を TurboWarp Plus の一覧（下の `./project-catalog`）だけにしたため、今は Editor から使っていません。UIはIDとファイルまたはURLを渡すだけで、Manifest編集・URLポリシー・SHA-256計算はこのコアが担当します。

```js
import JSZip from '@turbowarp/jszip';
import {prepareExtensionAddition} from '@kubohiroya/turbowarp-extension-loader/project-authoring';

const candidate = await prepareExtensionAddition(currentSB3, {
    id: 'myextension',
    source: {type: 'embedded'},
    bytes: selectedFile
}, {fetcher, trustProvider, cache, diagnostics}, {zip: JSZip, signal});
// For a Remote extension, use {id, source: {type: 'remote', url: httpsURL}}.
// Apply candidate.projectBytes only after the host checks that the project is still current.
```

- JSファイルはEmbedded、HTTPS URLはRemoteとして追加します。Embeddedの既定パスは `extensions/<id>.js` です。RemoteはURLから実際に取得し、呼出側が渡したバイト列による代用を拒否します。
- IDは拡張作者の `getInfo().id` に合わせて入力します。取り込み時にJSを評価してIDを抽出しません。実行時のregistrarが最終的なID一致を検査します。
- 空・過大・非UTF-8のJS、予約済みID、既存ID、既存ZIPエントリへの上書きを拒否します。HTTPS・最終URL・リダイレクトは既存Loaderと同じ検証を適用します。
- SHA-256は取得したexact bytesから自動計算します。Remoteでは、その取得結果をスナップショットとして候補検証に使います。作品保存後の再取得時にも固定ハッシュを照合するため、サーバー側の差替えを自動で信頼しません。
- 候補作品の全拡張を既存Loaderで検証し、ホストの明示的承認を確認してから `{projectBytes, spec, manifest}` を返します。このAPIはJSを実行せず、元の作品・入力バイト列・実VMを変更しません。承認済みのセッションtrustProviderを実VMへの適用時にも共有すると、同じ内容・取得元への重複確認を避けられます。
- 標準拡張、通常のcustom URL、既存Plus Manifest、埋め込みコード、画像等のZIPエントリ、未知metadata、配布lockを保持します。生成候補は通常ロードと同じZIP制限で再検査します。
- VM適用はホストが所有します。プロジェクト切替・キャンセル・登録失敗の扱いと元作品の復元を実装し、UIを閉じた後や別作品に古い結果を適用しないでください。
- 返却したSB3は通常保存と `prepareOfflinePackage` にそのまま渡せます。Remoteの同梱・外部依存の宣言・受取人の承認境界は従来のPackager APIを再利用します。起動時フラグは引き続き既定OFFです。

## 一覧からの一括設定API

`./project-catalog` の `prepareCatalogExtensionChanges(currentSB3, requests, ports, options)` は、カタログの選択をまとめてSB3候補へ反映します。requestは `{id, url, distribution: 'embedded' | 'remote' | 'cached', execution: 'sandboxed' | 'unsandboxed', dependencies?, version?}` です。JS取得・SHA-256計算・依存順・全件検証・ホスト承認を共通Loaderで行い、全件承認後に `{projectBytes, manifest}` を返します。実VMには触りません。

既存Plus拡張の配布方式・実行モードを変える場合は、検証済みコードとSHA-256・発行者・バージョン・lockを保持します。Remote出力先が現在のコードを返さない場合、更新として勝手に追従せず拒否します。`readProjectAuthoringState(input, options)` は検証済みManifestを返し、UIの状態復元に使えます。これらの作品情報は実行許可ではありません。

Manifestの実行要求は `sandboxed` と `unsandboxed` の両方を扱います。ホストは要求された実行モードを守るregistrarを注入してください。ローカルで検証したEditor/Packager統合ではVM所有の隔離iframeまたは承認済みホスト実行へ分岐し、サンドボックスありをサンドボックスなしへ昇格しません。認可キーは実行モードも含み、外部host policyと一致しない要求は拒否します。`prepareExtensionAddition` でも任意の `execution` を渡せ、省略時だけ従来の `unsandboxed` です。

複数パッケージの候補適用、実行中拡張の所有権移行、登録失敗時の元SB3復元はGUI/VMの責務です。既存legacy拡張の移行は、VMが一時detach/commit/rollbackの所有境界を提供する場合に限ります。元サービスのdispose後に復旧できない場合も、元SB3を回復用に保持してください。

## 公開範囲

Loaderコアと型・ドキュメントは、このGitHubリポジトリと npm パッケージ `@kubohiroya/turbowarp-extension-loader` から提供します。ホストは exact version を固定して依存してください。0.x の間は minor でも契約が変わりえます。Editor・GUI・VM・Packagerの統合実装は別のリポジトリで管理され、このコアの公開によってそれらが更新・配信されることはありません。導入時はホスト側の互換性検証と、起動時固定・既定OFFのフラグが必要です。

タグ `v<version>` を push すると、`release.yml` が検証・pack・GitHub Releaseへの添付・npmへの公開（Trusted Publisher、provenance付き）を行い、`latest` と `next` をその版に向けます。初回の版だけは、npm にパッケージがまだないため Trusted Publisher を設定できません。手作業で公開してから、npmjs.com で `release.yml` を Trusted Publisher に設定します。

npm への公開は、検証済みコードをホストへ配布する手段にすぎません。パッケージの入手自体が拡張コードの実行認可を与えることはなく、認可はホストの `trustProvider` が毎回判断します。

## ライセンス

MPL-2.0。全文は [LICENSE](LICENSE) を参照してください。
