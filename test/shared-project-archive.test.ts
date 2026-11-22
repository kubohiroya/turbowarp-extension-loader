import assert from 'node:assert/strict';
import {test} from 'node:test';
import JSZip from '@turbowarp/jszip';
import {
    beginProjectArchiveRead, editorProjectArchives, readPreparedVMProject, reviewedProjectArchive
} from '@kubohiroya/turbowarp-extension-loader/shared-project-archive';

test('concurrent archive reads keep review and VM data separate and discard rejected reads', async () => {
    const vm = {};
    const input = Uint8Array.of(0x50, 0x4b);
    const first = beginProjectArchiveRead(vm, input)!;
    const second = beginProjectArchiveRead(vm, input)!;
    assert.equal(first.invoke(() => editorProjectArchives.capture(vm)), first.read);
    assert.equal(second.invoke(() => editorProjectArchives.capture(vm)), second.read);
    assert.equal(editorProjectArchives.capture(vm), undefined);

    const firstArchive = {project: {targets: [{name: 'first'}]}, projectBytes: 1, openZip: () => new JSZip()};
    const secondArchive = {...firstArchive, project: {targets: [{name: 'second'}]}};
    let firstInput: unknown, secondInput: unknown;
    await Promise.all([
        assert.rejects(editorProjectArchives.load(input, firstArchive, async bytes => {
            firstInput = bytes;
            await Promise.resolve();
            assert.equal(reviewedProjectArchive(bytes), firstArchive);
            const project = readPreparedVMProject(bytes)!.project as typeof firstArchive.project;
            project.targets[0]!.name = 'mutated';
            assert.equal(firstArchive.project.targets[0]!.name, 'first');
            throw Error('Rejected project');
        }), /Rejected project/),
        editorProjectArchives.load(input, secondArchive, async bytes => {
            secondInput = bytes;
            assert.notEqual(bytes, firstInput);
            assert.equal(reviewedProjectArchive(bytes), secondArchive);
        })
    ]);
    assert.equal(reviewedProjectArchive(firstInput), undefined);
    assert.equal(reviewedProjectArchive(secondInput), undefined);
    assert.equal(reviewedProjectArchive(input), undefined);
});
