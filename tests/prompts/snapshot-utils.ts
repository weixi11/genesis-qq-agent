import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PromptSnapshotCase } from './cases.ts';

const snapshotDirectory = fileURLToPath(new URL('./__snapshots__/', import.meta.url));

export function normalizeSnapshot(value: string): string {
    return `${value.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

export function getSnapshotPath(fileName: string): string {
    return path.join(snapshotDirectory, fileName);
}

export async function readSnapshot(fileName: string): Promise<string> {
    return readFile(getSnapshotPath(fileName), 'utf8');
}

export async function writeSnapshots(cases: PromptSnapshotCase[]): Promise<void> {
    await mkdir(snapshotDirectory, { recursive: true });

    await Promise.all(cases.map(async (promptCase) => {
        const snapshotPath = getSnapshotPath(promptCase.fileName);
        const content = normalizeSnapshot(promptCase.render());
        await writeFile(snapshotPath, content, 'utf8');
    }));
}
