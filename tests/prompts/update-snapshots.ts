import { promptSnapshotCases } from './cases.ts';
import { writeSnapshots } from './snapshot-utils.ts';

await writeSnapshots(promptSnapshotCases);

console.log(`Updated ${promptSnapshotCases.length} prompt snapshots.`);
