import { execute } from './src/tools/anime_trace/index.js';
import type { ToolContext } from './src/tools/types.js';

async function test() {
    const ctx: ToolContext = {
        imageUrls: ['c:\\Users\\pw\\Desktop\\03030\\genesis\\data\\Test file\\draw_1768126112708_ogj6oo.webp'],
        platform: 'mock',
        groupId: 0,
        history: []
    };

    const result = await execute({ model: 'anime' }, ctx);
    console.log(JSON.stringify(result, null, 2));
}

test();
