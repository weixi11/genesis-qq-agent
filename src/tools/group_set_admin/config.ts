
export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_GROUP_SET_ADMIN_ENABLED?.toLowerCase();
        const value = envEnabled;
        return value !== 'false' && value !== '0';
    })(),
    timeoutMs: 30000,
    concurrency: 5,
};
