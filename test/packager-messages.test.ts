import assert from 'node:assert/strict';
import {test} from 'node:test';
import {packagerPageMessages} from '../dist/packager.js';

test('the packager page words keep the error code and follow the locale', () => {
    const ja = packagerPageMessages('ja');
    assert.equal(ja.selected('作品'), '作品: 外部依存がないことを確認してからHTMLを生成してください。');
    assert.equal(ja.readFailed({code: 'TOO_LARGE', message: 'big'}), '作品を読み込めませんでした: TOO_LARGE big');
    assert.equal(ja.retrying('https://example.test/a.js', 2, 3), '接続できませんでした。再試行しています（2/3）: https://example.test/a.js');
    assert.match(ja.generated(true), /許可の確認は出ません/);
    assert.match(ja.generated(false), /許可するか確認します/);
    assert.equal(ja.refused({message: 'no'}), '生成を拒否しました:  no');
    const en = packagerPageMessages('en-US');
    assert.equal(en.handoffFailed({message: 'blocked'}), 'Could not start the Plus HTML export: blocked');
    assert.notEqual(packagerPageMessages(undefined).verifying, ja.verifying);
});
