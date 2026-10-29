# Embedded / Remote変換と単一HTML出力

[Editor Issue #4](https://github.com/kubohiroya/turbowarp-plus-editor/issues/4) に対応するLoaderコアの配布APIです。

## コアの公開API

`prepareOfflinePackage(input, ports, {zip: JSZip, resourceDependencies, metadata})` はSB3またはRemoteのみのJSON作品を読み、通常実行と同じ `createExtensionLoader` の取得・SHA-256・依存順・ホスト認可を通して全Plus拡張をEmbeddedへ変換します。生成処理では拡張JSを評価しません。検証済み文字列の再エンコード後もSHA-256を照合し、BOMを含む元のUTF-8バイト列を保持します。

`resourceDependencies` はホストが確認した拡張IDごとの外部依存リストです。現在は各IDに空配列を明示する必要があり、不明または外部モデル・画像・API等を列挙した場合は `UNBUNDLED_DEPENDENCY` で拒否します。外部資産の自動探索・書換え・同梱はしません。作品の自己申告だけで外部依存がないと認めません。

`convertProjectSources(input, ports, {zip, targets, metadata})` は拡張ごとにEmbedded/HTTPS Remoteへ変更します。Remote出力時は `artifacts[id]` に正確な公開用バイト列を返します。指定URLへのアップロードは行いません。ホストはそのバイト列を公開してから配布してください。重複出力パス、無関係な既存ZIPエントリの上書きは拒否します。

戻り値は `manifest`、`projectBytes`、`artifacts` と `lock` です。`project.json` のPlus独自フィールド `turboWarpPlusLock` にdigest、バイト数、変換前後の取得元、version、publisher、渡されたlicense/copyright/provenanceを保存します。前回lockも保存し、継続変換で出所を失いません。lockは認可ではなく、作品に埋め込まれた発行者・license等の正当性を保証しません。拡張ソースのlicenseコメントはバイト列としてそのまま残ります。

`migrateLegacyDataURL({id,url,sha256,metadata}, ports)` はJavaScript Data URLを明示的に移行します。既存Data URLを自動的に信頼しません。期待digestとホスト承認が必要で、元コードを検証した後に新規Manifest用specとbytesを返します。Data URLは通常のZIP Embeddedエントリとは別形式です。

## 実TurboWarp Packagerへの接続

薄いGUIアダプター `tw-plus-packager.js` の `configurePlusPackager` / `packagePlusHTML` は公式 `@turbowarp/packager@3.14.0` を使用します。エンジンの複製はありません。

- 配布用SB3は `project.type='blob'` のまま渡し、PackagerがZIPをJSONだけに分解してEmbeddedバイト列を失う経路を避けます。
- Loader、実VM registrar、許可UIの静的ホストbundleをPackagerの `options.custom.js` へ組み込み、作品を開く前にインストールします。インストールに失敗した場合は作品ロードを拒否するガードが残ります。
- 生成時の認可結果を作品やlockから実行時の許可へ昇格させません。受領者はHTMLを開いた際に、同一コアでdigest検証した後、ホストの許可UIで初回実行を承認します。
- PlusのURLを通常URLローダーへ渡さず、未移行のlegacyカスタムURLがあるオフライン生成は拒否します。標準の内蔵拡張は公式scaffoldingを使用します。
- `restrictOfflineHTML()` がPackagerの既存CSPより前に制限CSPを加えます。実行時の外部通信、外部script/画像/音声/フォント/フォーム送信は許可しません。生成物のホストコードは特権コードであり、承認されたunsandboxed JS自体の副作用全体を隔離するものではありません。

生成物は単一HTMLです。packaged runtimeにはVMとLoaderと拡張JSを含みます。ホストの作成時に依存コードを固定・検証してからbundleしてください。GUIのローカルHTML作成画面では固定版PackagerのscaffoldingとLoader runtimeを同一のstatic bundleへ同梱し、実行時のmutable asset cacheに依存しません。

## Editorの導線とビルド

起動フラグ `twPlusExtensionLoader=1` のEditorでPlus作品のPackagerボタンを押すと、同一originの `plus-packager.html` を開きます。SB3は作成元windowとoriginを照合して受け取ります。通常のManifestなし作品は従来の公式Packagerへ委譲します。フラグOFFの導線は従来どおりです。

ローカル作成画面は外部依存がないことをユーザーが確認し、生成前に拡張ごとの内容・取得元・digest・実行権限を表示して承認を得てからHTMLを保存可能にします。不正データ・拒否・検証失敗時に別経路で実行しません。

Editor配布側のビルド手順:

```sh
E2E_GUI_ROOT=/absolute/scratch-gui TW_PLUS_PACKAGER_ROOT=/absolute/packager node --openssl-legacy-provider scripts/site/build-plus-scaffolding.cjs
E2E_GUI_ROOT=/absolute/scratch-gui node --openssl-legacy-provider scripts/site/build-extension-runtime.cjs
E2E_GUI_ROOT=/absolute/scratch-gui TW_PLUS_PACKAGER_ROOT=/absolute/packager node --openssl-legacy-provider scripts/site/build-plus-packager.cjs
```

公式PackagerのソースはSHA `c115bdf525c5f49f0fb689a21b335ccb70fc22d2`、Packager APIは `@turbowarp/packager@3.14.0` に固定します。scaffoldingは同じ公式ソースとservice portを追加したVMから再ビルドし、VMのclosureが所有するdispatchへ登録します。ビルドは公式sourceのSHAとclean状態、npm完全版、VM managerのハッシュ、scaffolding build IDと出力ハッシュを確認します。ソース取得、依存導入、Editor本体のビルドは通常の開発準備として別途必要です。

## 検証と制約

core単体テストはexact bytes、BOM、認可拒否、hash不一致、変換往復、lock/license保持、ZIPの未知データ保持、Data URL移行、外部依存拒否、パス衝突を検証します。GUIアダプターテストは公式Packagerによる実際の単一HTML生成とbootstrap未指定・既存custom JS・再利用拒否を検証します。ブラウザーでの実行結果はEditor側E2Eの記録を参照してください。

単一HTMLと通常Web Editorで権限モデルが異なる点を区別してください。ここでPackagerが成功しても、無改造の通常TurboWarpやDesktopアプリへLoaderが組み込まれたことにはなりません。Desktopは対応ホスト構成での検証が別途必要です。

切戻しはLoader起動フラグOFF・再読込です。実行中ホストはunload完了後に終了します。公開されたHTML自体は配布済みアーティファクトなので、更新時は同梱digestと受領者の許可を更新してください。
