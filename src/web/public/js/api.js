function getBasePath() {
    if (typeof window === 'undefined') return '';
    const raw = String(window.GENESIS_BASE_PATH || document.documentElement?.dataset?.basePath || '').trim();
    if (!raw || raw === '/') return '';
    return raw.replace(/\/+$/g, '');
}

function getAppUrl(url) {
    const raw = String(url || '');
    if (!raw.startsWith('/')) {
        return raw;
    }

    const [pathWithSearch, hash = ''] = raw.split('#', 2);
    const [pathname = '/', search = ''] = pathWithSearch.split('?', 2);
    const basePath = getBasePath();
    const resolvedPath = pathname === '/'
        ? `${basePath || ''}/`
        : `${basePath}${pathname}`;
    return `${resolvedPath || '/'}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`;
}

async function request(url, options = {}) {
    const response = await fetch(getAppUrl(url), options);
    const contentType = response.headers.get('content-type') || '';
    let payload = null;

    if (response.status !== 204) {
        if (contentType.includes('application/json')) {
            try {
                payload = await response.json();
            } catch (e) {
                payload = null;
            }
        } else {
            const text = await response.text();
            payload = text || null;
        }
    }

    if (!response.ok) {
        const message = typeof payload === 'string'
            ? payload
            : payload?.error || payload?.message || response.statusText || `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

function withJsonBody(method, body) {
    return {
        method,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    };
}

const API = {
    get: async (url) => request(url, { headers: { 'Accept': 'application/json' } }),
    post: async (url, body) => request(url, withJsonBody('POST', body)),
    put: async (url, body) => request(url, withJsonBody('PUT', body)),
    del: async (url) => request(url, { method: 'DELETE', headers: { 'Accept': 'application/json' } }),
    delete: async (url) => request(url, { method: 'DELETE', headers: { 'Accept': 'application/json' } })
};

const Utils = {
    safeParseJson: (text, fallback = null) => {
        try {
            return JSON.parse(text);
        } catch {
            return fallback;
        }
    },
    formatUptime: (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    },
    formatDate: (ts) => new Date(ts).toLocaleString(),
    escapeHtml: (unsafe) => {
        if (typeof unsafe !== 'string') return String(unsafe);
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    },
    formatNumber: (num) => {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return String(num);
    }
};

export { API, Utils, getAppUrl };
