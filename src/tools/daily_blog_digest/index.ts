import { config } from './config.js';
import { schema } from './schema.js';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { log } from '../../logger.js';
import { requestBlogApi } from '../../utils/blogApi.js';
import { safeParseJson } from '../../utils/json.js';

export const name = 'daily_blog_digest';
export const description = '自动选题、联网整理并发布博客日报，确保封面与署名完整。';
export const keywords = ['日报', '博客', '新闻整理', '自动发布', '封面图'];

type ID = number | string;

interface SearchItem {
    title: string;
    url: string;
    snippet: string;
    publishedAt?: string;
    image?: string;
}

interface CategoryEntity {
    id: ID;
    name: string;
}

interface TagEntity {
    id: ID;
    name: string;
}

interface PublishResponse {
    id?: ID;
    postId?: ID;
    data?: { id?: ID; postId?: ID };
}

interface SearchFetchResult {
    items: SearchItem[];
    error?: string;
}

interface GitHubRepoCandidate {
    owner: string;
    repo: string;
    url: string;
    title: string;
    snippet: string;
}

interface ScoredGitHubRepoCandidate extends GitHubRepoCandidate {
    score: number;
}

interface GitHubRepoContext {
    projectName: string;
    repoUrl: string;
    description: string;
    highlights: string[];
    installSteps: string[];
    usageSteps: string[];
    sourceItems: SearchItem[];
    detailLevel: 'search_snippet' | 'repo_page' | 'raw_readme';
    homepage?: string;
    language?: string;
    license?: string;
    stars?: number;
    updatedAt?: string;
    metadataLines: string[];
}

interface GitHubRepoApiInfo {
    fullName?: string;
    description?: string;
    homepage?: string;
    language?: string;
    license?: string;
    stars?: number;
    updatedAt?: string;
    defaultBranch?: string;
}

type ArticleMode = 'digest' | 'project_recommendation';

interface TopicResolution {
    topic: string;
    writingRequirements?: string;
    hintUsedAsInstruction: boolean;
}

const SAFE_COVER_URL_MAX_LENGTH = 900;
const TOPIC_MAX_LENGTH = 36;
const SEARCH_TOPIC_MAX_LENGTH = 96;
const COVER_PROMPT_MAX_LENGTH = 48;
const REPO_FETCH_TIMEOUT_MS = 8000;
const MAX_PROJECT_CANDIDATES = 2;

const GITHUB_RESERVED_PATHS = new Set([
    'features', 'topics', 'collections', 'trending', 'events', 'marketplace',
    'orgs', 'organizations', 'users', 'settings', 'explore', 'sponsors',
    'account', 'apps', 'codespaces', 'issues', 'pulls', 'search', 'site',
]);

const GITHUB_NON_REPO_SUBPATHS = new Set([
    'issues', 'pull', 'pulls', 'discussions', 'wiki', 'blob', 'tree', 'commit', 'commits',
    'releases', 'tags', 'actions', 'security', 'network', 'compare', 'projects', 'packages',
    'stargazers', 'watchers', 'forks', 'contributors', 'pulse', 'graphs',
]);

const STRONG_COLLECTION_KEYWORDS = [
    'awesome', 'list', 'lists', 'collection', 'collections', 'curated', 'recommend',
    'recommendation', 'resources', 'resource', 'weekly', 'daily', 'roundup', 'digest',
    'trending', 'tracker', '合集', '清单', '整理', '推荐', '收集', '导航', '周刊', '日报', '汇总', '精选', '资源', '追踪',
];

const SOFT_COLLECTION_KEYWORDS = [
    'starter', 'boilerplate', 'template', 'templates', 'tutorial', 'roadmap',
    'example', 'examples', 'sample', 'samples', 'showcase', 'catalog',
];

const NOTE_RESOURCE_KEYWORDS = [
    'note', 'notes', 'blog', 'blogs', 'wiki', 'article', 'articles', 'learn',
    'learning', 'docs', 'documentation', 'course', 'book', 'guide',
    '笔记', '文章', '文档', '学习', '教程', '资源', '导航', '知识库',
];

const PROJECT_SIGNAL_KEYWORDS = [
    'app', 'tool', 'tools', 'platform', 'server', 'dashboard', 'agent', 'bot',
    'assistant', 'workflow', 'automation', 'self-hosted', 'cli', 'studio', 'cms',
    '工具', '应用', '平台', '系统', '服务', '工作流', '自动化', '自托管', '部署', '面板',
];

function toRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getString(params: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = params[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function getBoolean(params: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = params[key];
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1') return true;
            if (normalized === 'false' || normalized === '0') return false;
        }
    }
    return undefined;
}

function getInteger(params: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = params[key];
        if (typeof value === 'number' && Number.isInteger(value)) return value;
        if (typeof value === 'string') {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed)) return parsed;
        }
    }
    return undefined;
}

function getStringArray(params: Record<string, unknown>, keys: string[]): string[] | undefined {
    for (const key of keys) {
        const value = params[key];
        if (Array.isArray(value)) {
            const arr = value.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean);
            if (arr.length > 0) return arr;
        }
        if (typeof value === 'string' && value.trim()) {
            const arr = value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (arr.length > 0) return arr;
        }
    }
    return undefined;
}

function getTimeBucket(hour: number): keyof typeof config.topicPools {
    const { morningStart, afternoonStart, eveningStart, nightStart } = config.timeSlots;
    if (hour >= nightStart || hour < morningStart) return 'night';
    if (hour >= eveningStart) return 'evening';
    if (hour >= afternoonStart) return 'afternoon';
    return 'morning';
}

function pickTopicByTime(now: Date): string {
    const hour = now.getHours();
    const bucket = getTimeBucket(hour);
    const pool = config.topicPools[bucket];
    const idx = now.getDate() % pool.length;
    return pool[idx] || '科技动态';
}

function dedupe(arr: string[]): string[] {
    const set = new Set(arr.map((x) => x.trim()).filter(Boolean));
    return Array.from(set);
}

function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function clampText(text: string, maxLength: number): string {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

function formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function sanitizeTopicCandidate(text: string): string {
    return clampText(
        text
            .replace(/^[#*【\[\s]+/, '')
            .replace(/[】\]\s]+$/u, '')
            .replace(/^(请|麻烦|帮我|现在|立即|尽快|给我|生成|发布)+/u, '')
            .replace(/[：:，,。！？!?\n\r]+.*$/u, ''),
        TOPIC_MAX_LENGTH,
    );
}

function looksLikeWritingInstruction(text: string): boolean {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
        return false;
    }
    return normalized.length > 60
        || /[；;\n]/u.test(normalized)
        || /请|生成|发布|文章|正文|标题|简介|教程|适用场景|功能亮点|注意事项/u.test(normalized);
}

function resolveTopic(params: Record<string, unknown>, fallbackTopic: string): TopicResolution {
    const topicHint = getString(params, ['topic_hint', 'topicHint', 'topic']);
    const categoryName = getString(params, ['category_name', 'categoryName', 'category']);
    const requestedTags = getStringArray(params, ['tag_names', 'tagNames', 'tags']) || [];
    const explicitRequirements = getString(params, ['writing_requirements', 'writingRequirements', 'requirements', 'instruction', 'brief']);

    if (!topicHint) {
        return {
            topic: categoryName || requestedTags[0] || fallbackTopic,
            writingRequirements: explicitRequirements,
            hintUsedAsInstruction: false,
        };
    }

    if (!looksLikeWritingInstruction(topicHint)) {
        return {
            topic: sanitizeTopicCandidate(topicHint) || categoryName || requestedTags[0] || fallbackTopic,
            writingRequirements: explicitRequirements,
            hintUsedAsInstruction: false,
        };
    }

    const derivedTopic = sanitizeTopicCandidate(categoryName || requestedTags[0] || fallbackTopic);
    return {
        topic: derivedTopic || fallbackTopic,
        writingRequirements: explicitRequirements || normalizeWhitespace(topicHint),
        hintUsedAsInstruction: true,
    };
}

function detectArticleMode(topic: string, categoryName: string, style: string, writingRequirements?: string): ArticleMode {
    const text = `${topic} ${categoryName} ${style} ${writingRequirements || ''}`.toLowerCase();
    return /github|开源|项目|部署|教程|生产力|独立开发/u.test(text) ? 'project_recommendation' : 'digest';
}

function extractProjectFocusTerms(topic: string, writingRequirements?: string): string[] {
    const text = normalizeWhitespace(`${topic} ${writingRequirements || ''}`);
    const dictionary = [
        'AI 工具',
        '开发效率',
        '效率工具',
        '实用脚本',
        '生产力应用',
        '独立开发',
        '自动化',
        '工作流',
        '知识库',
        '浏览器',
        '文档',
        '笔记',
        '面板',
        '自托管',
        'CLI',
        'Agent',
        'Bot',
    ];
    const matched = dictionary.filter((item) => new RegExp(item.replace(/\s+/g, '\\s*'), 'iu').test(text));
    if (matched.length > 0) {
        return matched.slice(0, 3);
    }

    if (/github|开源|项目|推荐/u.test(text)) {
        return ['AI 工具', '开发效率', '自托管'];
    }

    return [clampText(topic, 20)];
}

function buildSearchQuery(topic: string, mode: ArticleMode, writingRequirements?: string): string {
    if (mode === 'project_recommendation') {
        const focusTerms = extractProjectFocusTerms(topic, writingRequirements).join(' ');
        return clampText(
            `site:github.com ${focusTerms} self-hosted docker CLI app README 安装 部署 -awesome -list -collection -合集 -整理 -推荐`,
            SEARCH_TOPIC_MAX_LENGTH,
        );
    }

    if (writingRequirements && /实用|教程|部署/u.test(writingRequirements)) {
        return clampText(`${topic} 最新 动态 实用 教程`, SEARCH_TOPIC_MAX_LENGTH);
    }

    return clampText(`${topic} 今天 最新 新闻 资讯`, SEARCH_TOPIC_MAX_LENGTH);
}

function buildProjectFallbackQueries(topic: string, writingRequirements?: string): string[] {
    const focusTerms = extractProjectFocusTerms(topic, writingRequirements);
    const primary = focusTerms[0] || topic;
    const secondary = focusTerms[1] || primary;
    const tertiary = /脚本|CLI|Agent|Bot/iu.test(focusTerms.join(' ')) ? (focusTerms[2] || 'CLI') : 'workflow';

    return dedupe([
        clampText(`site:github.com self-hosted ${primary} app docker GitHub`, SEARCH_TOPIC_MAX_LENGTH),
        clampText(`site:github.com ${secondary} workflow tool docker GitHub README`, SEARCH_TOPIC_MAX_LENGTH),
        clampText(`site:github.com ${tertiary} AI tool GitHub install`, SEARCH_TOPIC_MAX_LENGTH),
    ]).slice(0, 2);
}

function summarizeRequirements(writingRequirements?: string): string[] {
    if (!writingRequirements) {
        return [];
    }

    const normalized = normalizeWhitespace(
        writingRequirements
            .replace(/^请现在立即/u, '')
            .replace(/^请/u, '')
            .replace(/^生成并发布/u, '')
            .replace(/^生成一篇/u, ''),
    );
    const source = normalized.includes('包含：') ? normalized.split('包含：')[1] || normalized : normalized;
    const parts = source
        .split(/(?=\d+[.)、])/u)
        .flatMap((segment) => segment.split(/[；;\n]/u))
        .map((segment) => normalizeWhitespace(segment.replace(/^\d+[.)、]\s*/u, '').replace(/^[-•]\s*/u, '')))
        .filter(Boolean);
    return dedupe(parts).slice(0, 7).map((item) => clampText(item, 32));
}

function ensureCoverUrlLength(url?: string): string | undefined {
    if (!url) {
        return undefined;
    }
    const normalized = url.trim();
    if (!normalized) {
        return undefined;
    }
    return normalized.length <= SAFE_COVER_URL_MAX_LENGTH ? normalized : undefined;
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function stripHtml(html: string): string {
    return decodeHtmlEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<li[^>]*>/gi, '\n- ')
            .replace(/<(br|\/p|\/div|\/section|\/article|\/h[1-6]|\/tr)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\r/g, ''),
    )
        .split('\n')
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean)
        .join('\n');
}

function stripMarkdown(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^>\s?/gm, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/\r/g, '');
}

function extractMetaContent(html: string, attrName: 'property' | 'name', attrValue: string): string | undefined {
    const pattern = new RegExp(`<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["']`, 'i');
    const match = html.match(pattern);
    return match?.[1] ? decodeHtmlEntities(match[1]).trim() : undefined;
}

function toSentenceList(text: string, maxItems: number): string[] {
    return dedupe(
        text
            .split(/[。！？!?\n]/u)
            .map((line) => normalizeWhitespace(line))
            .filter((line) => line.length >= 8 && line.length <= 120),
    ).slice(0, maxItems);
}

function isLikelyHeading(line: string): boolean {
    const normalized = normalizeWhitespace(line);
    if (!normalized || normalized.length > 60) return false;
    if (normalized.startsWith('- ') || /^https?:\/\//i.test(normalized)) return false;
    if (/^(npm|pnpm|yarn|bun|docker|docker compose|git clone|pip install|uv pip|go install|cargo install|python -m|node |cp |cd )/iu.test(normalized)) {
        return false;
    }
    return !/[。；;：:]/u.test(normalized);
}

function extractSectionLines(text: string, keywords: string[], maxLines: number): string[] {
    const lines = text
        .split('\n')
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);
    const loweredKeywords = keywords.map((item) => item.toLowerCase());
    const start = lines.findIndex((line) => {
        const lowered = line.toLowerCase();
        return loweredKeywords.some((keyword) => lowered.includes(keyword));
    });
    if (start < 0) {
        return [];
    }

    const collected: string[] = [];
    for (let i = start + 1; i < lines.length && collected.length < maxLines; i += 1) {
        const line = lines[i];
        if (!line) continue;
        if (collected.length > 0 && isLikelyHeading(line)) {
            break;
        }
        collected.push(line);
    }
    return dedupe(collected);
}

function extractCommandLines(text: string, maxItems: number): string[] {
    return dedupe(
        text
            .split('\n')
            .map((line) => normalizeWhitespace(line))
            .filter((line) => /npm|pnpm|yarn|bun|docker|docker compose|git clone|pip install|uv pip|go install|cargo install|python -m|node |cp |cd /iu.test(line)),
    ).slice(0, maxItems);
}

function extractPortMappings(text: string, maxItems: number): string[] {
    const matches: string[] = [];
    for (const line of text.split('\n').map((item) => normalizeWhitespace(item))) {
        const found = line.match(/\b\d{2,5}:\d{2,5}\b/g);
        if (!found) continue;
        matches.push(...found);
    }
    return dedupe(matches).slice(0, maxItems);
}

function toDisplayProjectName(title: string, repo: string): string {
    const normalized = normalizeWhitespace(title);
    if (!normalized) return repo;
    const primary = normalized.split(/[:：\-|]/u)[0]?.trim();
    if (!primary || primary.length > 40) return repo;
    if (/github|gitlab|gitee/u.test(primary.toLowerCase())) return repo;
    return primary;
}

function containsKeyword(text: string, keywords: string[]): boolean {
    const lowered = text.toLowerCase();
    return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function toHumanProjectName(name: string): string {
    const normalized = normalizeWhitespace(name).replace(/[_-]+/g, ' ').trim();
    if (!normalized) {
        return name;
    }
    if (/[A-Z]/.test(normalized)) {
        return normalized;
    }
    return normalized
        .split(' ')
        .map((part) => {
            if (part.length <= 2) return part.toUpperCase();
            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
}

function cleanProjectLine(line: string): string {
    return normalizeWhitespace(
        line
            .replace(/^[-*•]+\s*/u, '')
            .replace(/^[\d.]+\s*/u, '')
            .replace(/^[^\p{L}\p{N}]+/u, '')
            .replace(/["'`]+$/u, '')
            .replace(/\s+/g, ' '),
    );
}

function isProjectMetadataLine(line: string): boolean {
    return /^(仓库地址：|项目主页：|主要语言：|开源协议：|GitHub Stars：|最近更新：)/u.test(normalizeWhitespace(line));
}

function uniqueProjectLines(lines: string[], maxItems: number): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of lines) {
        const line = cleanProjectLine(raw);
        if (!line || line.length < 6) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(line);
        if (result.length >= maxItems) break;
    }
    return result;
}

function toParagraphs(text: string, maxItems: number): string[] {
    return uniqueProjectLines(
        text
            .split(/[。！？!?\n]/u)
            .map((line) => normalizeWhitespace(line))
            .filter((line) => line.length >= 10 && line.length <= 140),
        maxItems,
    );
}

function buildProjectAudience(projectName: string, text: string): string[] {
    const audiences: string[] = [];
    if (/bot|agent|automation|workflow|自动化|工作流|机器人/u.test(text)) {
        audiences.push(`想把 ${projectName} 接进自己消息流、工作流或 AI 自动化体系的开发者。`);
    }
    if (/dashboard|console|platform|管理|平台|后台/u.test(text)) {
        audiences.push(`需要一个带控制台、权限或配置能力的自部署平台的团队。`);
    }
    if (/docker|compose|self-hosted|deploy|部署|自托管/u.test(text)) {
        audiences.push(`希望优先用 Docker / 自托管方式快速落地项目的人。`);
    }
    audiences.push(`不满足于“看看仓库”，而是想真正把项目跑起来并验证价值的技术人员。`);
    return uniqueProjectLines(audiences, 4);
}

function buildProjectCautions(projectName: string, text: string): string[] {
    const cautions = [
        '部署前先检查仓库最近提交、Issue/PR 活跃度、许可证与外部服务依赖。',
        '上生产前补齐日志、监控、备份、鉴权、限流和持久化策略。',
    ];
    if (/disclaimer|learning|research|仅供学习|免责声明/u.test(text)) {
        cautions.push(`README 含免责声明或学习研究限定语，正式商用前要先确认合规边界。`);
    }
    if (/postgres|mysql|redis|minio|s3|storage|database|数据库|对象存储/u.test(text)) {
        cautions.push(`这个项目涉及数据库或对象存储等外部依赖，部署时要同时规划数据备份与恢复。`);
    }
    cautions.push(`简评：${projectName} 是否值得长期使用，关键看 README 完整度、部署顺滑度和后续维护活跃度。`);
    return uniqueProjectLines(cautions, 4);
}

function formatRepoUpdateTime(value?: string): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    return formatDate(date);
}

function buildRepoMetadataLines(project: GitHubRepoApiInfo, repoUrl: string): string[] {
    const lines: string[] = [`仓库地址：${repoUrl}`];
    if (project.homepage) lines.push(`项目主页：${project.homepage}`);
    if (project.language) lines.push(`主要语言：${project.language}`);
    if (project.license && project.license !== 'NOASSERTION') lines.push(`开源协议：${project.license}`);
    if (typeof project.stars === 'number') lines.push(`GitHub Stars：${project.stars}`);
    const updated = formatRepoUpdateTime(project.updatedAt);
    if (updated) lines.push(`最近更新：${updated}`);
    return uniqueProjectLines(lines, 5);
}

function buildInstallAndUsageHints(
    owner: string,
    repo: string,
    branch: string,
    readmeText: string,
    dockerComposeText: string,
    installScriptPath?: string,
): { installLines: string[]; usageLines: string[]; extraHighlights: string[] } {
    const installLines = uniqueProjectLines([
        ...(installScriptPath ? [`curl -fsSL https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${installScriptPath} | sh`] : []),
        ...(dockerComposeText ? ['docker compose up -d'] : []),
        ...extractSectionLines(readmeText, ['快速开始', 'quick start', 'getting started', 'installation', 'install', '部署', '安装'], 8),
        ...extractCommandLines(readmeText, 6),
        ...extractCommandLines(dockerComposeText, 4),
    ], 6);

    const portLines = extractPortMappings(dockerComposeText, 3);

    const usageLines = uniqueProjectLines([
        ...extractSectionLines(readmeText, ['usage', 'how to use', '使用', '运行', 'demo', '示例'], 8),
        ...toParagraphs(readmeText, 6).filter((line) => /管理员|注册|登录|控制台|dashboard|web 控制台|后台|扫码|绑定/u.test(line)),
        ...portLines.map((line) => `启动后优先检查服务端口：${line}`),
    ], 5);

    const extraHighlights = uniqueProjectLines([
        ...toParagraphs(readmeText, 8).filter((line) => /app|market|marketplace|sdk|webhook|websocket|oauth|passkey|多 bot|多通道|应用市场|控制台|追踪/u.test(line)),
        ...toParagraphs(dockerComposeText, 6).filter((line) => /postgres|minio|redis|mysql|storage|database|bucket|port/u.test(line)),
    ], 4);

    return { installLines, usageLines, extraHighlights };
}

function getGitHubRepoCandidate(item: SearchItem): GitHubRepoCandidate | undefined {
    try {
        const parsed = new URL(item.url);
        if (!/(^|\.)github\.com$/i.test(parsed.hostname)) {
            return undefined;
        }
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length < 2) {
            return undefined;
        }
        const [owner, repoRaw] = segments;
        if (!owner || !repoRaw || GITHUB_RESERVED_PATHS.has(owner.toLowerCase())) {
            return undefined;
        }
        if (segments.length > 2 && GITHUB_NON_REPO_SUBPATHS.has((segments[2] || '').toLowerCase())) {
            return undefined;
        }
        const repo = repoRaw.replace(/\.git$/i, '');
        if (!repo || GITHUB_RESERVED_PATHS.has(repo.toLowerCase())) {
            return undefined;
        }
        return {
            owner,
            repo,
            url: `https://github.com/${owner}/${repo}`,
            title: item.title,
            snippet: item.snippet,
        };
    } catch {
        return undefined;
    }
}

function scoreProjectCandidate(candidate: GitHubRepoCandidate, topic: string, writingRequirements?: string): number {
    const haystack = normalizeWhitespace(
        `${candidate.owner} ${candidate.repo} ${candidate.title} ${candidate.snippet} ${topic} ${writingRequirements || ''}`,
    );

    let score = 0;
    if (/github/i.test(candidate.title)) score += 1;
    if (candidate.snippet.length > 20) score += 1;
    if (containsKeyword(haystack, PROJECT_SIGNAL_KEYWORDS)) score += 3;
    if (/deploy|installation|quick start|self-hosted|docker|部署|安装|快速开始/u.test(haystack)) score += 2;
    if (containsKeyword(candidate.repo, STRONG_COLLECTION_KEYWORDS)) score -= 8;
    if (containsKeyword(candidate.title, STRONG_COLLECTION_KEYWORDS)) score -= 6;
    if (containsKeyword(candidate.snippet, STRONG_COLLECTION_KEYWORDS)) score -= 5;
    if (containsKeyword(candidate.repo, SOFT_COLLECTION_KEYWORDS)) score -= 3;
    if (containsKeyword(candidate.title, SOFT_COLLECTION_KEYWORDS)) score -= 2;
    if (containsKeyword(candidate.title, NOTE_RESOURCE_KEYWORDS)) score -= 4;
    if (containsKeyword(candidate.snippet, NOTE_RESOURCE_KEYWORDS)) score -= 4;

    return score;
}

function rankProjectCandidates(
    searchItems: SearchItem[],
    topic: string,
    writingRequirements?: string,
): ScoredGitHubRepoCandidate[] {
    const seen = new Set<string>();
    const candidates: ScoredGitHubRepoCandidate[] = [];

    for (const item of searchItems) {
        const candidate = getGitHubRepoCandidate(item);
        if (!candidate || seen.has(candidate.url)) {
            continue;
        }
        seen.add(candidate.url);
        const score = scoreProjectCandidate(candidate, topic, writingRequirements);
        if (score >= 0) {
            candidates.push({ ...candidate, score });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

function scoreProjectContext(candidate: GitHubRepoCandidate, context: GitHubRepoContext): number {
    const haystack = normalizeWhitespace(
        `${candidate.repo} ${candidate.title} ${context.projectName} ${context.description} ${context.highlights.join(' ')} ${context.installSteps.join(' ')} ${context.usageSteps.join(' ')}`,
    );
    const installText = context.installSteps.join('\n');
    const usageText = context.usageSteps.join('\n');
    const hasInstallCommands = /npm|pnpm|yarn|bun|docker|docker compose|git clone|pip install|uv pip|go install|cargo install|python -m|node |cp |cd /iu.test(installText);
    const hasUsageCommands = /npm|pnpm|yarn|bun|docker|docker compose|git clone|pip install|uv pip|go install|cargo install|python -m|node |cp |cd /iu.test(usageText);

    let score = 0;
    score += Math.min(context.highlights.length, 3);
    score += Math.min(context.installSteps.length, 4) * 2;
    score += Math.min(context.usageSteps.length, 4) * 2;
    if (hasInstallCommands) score += 3;
    if (hasUsageCommands) score += 2;
    if (containsKeyword(haystack, PROJECT_SIGNAL_KEYWORDS)) score += 2;
    if (containsKeyword(haystack, STRONG_COLLECTION_KEYWORDS)) score -= 8;
    if (containsKeyword(haystack, NOTE_RESOURCE_KEYWORDS)) score -= 5;
    if (/每周|每月|收集|整理|推荐|精选|周刊|日报|awesome list|curated list/u.test(haystack)) score -= 8;
    if (/contribute to .+ development by creating an account on github/i.test(context.description)) score -= 8;
    if (context.detailLevel === 'search_snippet') {
        if (!hasInstallCommands) score -= 2;
        if (!hasUsageCommands) score -= 1;
    } else {
        if (!hasInstallCommands) score -= 6;
        if (!hasUsageCommands) score -= 3;
        if (context.installSteps.length === 0) score -= 2;
        if (context.usageSteps.length === 0) score -= 1;
    }

    return score;
}

async function resolvePrimaryProjectContext(
    searchItems: SearchItem[],
    topic: string,
    writingRequirements?: string,
): Promise<GitHubRepoContext | undefined> {
    const candidates = rankProjectCandidates(searchItems, topic, writingRequirements).slice(0, MAX_PROJECT_CANDIDATES);
    let bestContext: GitHubRepoContext | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
        const context = await fetchGitHubRepoContext(candidate, searchItems);
        const score = candidate.score + scoreProjectContext(candidate, context);
        if (score > bestScore) {
            bestScore = score;
            bestContext = context;
        }
    }

    return bestScore >= 5 ? bestContext : undefined;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`repo fetch failed: ${response.status} ${response.statusText}`);
        }
        return await response.text();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
    const text = await fetchText(url, timeoutMs);
    const parsed = safeParseJson(text);
    if (parsed === null) {
        throw new Error('invalid json response');
    }
    return parsed as T;
}

async function fetchGitHubRepoApi(owner: string, repo: string): Promise<GitHubRepoApiInfo | undefined> {
    try {
        const data = await fetchJson<Record<string, unknown>>(
            `https://api.github.com/repos/${owner}/${repo}`,
            Math.min(REPO_FETCH_TIMEOUT_MS, 6000),
        );
        return {
            fullName: typeof data.full_name === 'string' ? data.full_name : undefined,
            description: typeof data.description === 'string' ? data.description : undefined,
            homepage: typeof data.homepage === 'string' ? data.homepage : undefined,
            language: typeof data.language === 'string' ? data.language : undefined,
            license: typeof toRecord(data.license).spdx_id === 'string' ? String(toRecord(data.license).spdx_id) : undefined,
            stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined,
            updatedAt: typeof data.updated_at === 'string' ? data.updated_at : undefined,
            defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : undefined,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[daily_blog_digest] github api fetch failed: ${message}`);
        return undefined;
    }
}

async function fetchRawRepoFile(owner: string, repo: string, branch: string, paths: string[]): Promise<{ path: string; text: string } | undefined> {
    for (const path of paths) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
        try {
            const text = await fetchText(url, Math.min(REPO_FETCH_TIMEOUT_MS, 5000));
            if (text.trim()) {
                return { path, text };
            }
        } catch {
            continue;
        }
    }
    return undefined;
}

async function fetchGitHubReadme(owner: string, repo: string): Promise<string> {
    const candidates = [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/readme.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/readme.md`,
    ];

    for (const url of candidates) {
        try {
            const text = await fetchText(url, Math.min(REPO_FETCH_TIMEOUT_MS, 5000));
            if (text.trim()) {
                return stripMarkdown(text)
                    .split('\n')
                    .map((line) => normalizeWhitespace(line))
                    .filter(Boolean)
                    .join('\n');
            }
        } catch {
            continue;
        }
    }

    return '';
}

async function fetchGitHubRepoContext(candidate: GitHubRepoCandidate, searchItems: SearchItem[]): Promise<GitHubRepoContext> {
    const repoApi = await fetchGitHubRepoApi(candidate.owner, candidate.repo);
    const defaultBranch = repoApi?.defaultBranch || 'main';
    let description = repoApi?.description || candidate.snippet;
    let readmeText = '';
    let detailLevel: 'search_snippet' | 'repo_page' | 'raw_readme' = 'search_snippet';
    let dockerComposeText = '';
    let installScriptPath: string | undefined;
    try {
        const html = await fetchText(candidate.url, REPO_FETCH_TIMEOUT_MS);
        description =
            extractMetaContent(html, 'property', 'og:description')
            || extractMetaContent(html, 'name', 'description')
            || repoApi?.description
            || candidate.snippet;

        const readmeMatch = html.match(/<article[^>]*markdown-body[^>]*>([\s\S]*?)<\/article>/i)
            || html.match(/<div[^>]+id=["']readme["'][\s\S]*?<article[^>]*>([\s\S]*?)<\/article>/i);
        readmeText = readmeMatch?.[1] ? stripHtml(readmeMatch[1]) : '';
        if (readmeText) {
            detailLevel = 'repo_page';
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[daily_blog_digest] repo detail fetch failed: ${message}`);
    }

    if (!readmeText) {
        readmeText = await fetchGitHubReadme(candidate.owner, candidate.repo);
        if (readmeText) {
            detailLevel = 'raw_readme';
        }
    }

    const installScript = await fetchRawRepoFile(candidate.owner, candidate.repo, defaultBranch, ['install.sh', 'scripts/install.sh']);
    installScriptPath = installScript?.path;
    const composeFile = await fetchRawRepoFile(candidate.owner, candidate.repo, defaultBranch, ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
    dockerComposeText = composeFile?.text || '';

    const installSection = extractSectionLines(readmeText, ['installation', 'install', 'getting started', 'quick start', '部署', '安装', '快速开始'], 8);
    const usageSection = extractSectionLines(readmeText, ['usage', 'how to use', '运行', '使用', '示例', 'demo'], 8);
    const bulletHighlights = dedupe(
        readmeText
            .split('\n')
            .map((line) => normalizeWhitespace(line))
            .filter((line) => line.startsWith('- ') && line.length >= 8 && line.length <= 120)
            .map((line) => line.replace(/^- /, '')),
    ).slice(0, 4);
    const fallbackHighlights = toSentenceList(`${description}\n${candidate.snippet}\n${repoApi?.description || ''}`, 3);
    const manualHints = buildInstallAndUsageHints(candidate.owner, candidate.repo, defaultBranch, readmeText, dockerComposeText, installScriptPath);
    const installSteps = uniqueProjectLines(
        installSection.length > 0 ? [...manualHints.installLines, ...installSection] : manualHints.installLines,
        6,
    );
    const usageSteps = uniqueProjectLines(
        usageSection.length > 0 ? [...usageSection, ...manualHints.usageLines] : manualHints.usageLines,
        5,
    );
    const metadataLines = buildRepoMetadataLines(repoApi || {}, candidate.url);

    const relatedItems = searchItems.filter((item) => {
        if (item.url === candidate.url) return true;
        return item.url.includes(candidate.repo) || item.title.includes(candidate.repo) || item.title.includes(candidate.owner);
    });

    return {
        projectName: toDisplayProjectName(candidate.title, candidate.repo),
        repoUrl: candidate.url,
        description,
        highlights: uniqueProjectLines(
            [...manualHints.extraHighlights, ...(bulletHighlights.length > 0 ? bulletHighlights : fallbackHighlights)],
            6,
        ),
        installSteps: installSteps.length > 0 ? installSteps.slice(0, 6) : [],
        usageSteps: usageSteps.length > 0 ? usageSteps.slice(0, 5) : [],
        sourceItems: dedupe([candidate.url, ...relatedItems.map((item) => item.url)])
            .map((url) => searchItems.find((item) => item.url === url) || {
                title: candidate.title,
                url: candidate.url,
                snippet: candidate.snippet,
            })
            .slice(0, 4),
        detailLevel,
        homepage: repoApi?.homepage,
        language: repoApi?.language,
        license: repoApi?.license,
        stars: repoApi?.stars,
        updatedAt: repoApi?.updatedAt,
        metadataLines,
    };
}

function normalizeSearchResults(raw: unknown): SearchItem[] {
    const record = toRecord(raw);
    const candidates = [record.results, record.data, record.items, record.news].find((v) => Array.isArray(v));
    if (!Array.isArray(candidates)) return [];

    const mapped: SearchItem[] = [];
    for (const item of candidates) {
        const r = toRecord(item);
        const title = typeof r.title === 'string' ? r.title.trim() : '';
        const url = typeof r.url === 'string' ? r.url.trim() : typeof r.link === 'string' ? r.link.trim() : '';
        const snippetRaw =
            typeof r.snippet === 'string'
                ? r.snippet
                : typeof r.content === 'string'
                  ? r.content
                  : typeof r.description === 'string'
                    ? r.description
                    : '';
        const snippet = snippetRaw.trim();
        const publishedAt = typeof r.publishedAt === 'string' ? r.publishedAt : typeof r.published_date === 'string' ? r.published_date : undefined;
        const image = typeof r.image === 'string' ? r.image : typeof r.image_url === 'string' ? r.image_url : undefined;

        if (title && url && snippet) {
            mapped.push({ title, url, snippet, publishedAt, image });
        }
    }
    return mapped;
}

function mergeSearchItems(...groups: SearchItem[][]): SearchItem[] {
    const merged: SearchItem[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
        for (const item of group) {
            if (seen.has(item.url)) {
                continue;
            }
            seen.add(item.url);
            merged.push(item);
        }
    }
    return merged;
}

async function runSearchQuery(query: string): Promise<SearchFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.search.timeoutMs);

    try {
        const url = new URL(config.search.searchPath, config.search.baseUrl).toString();
        const payload = {
            query,
            q: query,
            max_results: config.search.maxResults,
            days: config.search.freshnessDays,
            include_images: true,
        };

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.search.apiKey) {
            headers.Authorization = `Bearer ${config.search.apiKey}`;
            headers['X-API-Key'] = config.search.apiKey;
        }

        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!resp.ok) {
            throw new Error(`search api error: ${resp.status} ${resp.statusText}`);
        }

        const json = (await resp.json()) as unknown;
        return {
            items: normalizeSearchResults(json).slice(0, config.search.maxResults),
        };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn(`[daily_blog_digest] search failed: ${msg}`);
        return {
            items: [],
            error: msg,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function searchLatest(topic: string, mode: ArticleMode, writingRequirements?: string): Promise<SearchFetchResult> {
    return runSearchQuery(buildSearchQuery(topic, mode, writingRequirements));
}

function buildDigestArticle(
    topic: string,
    style: string,
    signature: string,
    searchItems: SearchItem[],
    now: Date,
    requirementPoints: string[],
): { title: string; content: string } {
    const dateText = formatDate(now);
    const title = `${topic}｜${dateText} 每日观察`;
    const selected = searchItems.slice(0, config.defaults.maxSections);

    const intro = [
        `## 导语`,
        selected.length > 0
            ? `今天我们围绕「${topic}」梳理了最新动态，采用「${style}」方式做快速归纳。`
            : `今天我们围绕「${topic}」做离线主题整理，采用「${style}」方式输出一篇可直接发布的观察稿。`,
        selected.length > 0
            ? `以下内容基于公开信息整理，并加入了便于阅读的要点化解读。`
            : `当前未引用实时联网检索结果，以下内容基于既有主题认知做结构化整理，适合作为栏目稿或定时更新稿。`,
        '',
    ];

    if (requirementPoints.length > 0) {
        intro.push('## 写作重点');
        intro.push(...requirementPoints.map((item) => `- ${item}`));
        intro.push('');
    }

    const sections: string[] = ['## 正文分节'];

    if (selected.length === 0) {
        sections.push(
            `### 1) 主题背景`,
            `「${topic}」仍然值得持续关注，因为它通常直接反映行业热度、用户兴趣变化或平台策略调整。`,
            `即使暂时不依赖联网搜索，也可以围绕概念演进、典型应用场景和受众反馈来组织一篇完整内容。`,
            '',
            `### 2) 当前看点`,
            `从内容选题角度看，这一主题适合拆成“最新动向”“核心影响”“读者最关心的问题”三个层次展开。`,
            `如果后续补充到新的案例、公告或产品动作，可以直接替换为具体事实，不需要重写整篇结构。`,
            '',
            `### 3) 发布建议`,
            `离线稿件更适合做栏目化表达，例如日报、周观察、主题盘点或编辑部短评。`,
            `为了避免空泛，发布时建议在标题、导语和总结中明确说明观察角度，而不是堆砌泛化判断。`,
            '',
            `### 4) 后续跟进`,
            `后续可继续补充官方公告、媒体报道、社区反馈或产品更新记录，让本文从“框架稿”自然升级为“资讯稿”。`,
            `这类先成稿、后增量补充的方式，比因为搜索失败而完全卡住发布流程更稳定。`,
            ''
        );
    } else {
        selected.forEach((item, idx) => {
            sections.push(
                `### ${idx + 1}) ${item.title}`,
                `${item.snippet}`,
                `- 来源：${item.url}`,
                item.publishedAt ? `- 时间：${item.publishedAt}` : `- 时间：${dateText}`,
                `- 观察：该信息反映了「${topic}」在近期的一个关键变化点，值得继续跟踪后续影响。`,
                ''
            );
        });
    }

    const summaryLines = selected.slice(0, config.defaults.maxSummaryPoints).map((item, idx) => `- 要点 ${idx + 1}：${item.title}`);
    if (summaryLines.length === 0) {
        summaryLines.push(`- 要点 1：本篇按离线模式生成，适合作为「${topic}」的栏目化基础稿。`);
        summaryLines.push(`- 要点 2：后续如补充外部资料，可直接替换正文分节中的背景与看点部分。`);
    }

    const summary = ['## 要点总结', ...summaryLines, '', signature];
    const content = [...intro, ...sections, ...summary].join('\n');
    return { title, content };
}

function buildProjectRecommendationArticle(
    topic: string,
    style: string,
    signature: string,
    project: GitHubRepoContext | undefined,
    searchItems: SearchItem[],
    now: Date,
    requirementPoints: string[],
): { title: string; content: string } {
    const dateText = formatDate(now);
    const selected = (project?.sourceItems || searchItems).slice(0, 4);
    const sourceLines = selected.length > 0
        ? selected.flatMap((item, idx) => [
            `### 参考资料 ${idx + 1}`,
            `- 标题：${item.title}`,
            `- 链接：${item.url}`,
            `- 摘要：${item.snippet}`,
            item.publishedAt ? `- 时间：${item.publishedAt}` : `- 时间：${dateText}`,
            '',
        ])
        : [
            '### 参考资料',
            '- 当前未检索到可用公开资料，正文按离线结构稿生成，发布后可继续补充真实项目细节与仓库地址。',
            '',
        ];
    const requirementBlock = requirementPoints.length > 0
        ? ['## 本稿重点', ...requirementPoints.map((item) => `- ${item}`), '']
        : [];
    const projectName = toHumanProjectName(project?.projectName || topic);
    const projectDescription = project?.description || `当前围绕「${topic}」整理到一个候选项目，建议以仓库 README 与公开资料为准继续补充细节。`;
    const metadataLines = uniqueProjectLines(project?.metadataLines || [], 5);
    const highlightLines = uniqueProjectLines((project?.highlights || []).filter((item) => !isProjectMetadataLine(item)), 6);
    const installLines = uniqueProjectLines(project?.installSteps || [], 5);
    const usageLines = uniqueProjectLines(project?.usageSteps || [], 5);
    const introLines = toParagraphs(projectDescription, 2);
    const scenarioLines = uniqueProjectLines(
        [
            ...toParagraphs(`${projectDescription}\n${selected.map((item) => item.snippet).join('\n')}`, 4),
            ...highlightLines,
        ],
        4,
    );
    const audienceLines = buildProjectAudience(projectName, `${projectDescription}\n${selected.map((item) => item.snippet).join('\n')}\n${highlightLines.join('\n')}`);
    const cautionLines = buildProjectCautions(projectName, `${projectDescription}\n${selected.map((item) => item.snippet).join('\n')}`);
    const title = `${projectName}：一个值得上手的开源项目`;
    const detailNotice = project?.detailLevel === 'search_snippet'
        ? '当前 GitHub README 抓取超时，以下内容主要依据仓库摘要与公开检索线索整理。'
        : undefined;
    const content = [
        '## 导语',
        `本文围绕「${projectName}」整理一篇偏「${style}」的项目推荐稿，重点强调它解决什么问题、适合谁，以及怎么尽快部署起来。`,
        project?.repoUrl ? `本次锁定的仓库地址：${project.repoUrl}` : `当前未锁定到明确仓库，以下内容主要依据公开检索线索整理。`,
        ...(detailNotice ? [detailNotice] : []),
        '',
        ...requirementBlock,
        '## 1. 项目简介',
        `项目名称：${projectName}`,
        ...(metadataLines.length > 0 ? metadataLines : [project?.repoUrl ? `仓库地址：${project.repoUrl}` : `主题方向：${topic}`]),
        ...(introLines.length > 0 ? introLines : [cleanProjectLine(projectDescription)]),
        '',
        '## 2. 适用场景与核心用途',
        ...(scenarioLines.length > 0
            ? scenarioLines.map((item) => `- ${item}`)
            : ['- 适合需要把一个真实开源项目快速落地到测试环境或生产环境验证的人。']),
        '',
        '## 3. 功能亮点',
        ...(highlightLines.length > 0
            ? highlightLines.map((item) => `- ${item}`)
            : [
                '- 当前仓库页未抽到明确亮点列表，建议优先阅读 README、Release 和示例目录。',
                '- 可先从搜索结果中的项目定位、文档完整度和部署门槛判断是否值得落地。',
            ]),
        '',
        '## 4. 安装与部署教程',
        ...(installLines.length > 0
            ? installLines.map((item, idx) => `${idx + 1}. ${item}`)
            : [
                project?.detailLevel === 'search_snippet'
                    ? '1. 当前仓库 README 抓取超时，建议先打开仓库首页确认 Installation / Quick Start 小节。'
                    : '1. 当前公开资料里没有抽到完整安装段，建议先打开仓库 README 的 Installation / Quick Start 小节。',
                project?.repoUrl ? `2. 优先从仓库地址 ${project.repoUrl} 查环境要求、依赖安装和启动命令。`
                    : '2. 建议先补充仓库 README 后再发布正式部署教程。',
            ]),
        '',
        '## 5. 基础使用说明',
        ...(usageLines.length > 0
            ? usageLines.map((item, idx) => `${idx + 1}. ${item}`)
            : [
                project?.detailLevel === 'search_snippet'
                    ? '1. 当前仓库 README 抓取超时，建议优先查看仓库首页中的 Usage / Example / Demo 部分。'
                    : '1. 当前公开资料里没有抽到完整使用段，建议优先查看 README 中的 Usage / Example / Demo 部分。',
                '2. 发布到博客前，最好再确认首次启动步骤、最小可运行示例和关键环境变量。',
            ]),
        '',
        '## 6. 适合什么人',
        ...audienceLines.map((item) => `- ${item}`),
        '',
        '## 7. 注意事项与简评',
        ...cautionLines.map((item) => `- ${item}`),
        '',
        '## 参考线索',
        ...sourceLines,
        signature,
    ].join('\n');
    return { title, content };
}

function buildArticle(
    topic: string,
    style: string,
    signature: string,
    searchItems: SearchItem[],
    now: Date,
    mode: ArticleMode,
    project: GitHubRepoContext | undefined,
    writingRequirements?: string,
): { title: string; content: string } {
    const requirementPoints = summarizeRequirements(writingRequirements);
    return mode === 'project_recommendation'
        ? buildProjectRecommendationArticle(topic, style, signature, project, searchItems, now, requirementPoints)
        : buildDigestArticle(topic, style, signature, searchItems, now, requirementPoints);
}

function getCoverUrl(searchItems: SearchItem[], topic: string, mode: ArticleMode): { coverUrl?: string; generated: boolean } {
    const fromSearch = ensureCoverUrlLength(searchItems.find((x) => typeof x.image === 'string' && x.image.trim())?.image);
    if (fromSearch) {
        return { coverUrl: fromSearch, generated: false };
    }

    const promptBase = mode === 'project_recommendation'
        ? `${topic} GitHub 开源项目 封面`
        : `${topic} 博客封面 插画 风格化`;
    const prompt = encodeURIComponent(clampText(promptBase, COVER_PROMPT_MAX_LENGTH));
    let coverUrl = config.cover.generatedImageUrlTemplate.replace('{prompt}', prompt);
    if (coverUrl.length > SAFE_COVER_URL_MAX_LENGTH) {
        coverUrl = config.cover.generatedImageUrlTemplate.replace('{prompt}', encodeURIComponent('博客封面 插画'));
    }
    coverUrl = ensureCoverUrlLength(coverUrl) || '';
    return { coverUrl, generated: true };
}

async function blogRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown> | Array<number | string>,
    query?: Record<string, string>,
    requiredAuth = false,
): Promise<unknown> {
    const response = await requestBlogApi<unknown>({
        apiBaseUrl: config.blog.baseUrl,
        apiToken: config.blog.apiKey,
        apiUsername: config.blog.apiUsername,
        apiPassword: config.blog.apiPassword,
        loginClientType: config.blog.loginClientType,
        timeoutMs: config.blog.timeoutMs,
    }, {
        method,
        path,
        body,
        queryParams: query,
        requiredAuth,
    });

    if (response.code !== 200) {
        throw new Error(response.msg || `blog api error: ${response.code}`);
    }

    return response;
}

function extractEntityList(data: unknown): Array<Record<string, unknown>> {
    const r = toRecord(data);
    const listCandidates = [r.data, r.items, r.list, r.results].find((x) => Array.isArray(x));
    if (Array.isArray(listCandidates)) {
        return listCandidates.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
    }
    if (Array.isArray(data)) {
        return data.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
    }
    return [];
}

function getEntityName(item: Record<string, unknown>): string | undefined {
    if (typeof item.name === 'string' && item.name.trim()) return item.name.trim();
    if (typeof item.categoryName === 'string' && item.categoryName.trim()) return item.categoryName.trim();
    if (typeof item.tagName === 'string' && item.tagName.trim()) return item.tagName.trim();
    return undefined;
}

function getEntityId(item: Record<string, unknown>): ID | undefined {
    const candidates = [item.id, item.categoryId, item.tagId];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' || typeof candidate === 'number') return candidate;
    }
    return undefined;
}

async function ensureCategory(nameValue: string): Promise<CategoryEntity> {
    const listRaw = await blogRequest('GET', config.blog.categoryListPath, undefined, undefined, false);
    const list = extractEntityList(listRaw);
    const found = list.find((x) => getEntityName(x) === nameValue);
    const foundId = found ? getEntityId(found) : undefined;
    if (foundId !== undefined) {
        return { id: foundId, name: nameValue };
    }

    await blogRequest('PUT', config.blog.categoryCreatePath, { categoryName: nameValue }, undefined, true);
    const refreshedRaw = await blogRequest('GET', config.blog.categoryListPath, undefined, undefined, false);
    const refreshed = extractEntityList(refreshedRaw);
    const created = refreshed.find((x) => getEntityName(x) === nameValue);
    const createdId = created ? getEntityId(created) : undefined;
    if (createdId === undefined) {
        throw new Error(`创建分类后未找到分类：${nameValue}`);
    }

    return { id: createdId, name: nameValue };
}

async function ensureTag(nameValue: string): Promise<TagEntity> {
    const listRaw = await blogRequest('GET', config.blog.tagListPath, undefined, undefined, false);
    const list = extractEntityList(listRaw);
    const found = list.find((x) => getEntityName(x) === nameValue);
    const foundId = found ? getEntityId(found) : undefined;
    if (foundId !== undefined) {
        return { id: foundId, name: nameValue };
    }

    await blogRequest('PUT', config.blog.tagCreatePath, { tagName: nameValue }, undefined, true);
    const refreshedRaw = await blogRequest('GET', config.blog.tagListPath, undefined, undefined, false);
    const refreshed = extractEntityList(refreshedRaw);
    const created = refreshed.find((x) => getEntityName(x) === nameValue);
    const createdId = created ? getEntityId(created) : undefined;
    if (createdId === undefined) {
        throw new Error(`创建标签后未找到标签：${nameValue}`);
    }

    return { id: createdId, name: nameValue };
}

async function publishPost(payload: {
    title: string;
    content: string;
    categoryId: ID;
    tagIds: ID[];
    status: number;
    coverUrl?: string;
}): Promise<PublishResponse> {
    const body: Record<string, unknown> = config.blog.postCreatePath === '/article/publish'
        ? {
            articleTitle: payload.title,
            articleContent: payload.content,
            categoryId: payload.categoryId,
            tagId: payload.tagIds,
            articleCover: payload.coverUrl ?? '',
            articleType: 1,
            status: payload.status,
            isTop: 0,
        }
        : {
            title: payload.title,
            content: payload.content,
            categoryId: payload.categoryId,
            tagIds: payload.tagIds,
            status: payload.status,
            ...(payload.coverUrl ? { cover: payload.coverUrl } : {}),
        };

    const result = await blogRequest('POST', config.blog.postCreatePath, body, undefined, true);
    return toRecord(result) as PublishResponse;
}

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

export async function execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
        if (!config.blog.baseUrl) {
            return { success: false, text: '博客发布未配置：请设置 DAILY_BLOG_DIGEST_BLOG_BASE_URL。' };
        }

        const now = new Date();
        const categoryName = getString(params, ['category_name', 'categoryName', 'category']) || config.defaults.categoryName;
        const topicResolution = resolveTopic(params, pickTopicByTime(now));
        const topic = topicResolution.topic || categoryName || pickTopicByTime(now);
        const requestedTags = getStringArray(params, ['tag_names', 'tagNames', 'tags']) || [];
        const mappedTags = config.topicTagMapping[topic] || ['日报'];
        const tagNames = dedupe([...requestedTags, ...mappedTags]);

        const status = getInteger(params, ['status', 'publish_status']) ?? config.defaults.status;
        const requireCover = getBoolean(params, ['require_cover', 'requireCover', 'cover_required']) ?? config.defaults.requireCover;
        const allowEmptySources = getBoolean(params, ['allow_empty_sources', 'allowEmptySources']) ?? true;
        const signature = getString(params, ['signature', 'sign']) || config.defaults.signature;
        const style = getString(params, ['style', 'tone']) || config.defaults.style;
        const mode = detectArticleMode(topic, categoryName, style, topicResolution.writingRequirements);

        const searchResult = await searchLatest(topic, mode, topicResolution.writingRequirements);
        let effectiveSearchResult = searchResult;
        let searchItems = searchResult.items;
        if (searchItems.length === 0 && !allowEmptySources) {
            const reason = effectiveSearchResult.error
                ? `联网检索失败：${searchResult.error}`
                : '未检索到足够的公开资料';
            return {
                success: false,
                text: `已取消发布：${reason}。请检查 DAILY_BLOG_DIGEST_SEARCH_API_KEY、检索服务状态，或更换更具体的主题后再试。`,
                data: {
                    topic,
                    reason,
                    search_error: effectiveSearchResult.error,
                },
            };
        }

        let projectContext = mode === 'project_recommendation'
            ? await resolvePrimaryProjectContext(searchItems, topic, topicResolution.writingRequirements)
            : undefined;
        if (mode === 'project_recommendation' && !projectContext) {
            const fallbackQueries = buildProjectFallbackQueries(topic, topicResolution.writingRequirements);
            for (const query of fallbackQueries) {
                const fallbackResult = await runSearchQuery(query);
                searchItems = mergeSearchItems(searchItems, fallbackResult.items);
                effectiveSearchResult = {
                    items: searchItems,
                    error: effectiveSearchResult.error || fallbackResult.error,
                };
                projectContext = await resolvePrimaryProjectContext(searchItems, topic, topicResolution.writingRequirements);
                if (projectContext) {
                    break;
                }
            }
        }
        if (mode === 'project_recommendation' && !projectContext) {
            const reason = searchItems.length === 0
                ? (effectiveSearchResult.error ? `联网检索失败：${effectiveSearchResult.error}` : '未检索到可用结果')
                : '检索结果里没有找到合适的可部署 GitHub 项目';
            return {
                success: false,
                text: `已取消发布：${reason}，无法按“具体项目推荐”要求生成正文。当前结果更像合集/榜单/教程，而不是单个项目。请提供更明确的项目方向，或确认搜索结果里存在可部署仓库后重试。`,
                data: {
                    topic,
                    reason,
                    search_error: effectiveSearchResult.error,
                    mode,
                    search_count: searchItems.length,
                },
            };
        }

        const article = buildArticle(
            topic,
            style,
            signature,
            searchItems,
            now,
            mode,
            projectContext,
            topicResolution.writingRequirements,
        );
        const hasSignature = article.content.includes(signature);

        const { coverUrl, generated } = getCoverUrl(searchItems, topic, mode);
        const finalCoverUrl = requireCover ? ensureCoverUrlLength(coverUrl) : undefined;
        const hasCover = Boolean(finalCoverUrl);

        const category = await ensureCategory(categoryName);
        const tags = await Promise.all(tagNames.map((tag) => ensureTag(tag)));

        const publishResp = await publishPost({
            title: article.title,
            content: article.content,
            categoryId: category.id,
            tagIds: tags.map((t) => t.id),
            status,
            coverUrl: finalCoverUrl,
        });

        const postId =
            publishResp.id ??
            publishResp.postId ??
            (publishResp.data?.id ?? publishResp.data?.postId ?? 'unknown');

        const publishTime = new Date().toISOString();

        const text = [
            '✅ 博客已生成并发布',
            `标题：${article.title}`,
            `分类：${category.name}`,
            `标签：${tags.map((t) => t.name).join('、') || '无'}`,
            `发布时间：${publishTime}`,
            `联网检索：${searchItems.length > 0 ? `成功（${searchItems.length} 条）` : effectiveSearchResult.error ? `失败，已按离线模式生成` : '未命中结果，已按离线模式生成'}`,
            `封面：${hasCover ? generated ? '已生成封面' : '已使用检索封面' : '未添加'}`,
            `署名：${hasSignature ? '已包含' : '缺失'}`,
            `文章ID：${String(postId)}`,
        ].join('\n');

        return {
            success: true,
            text,
            data: {
                title: article.title,
                category: category.name,
                tags: tags.map((t) => t.name),
                publishTime,
                hasCover,
                coverGenerated: generated,
                hasSignature,
                signature,
                articleId: postId,
                topic,
                mode,
                writingRequirementsUsed: Boolean(topicResolution.writingRequirements),
                topicHintUsedAsInstruction: topicResolution.hintUsedAsInstruction,
                sourceCount: searchItems.length,
                searchError: effectiveSearchResult.error,
                offlineFallbackUsed: searchItems.length === 0,
                project: projectContext
                    ? {
                        name: projectContext.projectName,
                        repoUrl: projectContext.repoUrl,
                    }
                    : undefined,
                senderId: ctx.senderId,
                groupId: ctx.groupId,
            },
        };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`[daily_blog_digest] execute failed: ${msg}`);
        return { success: false, text: `daily_blog_digest 执行失败：${msg}` };
    }
}

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Tool;
