/**
 * Weather 模块
 * 
 * 查询天气预报（和风天气 API）
 */

import { log } from '../../logger.js';
import { URLS } from '../../utils/urls.js';
import { config } from './config.js';
import { schema } from './schema.js';
import type { Module, ModuleContext, ModuleResult } from '../types.js';

// ==================== 类型定义 ====================

interface QWeatherGeoLocation {
    name: string;
    id: string;
    adm1: string;
    adm2: string;
}

interface QWeatherGeoResponse {
    code: string;
    location?: QWeatherGeoLocation[];
}

interface QWeatherNow {
    text: string;
    temp: string;
    feelsLike: string;
    humidity: string;
    windDir: string;
    windScale: string;
}

interface QWeatherNowResponse {
    code: string;
    now: QWeatherNow;
}

interface QWeatherDaily {
    fxDate: string;
    textDay: string;
    tempMin: string;
    tempMax: string;
}

interface QWeatherDailyResponse {
    code: string;
    daily?: QWeatherDaily[];
}

interface WeatherParams {
    city?: string;
    location?: string;
    text?: string;
}

// ==================== 模块元数据 ====================

export const name = 'weather';
export const description = '查询天气预报';
export const keywords = ['天气', '气温', '下雨', '下雪', '温度', '几度', '穿什么'];

export function enabled(): boolean {
    return config.enabled;
}

export { schema };

// ==================== 内部函数 ====================

/** 城市搜索 */
async function searchCity(keyword: string): Promise<{ id: string; name: string; adm1: string; adm2: string } | null> {
    try {
        const url = `${URLS.QWEATHER_API(config.apiHost, '/geo/v2/city/lookup')}?key=${config.apiKey}&location=${encodeURIComponent(keyword)}&number=1`;
        const response = await fetch(url);
        const data = await response.json() as QWeatherGeoResponse;

        if (data.code === '200' && data.location && data.location.length > 0) {
            const loc = data.location[0];
            return {
                id: loc.id,
                name: loc.name,
                adm1: loc.adm1,
                adm2: loc.adm2,
            };
        }
        return null;
    } catch (err) {
        log.error('城市搜索失败:', err);
        return null;
    }
}

/** 实时天气 */
async function getNowWeather(locationId: string): Promise<QWeatherNow | null> {
    const url = `${URLS.QWEATHER_API(config.apiHost, '/v7/weather/now')}?key=${config.apiKey}&location=${locationId}`;
    const response = await fetch(url);
    const data = await response.json() as QWeatherNowResponse;

    if (data.code === '200') {
        return data.now;
    }
    return null;
}

/** 3日天气预报 */
async function getForecast(locationId: string): Promise<QWeatherDaily[]> {
    const url = `${URLS.QWEATHER_API(config.apiHost, '/v7/weather/3d')}?key=${config.apiKey}&location=${locationId}`;
    const response = await fetch(url);
    const data = await response.json() as QWeatherDailyResponse;

    if (data.code === '200') {
        return data.daily || [];
    }
    return [];
}

/** 从文本中提取城市名 */
function extractCity(text: string): string | null {
    const cleanText = text
        .replace(/给.{0,5}(点赞|赞一下|点个赞)/g, '')
        .replace(/帮我|帮忙|请|麻烦/g, '')
        .replace(/查查|查一下|看看|告诉我/g, '')
        .trim();

    const suffixes = ['市', '县', '区', '省', '州', '盟', '旗'];

    // 模式1: 明确的 "XX天气" 格式
    const pattern1 = /([^\s,，。！!]{2,6}?)(?:的)?天气/;
    const match1 = cleanText.match(pattern1);
    if (match1?.[1]) {
        const city = match1[1].trim();
        const invalid = ['今天', '明天', '后天', '现在', '这里', '那里', '怎么', '什么', '如何'];
        if (city.length >= 2 && !invalid.includes(city)) {
            return city;
        }
    }

    // 模式2: 带地区后缀的词
    for (const suffix of suffixes) {
        const pattern = new RegExp(`([\\u4e00-\\u9fa5]{1,4}${suffix})`);
        const match = cleanText.match(pattern);
        if (match?.[1]) {
            return match[1];
        }
    }

    // 模式3: 常见城市名
    const commonCities = [
        '北京', '上海', '广州', '深圳', '杭州', '成都', '重庆', '武汉', '西安', '南京',
        '天津', '苏州', '郑州', '长沙', '青岛', '沈阳', '大连', '厦门', '福州', '济南',
        '清远', '佛山', '东莞', '珠海', '中山', '惠州', '江门', '湛江', '茂名', '肇庆',
        '汕头', '潮州', '揭阳', '梅州', '韶关', '河源', '云浮', '阳江', '汕尾',
    ];
    for (const city of commonCities) {
        if (cleanText.includes(city)) {
            return city;
        }
    }

    return null;
}

// ==================== 模块执行 ====================

export async function execute(
    params: Record<string, unknown>,
    _ctx: ModuleContext
): Promise<ModuleResult> {
    const p = params as WeatherParams;
    let cityName = p.location || p.city;

    if (!cityName && p.text) {
        cityName = extractCity(p.text) || undefined;
    }

    if (!cityName) {
        return { success: false, text: '要查哪个城市的天气呀？告诉我城市名喵~' };
    }

    try {
        log.info(`🔧 模块: 查询天气 ${cityName}`);

        const city = await searchCity(cityName);
        if (!city) {
            return { success: false, text: `找不到 ${cityName} 这个地方呢，换个名字试试喵~` };
        }

        const now = await getNowWeather(city.id);
        if (!now) {
            return { success: false, text: '获取天气失败了喵，等会再试试~' };
        }

        const forecast = await getForecast(city.id);

        const location = city.adm1 === city.adm2 ? city.name : `${city.adm1} ${city.name}`;

        const lines = [
            `📍 ${location} 天气`,
            ``,
            `🌡️ 实时天气：`,
            `  ${now.text} ${now.temp}°C`,
            `  体感温度：${now.feelsLike}°C`,
            `  湿度：${now.humidity}%`,
            `  风：${now.windDir} ${now.windScale}级`,
        ];

        if (forecast.length > 0) {
            lines.push(``, `📅 未来天气：`);
            for (const day of forecast.slice(0, 3)) {
                const date = day.fxDate.slice(5);
                lines.push(`  ${date}: ${day.textDay} ${day.tempMin}~${day.tempMax}°C`);
            }
        }

        const temp = parseInt(now.temp, 10);
        let advice = '';
        if (temp <= 5) advice = '❄️ 天气很冷，要多穿衣服保暖哦！';
        else if (temp <= 15) advice = '🧥 有点凉，建议穿外套~';
        else if (temp >= 30) advice = '☀️ 天气很热，注意防暑降温！';

        if (now.text.includes('雨')) advice += ' 🌧️ 记得带伞！';
        if (now.text.includes('雪')) advice += ' 🌨️ 下雪啦，出行注意安全~';

        if (advice) lines.push(``, advice);

        return {
            success: true,
            text: lines.join('\n'),
            data: { city, now, forecast },
        };
    } catch (err) {
        log.error('天气查询失败:', err);
        const errMsg = err instanceof Error ? err.message : '未知错误';
        return { success: false, text: `查询天气失败了喵: ${errMsg}` };
    }
}

// ==================== 默认导出 ====================

export const getTaskConfig = () => ({
    timeoutMs: config.timeoutMs,
    concurrency: config.concurrency,
});

export default { name, description, keywords, enabled, schema, execute, getTaskConfig } satisfies Module;
