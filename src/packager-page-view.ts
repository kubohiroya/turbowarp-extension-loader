// SPDX-License-Identifier: MPL-2.0
// Original Plus Editor page markup and styles, relicensed by their rights holder.
export function createPackagerPageView(document: Document, editorURL: string) {
    const style = document.createElement('style');
    style.textContent = `
body{margin:0;background:#f1f5f9;color:#172033;font:16px/1.6 system-ui,sans-serif}main{max-width:760px;margin:48px auto;padding:32px;background:white;border-radius:18px;box-shadow:0 12px 40px #0f172a12}h1{font-size:28px;line-height:1.3;margin-top:0}label{display:block;margin:24px 0}input[type=file]{display:block;margin-top:8px}button,a.download{font:inherit;border:0;border-radius:8px;padding:12px 18px;background:#1d4ed8;color:white;cursor:pointer;text-decoration:none}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}.note{padding:16px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px}p[role=status]{min-height:52px}a[hidden]{display:none}@media(max-width:800px){main{margin:12px;padding:24px}}
`;
    const content = document.createElement('div');
    content.innerHTML = `<main>
<h1>TurboWarp-Plus 単一HTML出力</h1>
<p>Embedded・Remote拡張を検証して同梱し、ネット接続を必要としない1つのHTMLファイルにします。</p>
<p class="note">生成前に拡張ごとの実行内容を確認します。配布されたHTMLを開く人にも実行許可を確認します。外部API・モデル・画像などの依存資産は自動で同梱できません。</p>
<label>作品ファイル（SB3）<input type="file" accept=".sb3,application/x.scratch.sb3" data-testid="plus-package-file"></label>
<label>書き出し時の作品データの格納方式
<select data-testid="plus-package-storage">
<option value="standard">SB3 の標準の格納方式</option>
<option value="embedded-data">台本・素材を作品 JSON 内に同梱</option>
</select>
</label>
<label><input type="checkbox" data-testid="plus-package-resources"> すべてのPlus拡張が外部API・モデル・画像・音声などを使わないことを確認しました。</label>
<button type="button" disabled data-testid="plus-package-generate">確認してHTMLを生成</button>
<p role="status" aria-live="polite" data-testid="plus-package-status">Editorから作品を受け取るか、SB3を選んでください。</p>
<a class="download" hidden data-testid="plus-package-download">生成したHTMLを保存</a>
<p><a href="editor.html">Editorへ戻る</a></p>
</main>`;
    document.title = 'TurboWarp-Plus 単一HTML出力';
    content.querySelector<HTMLAnchorElement>('a[href="editor.html"]')!.href = editorURL;
    document.head.append(style);
    document.body.append(content);
    return {dispose() {style.remove(); content.remove();}};
}
