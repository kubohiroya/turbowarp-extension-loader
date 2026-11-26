/**
 * The words of a page that packages a Plus project into one HTML file with this module.
 * The page's controls, state and wording belong to the packager; hosts supply execution ports.
 */

const ja = (locale: string | undefined) => /^ja(?:-|$)/i.test(locale || '');

type Failure = {code?: string; message: string};
const reason = ({code, message}: Failure) => `${code || ''} ${message}`;

export function packagerPageMessages(locale: string | undefined) {
    return ja(locale) ? {
        selected: (title: string) => `${title}: 外部依存がないことを確認してからHTMLを生成してください。`,
        readFailed: (error: Failure) => `作品を読み込めませんでした: ${reason(error)}`,
        chooseProject: '作品を選び、外部依存がないことを確認してください。',
        verifying: '作品と拡張のバイト列を検証しています…',
        noManifest: 'Plus Manifestがありません。通常の作品には標準Packagerを使用してください。',
        retrying: (url: string, attempt: number, attempts: number) =>
            `接続できませんでした。再試行しています（${attempt}/${attempts}）: ${url}`,
        generated: (allTrusted: boolean) => allTrusted ?
            'HTMLを生成しました。拡張はすべてカタログに載っているので、このHTMLを開いても許可の確認は出ません。' :
            'HTMLを生成しました。カタログにない拡張があるので、このHTMLを開くたびに、その拡張を許可するか確認します。',
        refused: (error: Failure) => `生成を拒否しました: ${reason(error)}`,
        handoffFailed: (error: Failure) => `Plus HTML出力を開始できませんでした: ${error.message}`
    } : {
        selected: (title: string) => `${title}: Confirm that it has no external dependencies, then generate the HTML.`,
        readFailed: (error: Failure) => `Could not read the project: ${reason(error)}`,
        chooseProject: 'Choose a project and confirm that it has no external dependencies.',
        verifying: 'Verifying the bytes of the project and its extensions…',
        noManifest: 'This project has no Plus Manifest. Use the standard Packager for other projects.',
        retrying: (url: string, attempt: number, attempts: number) =>
            `Could not connect. Retrying (${attempt}/${attempts}): ${url}`,
        generated: (allTrusted: boolean) => allTrusted ?
            'Generated the HTML. Every extension is in the catalog, so opening it asks for no permission.' :
            'Generated the HTML. Some extensions are not in the catalog, so opening it asks each time whether to allow them.',
        refused: (error: Failure) => `Refused to generate: ${reason(error)}`,
        handoffFailed: (error: Failure) => `Could not start the Plus HTML export: ${error.message}`
    };
}
