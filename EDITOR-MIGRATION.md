# Editor 独自実装の移管

元: kubohiroya/turbowarp-plus-editor `fd11930fa10eaad70b8332eb76b34f9888a59157`。
2026-11-19 に著作権者から、対象の Editor 独自コードを MPL-2.0 でも提供する承認を得た。
本家 GUI のソース・コンポーネント・CSS モジュールは移していない。ホスト固有の値は接続口から受け取る。


## 残存実装の責務移管（未公開）

- 調査・移管元: `kubohiroya/turbowarp-plus-editor@6d2c73199de2b9ff76e27c516f7d2354605a9ed8`
- 元ファイル: `site/packager/page.ts`, `site/packager/handoff.ts`, `site/plus-packager.html`, `site/trusted-extensions.ts`
- 担当: HTML出力とカタログ信頼。画面のDOM/CSS/文言、入力・生成・ダウンロードURL、同一origin/sourceの一回限り転送、カタログのキャッシュとダイジェスト照合。
- 公開口: `./packager-page・./packager-handoff・./catalog-trust`。新しいパッケージは作らない。
- Editorには固定版、配布先URL・カタログ・制限値、実際のVM/Renderer/Packagerコンストラクター、GUI Redux/Desktop preloadの値とコールバックだけを残す。
- 元ファイル追加の著者はHiroya Kubo。移管対象はPlus独自部分で、著作権者によるMPL-2.0提供の明示承認を適用する。本家GUIのコンポーネント・Redux実装は移さない。ソースのSPDXを保持する。
- 既定の有効/無効、SB3/フォルダ/転送の形式、信頼カタログは変更しない。
- 受け入れ条件: この公開口と対象テストのビルド・型検査、変更ガード/取消/破棄とEditorの接続を確認する。
- 切り戻し: Editorの前の依存固定とアダプターを一緒に戻す。単独でアダプターだけを戻さない。上流APIは追加のため、既存consumerは以前の公開口を継続できる。
- この変更はローカル候補。公開版と同じ版番号での検証用packをnpm公開物として扱わない。公開前に版を上げ、WorkbenchのGit/Project Folderの最低対応版を更新する。
