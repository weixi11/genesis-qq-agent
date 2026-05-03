process.env.GENESIS_DISABLE_WEB = 'true';
process.env.GENESIS_PROCESS_ROLE = 'agent';

await import('../src/index.ts');
