
export const config = {
    enabled: (() => {
        const envEnabled = process.env.MODULE_GROUP_SET_NAME_ENABLED?.toLowerCase();
        const value = envEnabled;
        return value !== 'false' && value !== '0';
    })(),
    timeoutMs: 30000,
    concurrency: 5,

    // Bot needs to be admin/owner to change group name
};
