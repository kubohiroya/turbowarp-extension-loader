# 成果物 lock の追加・SB3 保存・再読込

対象は [Loader #42](https://github.com/kubohiroya/turbowarp-extension-loader/issues/42)、[Toolchain #103](https://github.com/kubohiroya/sb3-toolchain/issues/103)。ブランチは `feat/extensions/build-artifact-locks`、base は Loader main `a99c2c7`。

## 今回の接続

`prepareExtensionAddition` の候補と Scratch VM adapter の `applyDevelopmentBuild` に optional な `artifactLock` を加えた。取得・compiler は Loader に移さず、Toolchain 0.31.3 の `web-distribution` にある共有 validator を使う。API JSON、JS hash、出所の schema と実行方式を候補の実バイト列と照合し、既存の trust provider と作品 transaction へ渡す。

lock は観測記録であり、署名・実行承認ではない。metadata の検証に JS を実行しない。digest の承認、開発 session の承認、登録失敗時の作品復旧は既存経路を使い、session の権限を保存しない。

新形式の生成は、呼出側が明示的に `artifactLock` を渡す場合だけ。今回の差分だけで Desktop／Editor の UI や依存 pin は切り替えない。Desktop GitHub job と導入確認 UI の接続は別差分。新規 package・release・npm 公開は行わない。

## 保存契約と旧 reader

- Manifest extension に `artifactLockFormatVersion: 1` を付ける。
- `tw-plus/extension-locks.json` に `{formatVersion: 1, extensions: [{id, artifactLock}]}` を保存する。Toolchain の既存形式1と同じ sidecar。
- marker と sidecar は一対。欠落、孤立 ID、重複、未知の版・field、JS／API／実行方式の不一致で停止する。
- sidecar は UTF-8 で最大1 MiB、最大256 entry。Manifest の拡張数上限も適用する。token・ローカルパス・session 権限などの追加 field を拒否する。
- marker は旧 reader の許可 field にない。公開済み Loader 0.16.3 が `INVALID_MANIFEST` で拒否することを [実物の tarball で確認](evidence/artifact-lock-old-reader.json) した。未知の記録を黙って捨てる保存を防ぐ。
- lock のない既存作品と追加呼出しは従来どおり。

codec の `prepare` は sidecar と元の embedded bytes を照合する。remote／data carrier は Manifest の pin と照合し、実コードは既存の fetch／embedded reader と digest 検証が照合する。codec の read は通信しない。

`restoreFiles`／`restoreArchive` は検証済み sidecar を復元し、保存時の未検証の差替えを採用しない。元の context にない sidecar の注入は停止する。`restoreJSON` は SB3 の JSON 部分を復元する API なので、file／archive hook と組み合わせる。marker だけの JSON を再読込すれば欠落として停止する。

候補の lock は async 処理前にコピーする。明示的な置換で新候補に lock がなければ、以前の出所を流用しない。catalog の保存方式変更では同じ JS hash・実行方式なら保持し、対象 bytes や実行方式が変われば古い観測記録を外す。他の拡張の検証済み lock は保持する。

## 依存・受け入れ基準と検証

runtime 依存として exact `@kubohiroya/sb3-toolchain@0.31.3` と npm integrity を固定した。production code は browser-safe 入口だけを使い、取得 resolver／compiler を呼び出さない。npm の依存 graph には Node 用依存も含まれるが、browser bundle には Node／compiler の入口を含めない。テストの実コンパイルだけが Node 用入口を明示して使う。

- [x] 関連68件が skip なしで成功。authoring、codec、catalog、VM transaction と実 compiler fixture を対象とする。
- [x] production／test／scratch-vm の型チェックと build が成功。
- [x] headless Chromium で追加 → SB3 保存 → 再読込、未知の版と承認拒否を確認。JS canary は実行されず、`window.process`／`window.require` もない。
- [x] browser bundle を生成でき、Node／process runner／GitHub snapshot／Rolldown の graph を含まない。
- [x] 公開済み旧 reader 0.16.3 が marker を明示拒否。
- [x] Toolchain 0.31.3 の実標準ビルド → shared lock → Loader authoring → SB3 保存・再読込で receipt を保持。fixture JS canary は実行されない。
- [ ] **Toolchain の Plus Manifest 付き SB3 の展開・build は未完了。** 現在の `unpackSb3` は `unsupported-project` として明示拒否する。Manifest を黙って削除して受理させる処理は加えていない。
- [ ] Desktop GitHub job、API 互換更新・導入確認 UI、Loader の公開・Editor／Desktop pin、固定 renderer／配布物での統合。

```sh
npm run build
npm run typecheck
npm run typecheck:scratch-vm
node --test test/artifact-locks.test.ts test/artifact-lock-roundtrip.test.ts \
  test/project-authoring.test.ts test/project-codec.test.ts test/project-catalog.test.ts \
  test/scratch-vm/authoring-controller.test.ts
node --test test/browser/artifact-locks.browser.ts
```

browser 検証は localhost fixture のみ、headless。実製品 renderer・画面付き Electron の検証とは区別する。package の全 test／全 browser test を一律に再実行した結果ではない。

## 切り戻し

新しい `artifactLock` 付き候補の生成を止める。作品・元ソース・JS・API JSON・sidecar を保持し、保存済み新形式には対応 reader を残す。旧 reader への downgrade は marker を拒否するため、既存データを読めると扱わない。必要ならユーザーが採用する明示変換を先に設計し、marker と sidecar を黙って削除しない。#42・#103 は残る DoD とともに open を維持する。
