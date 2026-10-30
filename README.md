# turbowarp-extension-loader

[Editor Issue #4](https://github.com/kubohiroya/turbowarp-plus-editor/issues/4) の GUI 非依存コアです。独立Gitリポジトリで管理する開発パッケージで、`private: true`、`UNLICENSED` としています。既存の配布ライブラリや npm パッケージを置き換えません。

## 実装範囲

- `project.json` の独自フィールド `turboWarpPlus` に schema v1 の Manifest を配置します。標準 SB3 仕様ではありません。
- Manifest の厳格検証、未知フィールド拒否、重複・標準拡張 ID 拒否、依存順、循環・欠落依存拒否。
- 拡張ごとの Embedded / Remote 解決、SHA-256 必須固定、UTF-8 検証、コードごと・全体のサイズ上限。
- SHA-256 キーのキャッシュポート。読み出すたびに exact bytes を再検証し、キャッシュ利用時もホストの認可を要求します。
- 明示的なホスト認可後、全拡張の検証・認可が揃ってから登録を始めます。登録 ID 不一致・登録失敗はホスト transaction の rollback を要求します。
- キャンセル、取得・認可のタイムアウト、重複ロード拒否、unload、診断イベント。

標準拡張・汎用カスタム URL・従来の Data URL は読み替えません。Manifest がない作品ではホストポートを呼び出しません。作品内の `execution: "unsandboxed"` は要求値であり権限ではありません。`trusted` などの未知フィールドは拒否します。

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

登録ポートは `begin({signal})` → `register(authorizedCode,{signal})` → `commit({signal})` を実装し、どの登録が失敗しても `rollback()` で登録状態を復旧できる必要があります。`register()` は実際の `getInfo().id` と対応する登録結果 `{id}` を返します。ホストは既存 VM 内の ID 競合も拒否してください。`unload(ids)` は依存の逆順で呼ばれます。公開 `.d.ts` に契約を記載しています。

実VMアダプターは `scratch-gui/src/lib/tw-plus-extension-registrar.js` が所有します。VMへ追加する `getExtensionServicePort()` と組み合わせ、同一VMの登録テーブル・dispatchサービスの所有権を追跡してrollback/unloadします。Editorと別バンドルのPackagerもVM内の同じサービスを利用します。標準VMを使用する同一バンドルではdispatch同一性を確認し、未対応の別バンドルでは拒否します。Loaderコア自身はVM private APIへ依存しません。

## セキュリティ境界と制約

- core は JS を評価しません。評価権限と VM 内部 API はホストに限定します。
- ロールバックはホストの拡張登録状態の保証です。一度評価した特権 JS の DOM / ネットワーク等の副作用を巻き戻すことはできません。安全なコードの承認は別途必要です。
- 初期版は Remote の HTTP、資格情報付き URL、フラグメント、リダイレクトをすべて拒否します。HTTPS URL の正常取得だけで認可しません。
- `createFetchPort()` はリダイレクト無効、credentials 不送信、referrer 不送信、ストリームの実サイズ制限を適用します。CORS / CSP / offline の fetch 拒否は `LOAD_FAILED` の `cause` に保持します。ネットワーク層の詳細分類はcauseへ委ね、CORS/CSPはEditor側の実ブラウザーE2Eで検証します。
- injected fetch ポートは `finalURL` と明示的な空 `redirects` を返す必要があります。ポート自体は信頼済みホストが実装する境界です。
- 取得・認可は応答しないポートでもタイムアウトします。登録処理はキャンセル後も完了を待ってから rollback します。遅れて完了する登録と rollback の競合を避けるため、登録ポートが `AbortSignal` に応答しない場合、登録中の有限時間終了は保証できません。
- キャッシュの容量・失効・永続化・出所ログはホストのポートが担当します。壊れたキャッシュを暗黙に無視して Remote へ切り替えません。
- `./packager` はEmbedded / Remote変換、明示承認付きData URL移行、lock/license metadata保持、offline SB3準備を提供します。外部依存資源がある拡張は同梱を推測せず拒否します。署名・発行者鍵のpinningはホスト側で追加できる設計で、初期実装は内容・取得元に束縛したセッション承認です。
- ZIP の実装は `createProjectIO({zip: JSZip})` に注入します。core の codec が ZIP central directory を直接検査し、重複・経路・宣言容量を検証してから、ストリーム展開の実容量と CRC32 を検査します。外部実装の archive port を使う場合も同等の検証が必要です。

既定値は最大64拡張、1拡張1 MiB、合計8 MiB、取得・認可30秒です。データURLやHTTPの開発モード例外はありません。標準 TurboWarp / 非対応エディターが独自 Manifest と ZIP エントリを破棄する可能性があるため、保持対応のないホストでの再保存は移行手段になりません。

## 検証

```sh
npm ci --ignore-scripts
npm test
```

Node.js >=24 の組み込み test runner / Web Crypto を使い、Loader 本体を依存パッケージなしで headless 検証します。ZIP codec の fixture 検証には開発依存の `@turbowarp/jszip` を使います。`test/fixtures/extension.js` はホストに渡すバイト列の fixture で、テスト中に評価しません。実ネットワーク、CORS / CSP、VM の private API、ブラウザー拡張実行の検証とは区別します。

## 導入と切戻し

ホストの起動時固定・既定 OFF のフィーチャーフラグの内側に接続します。フラグ OFF で Loader ポートを呼び出さず、従来の作品読込経路へ戻せる設計とします。未知の Manifest を保持できないホストでは有効化せず、公開前に SB3 保存→再読込の fixture を検証してください。


## SB3 codec

`./project-codec` は `createProjectIO({zip: JSZip, ...limits})` と `inspectZip(bytes, limits)` を提供します。GUI は Manifest を解釈せず、`prepare` → `activate(context)` と `restoreJSON` / `restoreFiles` / `restoreArchive` を接続します。`embeddedReader` は同じインスタンスを Loader ports に渡します。

`prepare` は JSON object / string / UTF-8 bytes / ArrayBuffer / Blob と SB3 ZIP を受け取り、`{manifest, input, context}` を返します。Manifest があれば core で検証し、legacy input の Plus ID に対する `extensionURLs` を除去して自動 URL 実行を防ぎます。ID 自体は GUI の登録 hook 用に残します。保存時は Manifest・元の Plus URL metadata・embedded bytes・未知の ZIP entry・未知の top-level metadata を復元します。`restoreArchive` は GUI の `toJSON` hook が `project.json` を復元済みであることを前提とします。

未対応形式は ZIP64、multidisk、暗号化、STORE/DEFLATE 以外、UTF-8 以外の非 ASCII entry 名、Unicode path extra field です。既定上限は archive と全展開量64 MiB、1 entry16 MiB、project.json 4 MiB、4096 entry、圧縮比1000です。上限はホスト起動設定で変更できます。Manifest のない ZIP もこの安全検査を受け、通過後は元 input をそのまま返します。このため、従来 VM が許していた未対応 ZIP もフラグ有効時には拒否されます。フラグ OFF では codec 自体を呼びません。

## 追加のホスト向けAPI

- `isAuthorizedCode(value)` はコアが発行し現在登録中の認可証跡だけを識別します。コピー・作品データによる偽造を拒否し、transaction終了時に失効します。
- `./session-trust` の `createSessionTrustProvider` はid/digest/source/version/publisher/capabilities/dependenciesへ束縛した承認を保持します。明示された外部ホストのURL/execution方針をUI前に毎回適用し、判定できないEmbedded要求は拒否します。
- `./memory-cache` の `createMemoryContentCache` はコピー・容量・TTL・LRUを提供し、コアはヒット時にも内容を再検証します。
- `./webpack4` はGUI/Packager用の同一コアをwebpack 4でビルドするための構成補助です。

実GUI、実Packager 3.14.0の生成HTML、Desktop 1.17.0の互換性はEditor側のE2Eが担当します。標準Desktopや標準WebへLoaderを無断インストールしません。標準Desktopの保存は独自Manifest/ZIPエントリを破棄することを実測しているため、保持対応エディターで保存してください。

## JSファイル・URLからの作品追加API

[Editor Issue #11](https://github.com/kubohiroya/turbowarp-plus-editor/issues/11) の専用UIは `./project-authoring` の `prepareExtensionAddition` を呼び出します。UIはIDとファイルまたはURLを渡すだけで、Manifest編集・URLポリシー・SHA-256計算はこのコアが担当します。

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

`./project-catalog` の `prepareCatalogExtensionChanges(currentSB3, requests, ports, options)` は、カタログの選択をまとめてSB3候補へ反映します。requestは `{id, url, distribution: 'embedded' | 'remote', execution: 'sandboxed' | 'unsandboxed', dependencies?, version?}` です。JS取得・SHA-256計算・依存順・全件検証・ホスト承認を共通Loaderで行い、全件承認後に `{projectBytes, manifest}` を返します。実VMには触りません。

既存Plus拡張の配布方式・実行モードを変える場合は、検証済みコードとSHA-256・発行者・バージョン・lockを保持します。Remote出力先が現在のコードを返さない場合、更新として勝手に追従せず拒否します。`readProjectAuthoringState(input, options)` は検証済みManifestを返し、UIの状態復元に使えます。これらの作品情報は実行許可ではありません。

Manifestの実行要求は `sandboxed` と `unsandboxed` の両方を扱います。ホストは要求された実行モードを守るregistrarを注入してください。ローカルで検証したEditor/Packager統合ではVM所有の隔離iframeまたは承認済みホスト実行へ分岐し、サンドボックスありをサンドボックスなしへ昇格しません。認可キーは実行モードも含み、外部host policyと一致しない要求は拒否します。`prepareExtensionAddition` でも任意の `execution` を渡せ、省略時だけ従来の `unsandboxed` です。

複数パッケージの候補適用、実行中拡張の所有権移行、登録失敗時の元SB3復元はGUI/VMの責務です。既存legacy拡張の移行は、VMが一時detach/commit/rollbackの所有境界を提供する場合に限ります。元サービスのdispose後に復旧できない場合も、元SB3を回復用に保持してください。

## 公開範囲

Loaderコアと型・ドキュメントはこのGitHubリポジトリから提供します。npmパッケージは `private: true` のままで、ホストは検証したコミットを固定して利用してください。Editor・GUI・VM・Packagerの統合実装は別のリポジトリで管理され、このコアの公開によってそれらが更新・配信されることはありません。導入時はホスト側の互換性検証と、起動時固定・既定OFFのフラグが必要です。
