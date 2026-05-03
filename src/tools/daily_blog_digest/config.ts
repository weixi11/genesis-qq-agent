function trim(value: string | undefined): string {
    return value?.trim() || '';
}

function buildConfig() {
    return {
        enabled: (() => {
            const envEnabled = process.env.MODULE_DAILY_BLOG_DIGEST_ENABLED?.toLowerCase();
            return envEnabled !== 'false' && envEnabled !== '0';
        })(),

        timeoutMs: parseInt(process.env.DAILY_BLOG_DIGEST_TIMEOUT_MS || '90000', 10),
        concurrency: parseInt(process.env.DAILY_BLOG_DIGEST_CONCURRENCY || '2', 10),

        defaults: {
            categoryName: process.env.DAILY_BLOG_DIGEST_DEFAULT_CATEGORY || '落落日报',
            status: parseInt(process.env.DAILY_BLOG_DIGEST_DEFAULT_STATUS || '1', 10),
            requireCover: (process.env.DAILY_BLOG_DIGEST_DEFAULT_REQUIRE_COVER || 'true').toLowerCase() !== 'false',
            signature: process.env.DAILY_BLOG_DIGEST_DEFAULT_SIGNATURE || '作者：落落（Luoluo）',
            style: process.env.DAILY_BLOG_DIGEST_DEFAULT_STYLE || '新闻简报/轻评论',
            maxSections: parseInt(process.env.DAILY_BLOG_DIGEST_MAX_SECTIONS || '5', 10),
            maxSummaryPoints: parseInt(process.env.DAILY_BLOG_DIGEST_MAX_SUMMARY_POINTS || '5', 10),
            timezone: process.env.DAILY_BLOG_DIGEST_TIMEZONE || 'Asia/Shanghai',
        },

        topicPools: {
            morning: ['科技动态', 'AI/互联网新闻'],
            afternoon: ['AI/互联网新闻', '二次元/游戏资讯'],
            evening: ['有趣冷知识/文化类文章', '二次元/游戏资讯'],
            night: ['有趣冷知识/文化类文章', '科技动态'],
        },

        topicTagMapping: {
            '科技动态': ['科技', '趋势', '日报'],
            'AI/互联网新闻': ['AI', '互联网', '观察'],
            '二次元/游戏资讯': ['游戏', '二次元', '文化'],
            '有趣冷知识/文化类文章': ['冷知识', '文化', '科普'],
        } as Record<string, string[]>,

        timeSlots: {
            morningStart: parseInt(process.env.DAILY_BLOG_DIGEST_MORNING_START || '6', 10),
            afternoonStart: parseInt(process.env.DAILY_BLOG_DIGEST_AFTERNOON_START || '12', 10),
            eveningStart: parseInt(process.env.DAILY_BLOG_DIGEST_EVENING_START || '18', 10),
            nightStart: parseInt(process.env.DAILY_BLOG_DIGEST_NIGHT_START || '22', 10),
        },

        search: {
            baseUrl: process.env.DAILY_BLOG_DIGEST_SEARCH_BASE_URL || 'https://api.tavily.com',
            apiKey: process.env.DAILY_BLOG_DIGEST_SEARCH_API_KEY || process.env.TAVILY_API_KEY || '',
            searchPath: process.env.DAILY_BLOG_DIGEST_SEARCH_PATH || '/search',
            maxResults: parseInt(process.env.DAILY_BLOG_DIGEST_SEARCH_MAX_RESULTS || '8', 10),
            freshnessDays: parseInt(process.env.DAILY_BLOG_DIGEST_SEARCH_FRESHNESS_DAYS || '1', 10),
            timeoutMs: parseInt(process.env.DAILY_BLOG_DIGEST_SEARCH_TIMEOUT_MS || '20000', 10),
        },

        cover: {
            generatedImageUrlTemplate:
                process.env.DAILY_BLOG_DIGEST_COVER_TEMPLATE ||
                'https://image.pollinations.ai/prompt/{prompt}?width=1280&height=720&nologo=true',
        },

        blog: {
            baseUrl: trim(process.env.DAILY_BLOG_DIGEST_BLOG_BASE_URL) || trim(process.env.BLOG_API_BASE_URL),
            apiKey: trim(process.env.DAILY_BLOG_DIGEST_BLOG_API_KEY) || trim(process.env.BLOG_API_TOKEN),
            apiUsername: trim(process.env.DAILY_BLOG_DIGEST_BLOG_API_USERNAME) || trim(process.env.BLOG_API_USERNAME),
            apiPassword: trim(process.env.DAILY_BLOG_DIGEST_BLOG_API_PASSWORD) || trim(process.env.BLOG_API_PASSWORD),
            loginClientType: trim(process.env.DAILY_BLOG_DIGEST_BLOG_LOGIN_CLIENT_TYPE) || trim(process.env.BLOG_API_LOGIN_CLIENT_TYPE) || 'Backend',
            categoryListPath: process.env.DAILY_BLOG_DIGEST_BLOG_CATEGORY_LIST_PATH || '/category/list',
            categoryCreatePath: process.env.DAILY_BLOG_DIGEST_BLOG_CATEGORY_CREATE_PATH || '/category/back/add',
            tagListPath: process.env.DAILY_BLOG_DIGEST_BLOG_TAG_LIST_PATH || '/tag/list',
            tagCreatePath: process.env.DAILY_BLOG_DIGEST_BLOG_TAG_CREATE_PATH || '/tag/back/add',
            postCreatePath: process.env.DAILY_BLOG_DIGEST_BLOG_POST_CREATE_PATH || '/article/publish',
            authHeaderName: process.env.DAILY_BLOG_DIGEST_BLOG_AUTH_HEADER || 'Authorization',
            authScheme: process.env.DAILY_BLOG_DIGEST_BLOG_AUTH_SCHEME || 'Bearer',
            timeoutMs: parseInt(process.env.DAILY_BLOG_DIGEST_BLOG_TIMEOUT_MS || '30000', 10),
        },
    };
}

export type DailyBlogDigestConfig = ReturnType<typeof buildConfig>;

export function getConfig(): DailyBlogDigestConfig {
    return buildConfig();
}

export const config = new Proxy({} as DailyBlogDigestConfig, {
    get(_target, prop: keyof DailyBlogDigestConfig) {
        return getConfig()[prop];
    },
});
