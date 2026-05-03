import { API, Utils, getAppUrl } from './api.js';

// --- State & Navigation ---
function sanitizeImageSrc(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:image/')) return raw;
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) return raw;

    try {
        const parsed = new URL(raw, window.location.origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.href;
        }
    } catch {
        return '';
    }

    return '';
}

function encodeInlineJsString(value) {
    return Utils.escapeHtml(JSON.stringify(String(value ?? '')));
}

function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

            item.classList.add('active');
            const pageId = item.dataset.page;

            const targetPage = document.getElementById('page-' + pageId);
            if (targetPage) {
                targetPage.classList.add('active');
                document.getElementById('page-header').innerText = item.querySelector('span').innerText;
                refreshPage(pageId);
            }
        });
    });
}

function refreshPage(pageId) {
    if (pageId === 'dashboard') loadSystem();
    if (pageId === 'config') loadConfig();
    if (pageId === 'tools') loadTools();
    if (pageId === 'agents') loadAgents();
    if (pageId === 'profiles') loadProfiles();
    if (pageId === 'knowledge') loadKnowledge();
    if (pageId === 'memes') loadMemes();
    if (pageId === 'context') loadContext();
    if (pageId === 'blacklist') loadBlacklist();
    if (pageId === 'tasks') loadTasks();
    if (pageId === 'llm') loadLlmLogs();
    if (pageId === 'scheduler') loadScheduler();
}

let memeModalState = {
    mode: 'create',
    originalId: '',
    pack: null,
    archiveFile: null,
};

const AUTO_MEME_PRESETS = {
    low: { value: 0.12, label: '保守' },
    balanced: { value: 0.24, label: '均衡' },
    high: { value: 0.36, label: '高频' },
};

// --- Features ---

// 环形进度条更新辅助函数
function updateRingProgress(ringId, percent, color) {
    const ring = document.getElementById(ringId);
    if (!ring) return;

    // 圆周长 = 2 * PI * r = 2 * 3.14159 * 42 ≈ 264
    const circumference = 264;
    const offset = circumference - (percent / 100) * circumference;
    ring.style.strokeDashoffset = offset;

    // 根据百分比设置颜色
    if (percent >= PROFILE_FAVORABILITY_LEVELS.oldFriend) {
        ring.style.stroke = '#f85149'; // 红色
    } else if (percent >= PROFILE_FAVORABILITY_LEVELS.goodFriend) {
        ring.style.stroke = '#d29922'; // 黄色
    } else {
        ring.style.stroke = color || '#58a6ff'; // 默认蓝色
    }
}

function formatProcessStatusLabel(status) {
    switch ((status || '').toLowerCase()) {
        case 'online':
            return '运行中';
        case 'stopped':
        case 'stopping':
            return '已停止';
        case 'launching':
            return '启动中';
        case 'errored':
            return '异常';
        case 'missing':
            return '未注册';
        default:
            return status || '未知';
    }
}

const managedProcessPendingAction = {
    agent: null,
    adapter: null,
};

function getManagedProcessButtons(scope) {
    return {
        start: document.getElementById(`btn-${scope}-start`),
        stop: document.getElementById(`btn-${scope}-stop`),
        restart: document.getElementById(`btn-${scope}-restart`),
    };
}

function applyManagedProcessButtonState(scope, status, buttons) {
    const pendingAction = managedProcessPendingAction[scope];
    Object.entries(buttons).forEach(([action, btn]) => {
        if (!btn) return;
        const defaultLabel = btn.dataset.defaultLabel || btn.textContent || '';
        btn.dataset.defaultLabel = defaultLabel;
        if (pendingAction) {
            btn.disabled = true;
            btn.textContent = action === pendingAction ? '处理中...' : defaultLabel;
            return;
        }

        btn.textContent = defaultLabel;
        if (action === 'start') {
            btn.disabled = status === 'online' || status === 'launching';
        } else if (action === 'stop') {
            btn.disabled = status !== 'online';
        } else {
            btn.disabled = status !== 'online';
        }
    });
}

function restoreManagedProcessButtonStates() {
    const agentStatus = String(document.getElementById('dash-agent-status')?.dataset.status || 'unknown').toLowerCase();
    const adapterStatus = String(document.getElementById('dash-adapter-status')?.dataset.status || 'unknown').toLowerCase();

    applyManagedProcessButtonState('agent', agentStatus, getManagedProcessButtons('agent'));
    applyManagedProcessButtonState('adapter', adapterStatus, getManagedProcessButtons('adapter'));
}

function applyAgentProcessState(processInfo) {
    const statusEl = document.getElementById('dash-agent-status');
    const pidEl = document.getElementById('dash-agent-pid');
    const restartsEl = document.getElementById('dash-agent-restarts');
    const { start: startBtn, stop: stopBtn, restart: restartBtn } = getManagedProcessButtons('agent');
    if (!statusEl || !pidEl || !restartsEl || !startBtn || !stopBtn || !restartBtn) return;

    const status = (processInfo?.status || 'unknown').toLowerCase();
    statusEl.innerText = formatProcessStatusLabel(status);
    statusEl.dataset.status = status;
    statusEl.classList.remove('is-online', 'is-stopped', 'is-missing', 'is-errored');
    if (status === 'online') {
        statusEl.classList.add('is-online');
    } else if (status === 'errored') {
        statusEl.classList.add('is-errored');
    } else if (status === 'missing') {
        statusEl.classList.add('is-missing');
    } else {
        statusEl.classList.add('is-stopped');
    }

    pidEl.innerText = processInfo?.pid ?? '-';
    restartsEl.innerText = processInfo?.restarts ?? '-';
    applyManagedProcessButtonState('agent', status, {
        start: startBtn,
        stop: stopBtn,
        restart: restartBtn,
    });
}

function applyAdapterProcessState(processInfo) {
    const statusEl = document.getElementById('dash-adapter-status');
    const pidEl = document.getElementById('dash-adapter-pid');
    const restartsEl = document.getElementById('dash-adapter-restarts');
    const { start: startBtn, stop: stopBtn, restart: restartBtn } = getManagedProcessButtons('adapter');
    if (!statusEl || !pidEl || !restartsEl || !startBtn || !stopBtn || !restartBtn) return;

    const status = (processInfo?.status || 'unknown').toLowerCase();
    statusEl.innerText = formatProcessStatusLabel(status);
    statusEl.dataset.status = status;
    statusEl.classList.remove('is-online', 'is-stopped', 'is-missing', 'is-errored');
    if (status === 'online') {
        statusEl.classList.add('is-online');
    } else if (status === 'errored') {
        statusEl.classList.add('is-errored');
    } else if (status === 'missing') {
        statusEl.classList.add('is-missing');
    } else {
        statusEl.classList.add('is-stopped');
    }

    pidEl.innerText = processInfo?.pid ?? '-';
    restartsEl.innerText = processInfo?.restarts ?? '-';
    applyManagedProcessButtonState('adapter', status, {
        start: startBtn,
        stop: stopBtn,
        restart: restartBtn,
    });
}

async function refreshManagedProcessState() {
    await loadSystem();
}

async function refreshConfigAndManagedProcessState() {
    await Promise.all([
        loadConfig(),
        refreshManagedProcessState(),
    ]);
}

function renderRuntimeHealthSummary(runtimeHealth, runtimeMeta) {
    const container = document.getElementById('runtime-health-summary');
    const noteEl = document.getElementById('runtime-health-note');
    if (!container) return;

    const agentStatus = (runtimeHealth?.agent?.status || 'unknown').toLowerCase();
    const adapterStatus = (runtimeHealth?.adapter?.status || 'unknown').toLowerCase();
    const buildItem = (label, status, processInfo) => {
        const online = status === 'online';
        return `
            <div class="runtime-health-item ${online ? 'is-online' : 'is-warning'}">
                <span>${online ? '🟢' : '🔴'}</span>
                <span><strong>${label}</strong> ${formatProcessStatusLabel(status)}</span>
                <span>PID ${processInfo?.pid ?? '-'}</span>
            </div>
        `;
    };

    container.innerHTML = [
        buildItem('genesis-agent', agentStatus, runtimeHealth?.agent),
        buildItem('NapCat 适配器', adapterStatus, runtimeHealth?.adapter),
    ].join('');

    if (!noteEl) return;

    const processRole = runtimeMeta?.processRole || 'agent';
    const agentSource = runtimeMeta?.agentConfigSource === 'saved_env' ? '已保存配置' : '当前内存态';
    const adapterSource = runtimeMeta?.adapterConfigSource === 'saved_env' ? '已保存配置' : '当前内存态';
    const sourceSummary = `当前页来源: genesis-agent 显示${agentSource}，NapCat 适配器显示${adapterSource}。`;

    if (agentStatus === 'online' && adapterStatus === 'online') {
        const syncSummary = processRole === 'web'
            ? '当前页运行在 web-only 模式，保存后会尝试重启对应进程同步。'
            : '当前页直连 agent 进程，agent 配置可即时生效；适配器配置仍需同步对应进程。';
        noteEl.innerText = `${sourceSummary}${syncSummary} 如果同步失败，页面会单独提示。`;
        return;
    }

    const offlineTargets = [];
    if (agentStatus !== 'online') {
        offlineTargets.push('genesis-agent');
    }
    if (adapterStatus !== 'online') {
        offlineTargets.push('NapCat 适配器');
    }
    noteEl.innerText = `${sourceSummary}${offlineTargets.join(' / ')} 当前不在线，页面值未必等于对应进程内存态已经生效。`;
}

function renderSystemNetworkList(networkEl, networkList) {
    if (!networkEl) return;

    networkEl.replaceChildren();
    if (!Array.isArray(networkList) || networkList.length === 0) {
        const emptyItem = document.createElement('div');
        emptyItem.className = 'network-item';
        emptyItem.textContent = '无网络接口';
        networkEl.appendChild(emptyItem);
        return;
    }

    for (const network of networkList) {
        const item = document.createElement('div');
        item.className = 'network-item';

        const nameEl = document.createElement('span');
        nameEl.className = 'network-name';
        nameEl.textContent = network?.name || '-';

        const ipEl = document.createElement('span');
        ipEl.className = 'network-ip';
        ipEl.textContent = network?.ipv4 || '-';

        item.append(nameEl, ipEl);
        networkEl.appendChild(item);
    }
}

// Dashboard - 系统信息
async function loadSystem() {
    try {
        const d = await API.get('/api/system');

        // 运行时间
        const uptime = d.process.uptime;
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        document.getElementById('dash-uptime').innerText = hours > 0 ? `${hours}h ${mins}m` : `${mins} min`;
        document.getElementById('dash-start-time').innerText = new Date(Date.now() - uptime * 1000).toLocaleTimeString();

        // CPU
        const cpuPercent = d.cpu.usagePercent || 0;
        document.getElementById('dash-cpu-percent').innerText = `${cpuPercent}%`;
        updateRingProgress('ring-cpu', cpuPercent, '#58a6ff');
        document.getElementById('dash-cpu-model').innerText = `${d.cpu.cores} 核心`;

        // 内存
        const memPercent = d.memory.usagePercent || 0;
        document.getElementById('dash-mem-percent').innerText = `${memPercent}%`;
        updateRingProgress('ring-mem', memPercent, '#3fb950');
        document.getElementById('dash-mem-detail').innerText = `${d.memory.used} / ${d.memory.total} GB`;

        // 磁盘
        if (d.disk) {
            const diskPercent = d.disk.usagePercent || 0;
            document.getElementById('dash-disk-percent').innerText = `${diskPercent}%`;
            updateRingProgress('ring-disk', diskPercent, '#d29922');
            document.getElementById('dash-disk-detail').innerText = `${d.disk.used} / ${d.disk.total} GB`;
        }

        // 网络
        renderSystemNetworkList(document.getElementById('dash-network'), d.network);

        // 系统信息
        document.getElementById('dash-platform').innerText = d.platform || '-';
        document.getElementById('dash-arch').innerText = d.arch || '-';
        document.getElementById('dash-node').innerText = d.nodeVersion || '-';
        document.getElementById('dash-hostname').innerText = d.hostname || '-';
        document.getElementById('dash-cores').innerText = d.cpu.cores || '-';
        document.getElementById('dash-total-mem').innerText = `${d.memory.total} GB`;
        applyAgentProcessState(d.managedProcesses?.agent || null);
        applyAdapterProcessState(d.managedProcesses?.adapter || null);

    } catch (e) {
        console.error('Load system failed', e);
        restoreManagedProcessButtonStates();
    }
}

window.controlAgentProcess = async function (action) {
    const actionMap = {
        start: '启动',
        stop: '停止',
        restart: '重启',
    };
    const startBtn = document.getElementById('btn-agent-start');
    const stopBtn = document.getElementById('btn-agent-stop');
    const restartBtn = document.getElementById('btn-agent-restart');
    const statusEl = document.getElementById('dash-agent-status');
    if (managedProcessPendingAction.agent) {
        return;
    }

    managedProcessPendingAction.agent = action;
    applyManagedProcessButtonState('agent', String(statusEl?.dataset.status || 'unknown').toLowerCase(), {
        start: startBtn,
        stop: stopBtn,
        restart: restartBtn,
    });
    try {
        const result = await API.post(`/api/processes/agent/${action}`, {});
        if (!result.success) {
            throw new Error(result.error || result.message || '未知错误');
        }
        applyAgentProcessState(result.process);
        alert(result.message || `Agent 已${actionMap[action] || action}`);
    } catch (e) {
        alert(`Agent ${actionMap[action] || action}失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        managedProcessPendingAction.agent = null;
        await loadSystem();
    }
};

window.controlAdapterProcess = async function (action) {
    const actionMap = {
        start: '启动',
        stop: '停止',
        restart: '重启',
    };
    const startBtn = document.getElementById('btn-adapter-start');
    const stopBtn = document.getElementById('btn-adapter-stop');
    const restartBtn = document.getElementById('btn-adapter-restart');
    const statusEl = document.getElementById('dash-adapter-status');
    if (managedProcessPendingAction.adapter) {
        return;
    }

    managedProcessPendingAction.adapter = action;
    applyManagedProcessButtonState('adapter', String(statusEl?.dataset.status || 'unknown').toLowerCase(), {
        start: startBtn,
        stop: stopBtn,
        restart: restartBtn,
    });
    try {
        const result = await API.post(`/api/processes/adapter/${action}`, {});
        if (!result.success) {
            throw new Error(result.error || result.message || '未知错误');
        }
        applyAdapterProcessState(result.process);
        alert(result.message || `适配器已${actionMap[action] || action}`);
    } catch (e) {
        alert(`适配器${actionMap[action] || action}失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        managedProcessPendingAction.adapter = null;
        await loadSystem();
    }
};

// Dashboard - 配置和统计
let currentLlmConfigData = { modules: [], providers: [], templates: [] };
let currentLlmProviderEditingId = '';
let currentLlmModelBrowser = { moduleId: '', providerId: '', mode: 'module', statusHint: '' };
let currentLlmModelPickerState = { moduleId: '', activeIndex: -1 };
let llmModelPickerCloseTimer = null;

function getLlmBindingBadge(mode) {
    if (mode === 'provider') return '<span class="badge badge-success">Managed</span>';
    if (mode === 'matched') return '<span class="badge badge-warning">Matched</span>';
    return '<span class="badge badge-neutral">Legacy</span>';
}

function getLlmAvailabilityBadge(item) {
    if (item?.available === false) {
        return '<span class="badge badge-error">Unavailable</span>';
    }
    return '<span class="badge badge-success">Available</span>';
}

function getLlmProviderById(providerId) {
    return currentLlmConfigData.providers.find(provider => provider.id === providerId) || null;
}

function getLlmProviderModels(providerId) {
    const provider = getLlmProviderById(providerId);
    return provider && Array.isArray(provider.models) ? provider.models : [];
}

function formatLlmTimestamp(ts) {
    return ts ? new Date(ts).toLocaleString() : '未刷新';
}

function sortLlmModels(models, query) {
    const normalizedQuery = query.trim().toLowerCase();
    return [...models].sort((left, right) => {
        const leftStarts = normalizedQuery ? left.toLowerCase().startsWith(normalizedQuery) : false;
        const rightStarts = normalizedQuery ? right.toLowerCase().startsWith(normalizedQuery) : false;
        if (leftStarts !== rightStarts) {
            return leftStarts ? -1 : 1;
        }
        return left.localeCompare(right);
    });
}

function getLlmFilteredModels(providerId, query = '') {
    const models = getLlmProviderModels(providerId);
    const trimmedQuery = query.trim().toLowerCase();
    const filtered = trimmedQuery
        ? models.filter(model => model.toLowerCase().includes(trimmedQuery))
        : models;
    return sortLlmModels(filtered, query);
}

function getLlmModelSuggestions(providerId, query = '') {
    return getLlmFilteredModels(providerId, query).slice(0, 8);
}

function buildLlmModelHint(providerId, query = '') {
    if (!providerId) {
        return '先选择供应商。';
    }

    const models = getLlmProviderModels(providerId);
    if (models.length === 0) {
        return '该供应商还没有缓存模型，请先在上方点击“刷新模型”。';
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return `已缓存 ${models.length} 个模型，输入即可筛选。`;
    }

    const matches = getLlmFilteredModels(providerId, trimmedQuery);
    if (matches.length === 0) {
        return '没有匹配模型，你也可以手动输入自定义模型名。';
    }

    return `匹配到 ${matches.length} / ${models.length} 个模型。`;
}

function buildLlmProviderSelectOptions(selectedProviderId) {
    const options = ['<option value="">请选择供应商</option>'];
    currentLlmConfigData.providers.forEach(provider => {
        options.push(
            `<option value="${Utils.escapeHtml(provider.id)}" ${provider.id === selectedProviderId ? 'selected' : ''}>
                ${Utils.escapeHtml(provider.name)}
            </option>`
        );
    });
    return options.join('');
}

function renderLlmModuleGroups(modules) {
    const groups = [
        { key: 'agent', title: 'Agent 模块' },
        { key: 'tool', title: '工具模块' },
    ];

    return groups.map(group => {
        const groupModules = modules.filter(item => item.group === group.key);
        if (groupModules.length === 0) return '';

        return `
            <div class="llm-module-section">
                <div class="llm-module-section-header">
                    <div class="llm-module-section-title">${group.title}</div>
                </div>
                <div class="llm-module-grid">
                    ${groupModules.map(item => renderLlmModuleCard(item)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderLlmModuleCard(item) {
    const providerModels = getLlmProviderModels(item.providerId);
    const safeModuleId = Utils.escapeHtml(item.id);
    return `
        <div class="llm-module-card">
            <div class="llm-card-head">
                <div>
                    <div class="llm-card-title">${Utils.escapeHtml(item.label)}</div>
                    <div class="llm-card-subtitle">
                        当前供应商：<span id="llm-module-provider-name-${safeModuleId}">${Utils.escapeHtml(item.providerName || '未绑定')}</span>
                    </div>
                </div>
                <div class="llm-card-badges">
                    ${getLlmBindingBadge(item.bindingMode)}
                    ${getLlmAvailabilityBadge(item)}
                </div>
            </div>

            <div class="llm-card-body">
                <div class="llm-card-row">
                    <div class="llm-card-label">供应商</div>
                    <select class="select" id="llm-module-provider-${safeModuleId}" data-llm-provider-select="true" data-module-id="${safeModuleId}">
                        ${buildLlmProviderSelectOptions(item.providerId)}
                    </select>
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">模型</div>
                    <div class="llm-model-field">
                        <input
                            class="input"
                            id="llm-module-model-${safeModuleId}"
                            data-llm-model-input="true"
                            data-module-id="${safeModuleId}"
                            value="${Utils.escapeHtml(item.model || '')}"
                            autocomplete="off"
                            placeholder="输入模型，按供应商缓存即时筛选"
                        >
                        <div class="llm-model-picker" id="llm-module-model-picker-${safeModuleId}"></div>
                    </div>
                    <div class="llm-card-hint llm-model-hint" id="llm-module-model-hint-${safeModuleId}">
                        ${providerModels.length > 0
                ? `已缓存 ${providerModels.length} 个模型，输入即可筛选。`
                : '该供应商还没有缓存模型，请先在上方点击“刷新模型”。'}
                    </div>
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">当前生效 Base URL</div>
                    <div class="llm-card-value mono" id="llm-module-base-url-${safeModuleId}">${Utils.escapeHtml(item.baseUrl || '-')}</div>
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">Key 状态</div>
                    <div class="llm-card-value" id="llm-module-key-status-${safeModuleId}">
                        ${item.hasApiKey ? Utils.escapeHtml(item.apiKeyMasked || '已配置') : '未配置'}
                    </div>
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">配置来源</div>
                    <div class="llm-card-value">${Utils.escapeHtml(item.configSourceLabel || '默认回退')}</div>
                    ${item.inheritedFromMain
            ? '<div class="llm-card-hint">当前未独立配置，正在继承主 LLM 配置。</div>'
            : ''}
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">当前状态</div>
                    <div class="llm-card-value ${item.available === false ? 'llm-card-value-error' : 'llm-card-value-success'}">
                        ${item.available === false ? '不可用' : '可用'}
                    </div>
                    ${item.availabilityReason
            ? `<div class="llm-card-hint llm-card-hint-warning">${Utils.escapeHtml(item.availabilityReason)}</div>`
            : ''}
                </div>
            </div>

            <div class="llm-card-actions llm-card-actions-module">
                <div class="llm-card-actions-row">
                    <button class="btn btn-sm" data-llm-action="open-model-browser" data-module-id="${safeModuleId}">模型库</button>
                    <button class="btn btn-sm" data-llm-action="test-module" data-module-id="${safeModuleId}">测试模型</button>
                </div>
                <button class="btn btn-sm btn-primary llm-card-action-primary" data-llm-action="save-module" data-module-id="${safeModuleId}">保存配置</button>
            </div>
        </div>
    `;
}

function renderLlmProviderCards(providers) {
    if (!providers || providers.length === 0) {
        return '<div class="llm-empty-state">还没有供应商。先添加一个供应商，再给模块绑定它。</div>';
    }

    return providers.map(provider => `
        <div class="llm-provider-card">
            <div class="llm-card-head">
                <div>
                    <div class="llm-card-title">${Utils.escapeHtml(provider.name)}</div>
                    <div class="llm-card-subtitle">${provider.hasApiKey ? 'API Key 已配置' : '未配置 API Key'}</div>
                </div>
                <span class="badge ${provider.hasApiKey ? 'badge-success' : 'badge-neutral'}">
                    ${provider.hasApiKey ? 'Ready' : 'No Key'}
                </span>
            </div>

            <div class="llm-card-body">
                <div class="llm-card-row">
                    <div class="llm-card-label">Base URL</div>
                    <div class="llm-card-value mono">${Utils.escapeHtml(provider.baseUrl)}</div>
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">Key 摘要</div>
                    <div class="llm-card-value">${Utils.escapeHtml(provider.apiKeyMasked || '未配置')}</div>
                </div>

                <div class="llm-card-row">
                    <div class="llm-card-label">模型缓存</div>
                    <div class="llm-card-value">
                        ${provider.modelCount > 0 ? `已缓存 ${Utils.formatNumber(provider.modelCount)} 个模型` : '尚未刷新模型'}
                    </div>
                    <div class="llm-card-hint">
                        ${provider.modelsUpdatedAt
                ? `最近刷新：${Utils.escapeHtml(formatLlmTimestamp(provider.modelsUpdatedAt))}`
                : '刷新后会保存模型列表，供模块输入时即时筛选。'}
                    </div>
                </div>

                ${provider.models && provider.models.length > 0 ? `
                    <div class="llm-card-row">
                        <div class="llm-card-label">缓存预览</div>
                        <div class="llm-provider-preview">
                            ${provider.models.slice(0, 4).map(model => `<span class="chip">${Utils.escapeHtml(model)}</span>`).join('')}
                        </div>
                    </div>
                ` : ''}

                <div class="llm-card-row">
                    <div class="llm-card-label">已绑定模块</div>
                    <div class="llm-provider-used">
                        ${provider.usedByLabels.length > 0
            ? provider.usedByLabels.map(label => `<span class="chip">${Utils.escapeHtml(label)}</span>`).join('')
            : '<span class="llm-card-value">暂无模块绑定</span>'}
                    </div>
                </div>
            </div>

            <div class="llm-card-actions">
                <button class="btn btn-sm" data-llm-action="edit-provider" data-provider-id="${Utils.escapeHtml(provider.id)}">编辑</button>
                <button class="btn btn-sm" data-llm-action="refresh-provider-models" data-provider-id="${Utils.escapeHtml(provider.id)}">刷新模型</button>
                <button class="btn btn-sm btn-danger" data-llm-action="delete-provider" data-provider-id="${Utils.escapeHtml(provider.id)}">删除</button>
            </div>
        </div>
    `).join('');
}

function populateLlmProviderTemplates() {
    const select = document.getElementById('llm-provider-template');
    if (!select) return;

    const options = ['<option value="">自定义</option>'];
    currentLlmConfigData.templates.forEach(template => {
        options.push(`<option value="${Utils.escapeHtml(template.id)}">${Utils.escapeHtml(template.label)}</option>`);
    });
    select.innerHTML = options.join('');
}

window.openLlmProviderModal = function () {
    currentLlmProviderEditingId = '';
    document.getElementById('llm-provider-form-title').innerText = '添加供应商';
    document.getElementById('llm-provider-id').value = '';
    document.getElementById('llm-provider-name').value = '';
    document.getElementById('llm-provider-base-url').value = '';
    document.getElementById('llm-provider-api-key').value = '';
    document.getElementById('llm-provider-template').value = '';
    openModal('modal-llm-provider-form');
};

window.editLlmProvider = function (providerId) {
    const provider = currentLlmConfigData.providers.find(item => item.id === providerId);
    if (!provider) {
        alert('供应商不存在');
        return;
    }

    currentLlmProviderEditingId = providerId;
    document.getElementById('llm-provider-form-title').innerText = '编辑供应商';
    document.getElementById('llm-provider-id').value = providerId;
    document.getElementById('llm-provider-name').value = provider.name;
    document.getElementById('llm-provider-base-url').value = provider.baseUrl;
    document.getElementById('llm-provider-api-key').value = '';
    document.getElementById('llm-provider-template').value = '';
    openModal('modal-llm-provider-form');
};

window.applyLlmProviderTemplate = function () {
    const templateId = document.getElementById('llm-provider-template').value;
    if (!templateId) return;

    const template = currentLlmConfigData.templates.find(item => item.id === templateId);
    if (!template) return;

    document.getElementById('llm-provider-base-url').value = template.baseUrl;
    const nameEl = document.getElementById('llm-provider-name');
    if (nameEl && !nameEl.value.trim()) {
        nameEl.value = template.label;
    }
};

window.saveLlmProvider = async function () {
    const providerId = document.getElementById('llm-provider-id').value.trim();
    const name = document.getElementById('llm-provider-name').value.trim();
    const baseUrl = document.getElementById('llm-provider-base-url').value.trim();
    const apiKey = document.getElementById('llm-provider-api-key').value.trim();

    if (!name) return alert('供应商名称不能为空');
    if (!baseUrl) return alert('Base URL 不能为空');

    try {
        const result = providerId
            ? await API.put(`/api/config/llm/providers/${providerId}`, { name, baseUrl, apiKey })
            : await API.post('/api/config/llm/providers', { name, baseUrl, apiKey });

        if (!result.success) {
            alert('保存失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        closeModals();
        await refreshConfigAndManagedProcessState();
        alert(result.message || '供应商已保存');
    } catch (e) {
        alert('保存失败: ' + e.message);
    }
};

window.deleteLlmProvider = async function (providerId) {
    const provider = currentLlmConfigData.providers.find(item => item.id === providerId);
    if (!provider) return alert('供应商不存在');
    if (!confirm(`确定删除供应商「${provider.name}」吗？`)) return;

    try {
        const result = await API.delete(`/api/config/llm/providers/${providerId}`);
        if (!result.success) {
            alert('删除失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        await refreshConfigAndManagedProcessState();
        alert(result.message || '供应商已删除');
    } catch (e) {
        alert('删除失败: ' + e.message);
    }
};

function updateLlmModuleCardState(moduleId) {
    const providerEl = document.getElementById(`llm-module-provider-${moduleId}`);
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    const providerNameEl = document.getElementById(`llm-module-provider-name-${moduleId}`);
    const baseUrlEl = document.getElementById(`llm-module-base-url-${moduleId}`);
    const keyStatusEl = document.getElementById(`llm-module-key-status-${moduleId}`);
    const hintEl = document.getElementById(`llm-module-model-hint-${moduleId}`);

    const providerId = providerEl ? providerEl.value : '';
    const provider = getLlmProviderById(providerId);
    const query = modelEl ? modelEl.value.trim() : '';

    if (providerNameEl) {
        providerNameEl.innerText = provider ? provider.name : '未绑定';
    }

    if (baseUrlEl) {
        baseUrlEl.innerText = provider ? provider.baseUrl : '-';
    }

    if (keyStatusEl) {
        keyStatusEl.innerText = provider
            ? (provider.hasApiKey ? (provider.apiKeyMasked || '已配置') : '未配置')
            : '未配置';
    }

    if (hintEl) {
        hintEl.innerText = buildLlmModelHint(providerId, query);
    }

    renderLlmModelPicker(moduleId);
}

function openLlmModelPicker(moduleId) {
    if (llmModelPickerCloseTimer) {
        clearTimeout(llmModelPickerCloseTimer);
        llmModelPickerCloseTimer = null;
    }
    currentLlmModelPickerState = { moduleId, activeIndex: -1 };
    renderLlmModelPicker(moduleId);
}

function closeAllLlmModelPickers() {
    currentLlmModelPickerState = { moduleId: '', activeIndex: -1 };
    document.querySelectorAll('.llm-model-picker').forEach(panel => {
        panel.classList.remove('is-visible');
        panel.innerHTML = '';
    });
}

function renderLlmModelPicker(moduleId) {
    const panelEl = document.getElementById(`llm-module-model-picker-${moduleId}`);
    const providerEl = document.getElementById(`llm-module-provider-${moduleId}`);
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);

    if (!panelEl || !providerEl || !modelEl) {
        return;
    }

    if (currentLlmModelPickerState.moduleId !== moduleId) {
        panelEl.classList.remove('is-visible');
        panelEl.innerHTML = '';
        return;
    }

    const providerId = providerEl.value;
    const query = modelEl.value.trim();
    const providerModels = getLlmProviderModels(providerId);

    if (!providerId) {
        panelEl.classList.add('is-visible');
        panelEl.innerHTML = '<div class="llm-model-picker-empty">先选择供应商，再开始筛选模型。</div>';
        return;
    }

    if (providerModels.length === 0) {
        panelEl.classList.add('is-visible');
        panelEl.innerHTML = '<div class="llm-model-picker-empty">该供应商还没有缓存模型，请先在上方刷新模型。</div>';
        return;
    }

    const suggestions = getLlmModelSuggestions(providerId, query);
    const activeIndex = suggestions.length === 0
        ? -1
        : Math.min(currentLlmModelPickerState.activeIndex, suggestions.length - 1);

    currentLlmModelPickerState = { moduleId, activeIndex };

    if (suggestions.length === 0) {
        panelEl.classList.add('is-visible');
        panelEl.innerHTML = `
            <div class="llm-model-picker-head">缓存模型 ${providerModels.length} 个</div>
            <div class="llm-model-picker-empty">没有匹配模型，你也可以直接保存当前自定义模型名。</div>
        `;
        return;
    }

    panelEl.classList.add('is-visible');
    panelEl.innerHTML = `
        <div class="llm-model-picker-head">匹配 ${suggestions.length} / ${providerModels.length} 个模型</div>
        ${suggestions.map((model, index) => `
            <button
                type="button"
                class="llm-model-option ${index === activeIndex ? 'is-active' : ''}"
                data-llm-action="pick-module-model"
                data-module-id="${Utils.escapeHtml(moduleId)}"
                data-model="${Utils.escapeHtml(encodeURIComponent(model))}"
            >
                <span class="llm-model-option-name">${Utils.escapeHtml(model)}</span>
                <span class="llm-model-option-tag">${index === 0 ? '推荐' : '缓存'}</span>
            </button>
        `).join('')}
    `;
}

window.pickLlmModuleModel = function (moduleId, encodedModel) {
    const model = decodeURIComponent(encodedModel);
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    if (modelEl) {
        modelEl.value = model;
        modelEl.focus();
    }
    currentLlmModelPickerState = { moduleId, activeIndex: -1 };
    updateLlmModuleCardState(moduleId);
    closeAllLlmModelPickers();
};

function renderLlmModelBrowser(statusHint = '') {
    const providerId = currentLlmModelBrowser.providerId;
    const statusEl = document.getElementById('llm-model-browser-status');
    const listEl = document.getElementById('llm-model-browser-list');
    const queryEl = document.getElementById('llm-model-query');
    const query = queryEl ? queryEl.value.trim() : '';

    if (!providerId) {
        statusEl.innerText = '请先选择供应商。';
        listEl.innerHTML = '<div class="llm-empty-state">还没有选中供应商。</div>';
        return;
    }

    const provider = currentLlmConfigData.providers.find(item => item.id === providerId);
    const models = getLlmFilteredModels(providerId, query);
    const totalModels = provider && Array.isArray(provider.models) ? provider.models.length : 0;
    const statusParts = [];
    if (statusHint) {
        statusParts.push(statusHint);
    }

    if (!provider || totalModels === 0) {
        statusParts.push('当前还没有缓存模型，请先在上方供应商管理点击“刷新模型”。');
        statusEl.innerText = statusParts.join(' · ');
        listEl.innerHTML = '<div class="llm-empty-state">该供应商还没有缓存模型。</div>';
        return;
    }

    statusParts.push(`已缓存 ${totalModels} 个模型`);
    if (provider.modelsUpdatedAt) {
        statusParts.push(`最近刷新 ${formatLlmTimestamp(provider.modelsUpdatedAt)}`);
    }
    if (query) {
        statusParts.push(`当前匹配 ${models.length} 个`);
    }
    statusEl.innerText = statusParts.join(' · ');

    if (models.length === 0) {
        listEl.innerHTML = '<div class="llm-empty-state">没有找到匹配模型。</div>';
        return;
    }

    listEl.innerHTML = models.map(model => {
        const encodedModel = encodeURIComponent(model);
        const actionButton = currentLlmModelBrowser.moduleId
            ? `<button class="btn btn-sm btn-primary" data-llm-action="choose-browser-model" data-model="${Utils.escapeHtml(encodedModel)}">选择</button>`
            : '';

        return `
            <div class="llm-model-item">
                <div>
                    <div class="llm-model-name">${Utils.escapeHtml(model)}</div>
                    <div class="llm-model-meta">来源：${Utils.escapeHtml(provider.name)}</div>
                </div>
                ${actionButton}
            </div>
        `;
    }).join('');
}

window.handleLlmModuleProviderChange = function (moduleId) {
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    if (document.activeElement === modelEl) {
        openLlmModelPicker(moduleId);
    }
    updateLlmModuleCardState(moduleId);
};

window.handleLlmModuleModelFocus = function (moduleId) {
    openLlmModelPicker(moduleId);
    updateLlmModuleCardState(moduleId);
};

window.handleLlmModuleModelInput = function (moduleId) {
    openLlmModelPicker(moduleId);
    updateLlmModuleCardState(moduleId);
};

window.handleLlmModuleModelBlur = function () {
    if (llmModelPickerCloseTimer) {
        clearTimeout(llmModelPickerCloseTimer);
    }
    llmModelPickerCloseTimer = window.setTimeout(() => {
        closeAllLlmModelPickers();
    }, 120);
};

window.handleLlmModuleModelKeydown = function (event, moduleId) {
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    const providerEl = document.getElementById(`llm-module-provider-${moduleId}`);
    const providerId = providerEl ? providerEl.value : '';
    const query = modelEl ? modelEl.value : '';
    const suggestions = getLlmModelSuggestions(providerId, query);

    if (event.key === 'Escape') {
        closeAllLlmModelPickers();
        return;
    }

    if (suggestions.length === 0) {
        return;
    }

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        openLlmModelPicker(moduleId);
        currentLlmModelPickerState = {
            moduleId,
            activeIndex: (currentLlmModelPickerState.activeIndex + 1) % suggestions.length,
        };
        renderLlmModelPicker(moduleId);
        return;
    }

    if (event.key === 'ArrowUp') {
        event.preventDefault();
        openLlmModelPicker(moduleId);
        currentLlmModelPickerState = {
            moduleId,
            activeIndex: currentLlmModelPickerState.activeIndex <= 0
                ? suggestions.length - 1
                : currentLlmModelPickerState.activeIndex - 1,
        };
        renderLlmModelPicker(moduleId);
        return;
    }

    if (event.key === 'Enter' && currentLlmModelPickerState.moduleId === moduleId && currentLlmModelPickerState.activeIndex >= 0) {
        event.preventDefault();
        const selected = suggestions[currentLlmModelPickerState.activeIndex];
        if (selected) {
            window.pickLlmModuleModel(moduleId, encodeURIComponent(selected));
        }
    }
};

document.addEventListener('click', (event) => {
    if (!event.target.closest('.llm-model-field')) {
        closeAllLlmModelPickers();
    }
});

window.inspectLlmProviderModels = function (providerId, statusHint = '') {
    currentLlmModelBrowser = { moduleId: '', providerId, mode: 'provider', statusHint };
    const provider = currentLlmConfigData.providers.find(item => item.id === providerId);
    document.getElementById('llm-model-browser-title').innerText = provider
        ? `模型缓存 · ${provider.name}`
        : '模型缓存';
    document.getElementById('llm-model-query').value = '';
    openModal('modal-llm-model-browser');
    renderLlmModelBrowser(statusHint);
};

window.refreshLlmProviderModels = async function (providerId) {
    const provider = getLlmProviderById(providerId);
    if (!provider) {
        alert('供应商不存在');
        return;
    }

    try {
        const result = await API.post(`/api/config/llm/providers/${providerId}/models/refresh`, {});
        if (!result.success) {
            alert('刷新失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        await refreshConfigAndManagedProcessState();
        window.inspectLlmProviderModels(providerId, result.message || '模型已刷新并保存');
    } catch (e) {
        alert('刷新失败: ' + e.message);
    }
};

window.openLlmModelBrowser = function (moduleId) {
    const providerEl = document.getElementById(`llm-module-provider-${moduleId}`);
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    const providerId = providerEl ? providerEl.value : '';

    if (!providerId) {
        alert('请先为模块选择供应商');
        return;
    }

    currentLlmModelBrowser = { moduleId, providerId, mode: 'module', statusHint: '' };
    const module = currentLlmConfigData.modules.find(item => item.id === moduleId);
    const provider = currentLlmConfigData.providers.find(item => item.id === providerId);
    document.getElementById('llm-model-browser-title').innerText = module && provider
        ? `模型库 · ${module.label} / ${provider.name}`
        : '模型库';
    document.getElementById('llm-model-query').value = modelEl ? modelEl.value.trim() : '';
    openModal('modal-llm-model-browser');
    renderLlmModelBrowser();
};

window.searchLlmModels = function () {
    renderLlmModelBrowser(currentLlmModelBrowser.statusHint);
};

window.chooseLlmModel = function (encodedModel) {
    const model = decodeURIComponent(encodedModel);
    if (!currentLlmModelBrowser.moduleId) return;

    const modelEl = document.getElementById(`llm-module-model-${currentLlmModelBrowser.moduleId}`);
    if (modelEl) {
        modelEl.value = model;
    }
    updateLlmModuleCardState(currentLlmModelBrowser.moduleId);
    closeModals();
};

window.saveLlmModule = async function (moduleId) {
    const providerEl = document.getElementById(`llm-module-provider-${moduleId}`);
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    const providerId = providerEl ? providerEl.value : '';
    const model = modelEl ? modelEl.value.trim() : '';

    if (!providerId) return alert('请先选择供应商');
    if (!model) return alert('模型不能为空');

    try {
        const result = await API.put(`/api/config/llm/modules/${moduleId}`, { providerId, model });
        if (!result.success) {
            alert('保存失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        await refreshConfigAndManagedProcessState();
        alert(result.message || '模块配置已保存');
    } catch (e) {
        alert('保存失败: ' + e.message);
    }
};

window.testLlmModule = async function (moduleId) {
    const providerEl = document.getElementById(`llm-module-provider-${moduleId}`);
    const modelEl = document.getElementById(`llm-module-model-${moduleId}`);
    const providerId = providerEl ? providerEl.value : '';
    const model = modelEl ? modelEl.value.trim() : '';

    if (!providerId) return alert('请先选择供应商');
    if (!model) return alert('请先填写模型');

    try {
        const result = await API.post(`/api/config/llm/modules/${moduleId}/test`, { providerId, model });
        if (!result.success) {
            alert('测试失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        const preview = result.preview ? `\n响应预览: ${result.preview}` : '';
        alert(`测试成功\n供应商: ${result.provider.name}\n模型: ${result.model}\n耗时: ${result.latencyMs}ms${preview}`);
    } catch (e) {
        alert('测试失败: ' + e.message);
    }
};

function setRuntimeInputValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;

    if (el.type === 'checkbox') {
        el.checked = Boolean(value);
        return;
    }

    if (Array.isArray(value)) {
        el.value = value.join('\n');
        return;
    }

    el.value = value ?? '';
}

function renderRuntimeSettingsSubtitle(runtimeMeta) {
    const subtitleEl = document.getElementById('runtime-settings-subtitle');
    if (!subtitleEl) return;

    if ((runtimeMeta?.processRole || 'agent') === 'web') {
        subtitleEl.innerText = '当前页运行在 web-only 模式：保存会先写入已保存配置，再尝试重启对应进程同步。';
        return;
    }

    subtitleEl.innerText = '当前页直连 agent 进程：agent 侧配置可即时生效，适配器配置仍会写入已保存配置并尝试同步。';
}

function detectAutoMemePreset(probability) {
    if (!Number.isFinite(probability)) {
        return 'custom';
    }

    for (const [presetId, preset] of Object.entries(AUTO_MEME_PRESETS)) {
        if (Math.abs(probability - preset.value) < 0.0001) {
            return presetId;
        }
    }

    return 'custom';
}

function formatAutoMemeProbability(probability) {
    if (!Number.isFinite(probability)) {
        return '0.24';
    }
    return probability.toFixed(2).replace(/\.?0+$/, (match) => match === '.00' ? '' : match);
}

window.syncAutoMemeProbabilityState = function () {
    const inputEl = document.getElementById('runtime-auto-meme-probability');
    const presetEl = document.getElementById('runtime-auto-meme-preset');
    const helpEl = document.getElementById('runtime-auto-meme-probability-help');
    if (!inputEl || !presetEl || !helpEl) return;

    const probability = Number(String(inputEl.value || '').trim());
    if (!Number.isFinite(probability)) {
        presetEl.value = 'custom';
        helpEl.innerText = '请输入 0 到 1 之间的小数，例如 0.24。';
        return;
    }

    const presetId = detectAutoMemePreset(probability);
    presetEl.value = presetId;
    const tone = presetId === 'custom'
        ? `当前为自定义档（${formatAutoMemeProbability(probability)}）`
        : `当前为${AUTO_MEME_PRESETS[presetId].label}档（${formatAutoMemeProbability(probability)}）`;
    helpEl.innerText = `${tone}，按场景基础概率线性放大或缩小。`;
};

window.handleAutoMemePresetChange = function () {
    const presetEl = document.getElementById('runtime-auto-meme-preset');
    const inputEl = document.getElementById('runtime-auto-meme-probability');
    if (!presetEl || !inputEl) return;

    const presetId = String(presetEl.value || 'balanced');
    if (presetId !== 'custom' && AUTO_MEME_PRESETS[presetId]) {
        inputEl.value = AUTO_MEME_PRESETS[presetId].value.toFixed(2);
    }
    window.syncAutoMemeProbabilityState();
};

window.applyAutoMemePreset = function (presetId) {
    const preset = AUTO_MEME_PRESETS[presetId];
    const presetEl = document.getElementById('runtime-auto-meme-preset');
    const inputEl = document.getElementById('runtime-auto-meme-probability');
    if (!preset || !presetEl || !inputEl) return;

    presetEl.value = presetId;
    inputEl.value = preset.value.toFixed(2);
    window.syncAutoMemeProbabilityState();
};

function setMemeRuntimeSaving(isSaving) {
    const saveBtn = document.getElementById('btn-save-meme-runtime');
    if (!saveBtn) return;

    saveBtn.disabled = isSaving;
    saveBtn.textContent = isSaving ? '⏳ 保存中...' : '💾 保存并生效';
}

function populateMemeRuntimeForm(configData) {
    const autoMeme = configData?.autoMeme || {};
    const enabled = autoMeme.enabled ?? configData?.settings?.autoMemeEnabled ?? false;
    const probability = Number(autoMeme.probability ?? configData?.settings?.autoMemeProbability ?? 0.24);
    setRuntimeInputValue('meme-runtime-enabled', enabled);
    setRuntimeInputValue('meme-runtime-probability', probability);
    setRuntimeInputValue('meme-runtime-preset', detectAutoMemePreset(probability));
    setRuntimeInputValue('meme-runtime-session-cooldown', autoMeme.perSessionCooldownMs ?? 90000);
    setRuntimeInputValue('meme-runtime-user-cooldown', autoMeme.perUserCooldownMs ?? 120000);
    setRuntimeInputValue('meme-runtime-disable-private', autoMeme.disableInPrivate ?? false);
    setRuntimeInputValue('meme-runtime-disable-tool-media', autoMeme.disableWhenToolSentMedia ?? true);
    setRuntimeInputValue('meme-runtime-max-recent-session', autoMeme.maxRecentPerSession ?? 6);
    setRuntimeInputValue('meme-runtime-max-recent-pack', autoMeme.maxRecentPerPackPerSession ?? 3);
    window.syncMemePanelProbabilityState();
}

window.syncMemePanelProbabilityState = function () {
    const inputEl = document.getElementById('meme-runtime-probability');
    const presetEl = document.getElementById('meme-runtime-preset');
    const statusEl = document.getElementById('meme-runtime-status');
    const enabledEl = document.getElementById('meme-runtime-enabled');
    const disablePrivateEl = document.getElementById('meme-runtime-disable-private');
    const disableToolMediaEl = document.getElementById('meme-runtime-disable-tool-media');
    const sessionCooldownEl = document.getElementById('meme-runtime-session-cooldown');
    const userCooldownEl = document.getElementById('meme-runtime-user-cooldown');
    if (!inputEl || !presetEl || !statusEl || !enabledEl || !disablePrivateEl || !disableToolMediaEl || !sessionCooldownEl || !userCooldownEl) return;

    const probability = Number(String(inputEl.value || '').trim());
    const enabled = Boolean(enabledEl.checked);
    const sessionCooldown = Number(String(sessionCooldownEl.value || '').trim() || '0');
    const userCooldown = Number(String(userCooldownEl.value || '').trim() || '0');
    const privateRule = disablePrivateEl.checked ? '私聊禁用' : '私聊可用';
    const mediaRule = disableToolMediaEl.checked ? '已有媒体就跳过' : '已有媒体也允许追加';
    if (!Number.isFinite(probability)) {
        presetEl.value = 'custom';
        statusEl.textContent = enabled
            ? '自动发表情已开启，但当前概率值无效，请输入 0 到 1 之间的小数。'
            : '自动发表情已关闭。即使填写了概率，保存前也不会生效。';
        return;
    }

    const presetId = detectAutoMemePreset(probability);
    presetEl.value = presetId;
    const label = presetId === 'custom'
        ? `自定义档 ${formatAutoMemeProbability(probability)}`
        : `${AUTO_MEME_PRESETS[presetId].label}档 ${formatAutoMemeProbability(probability)}`;
    statusEl.textContent = enabled
        ? `当前已开启，使用${label}；会话冷却 ${sessionCooldown}ms，用户冷却 ${userCooldown}ms，${privateRule}，${mediaRule}。`
        : `当前已关闭；保存后会保留${label}、会话冷却 ${sessionCooldown}ms、用户冷却 ${userCooldown}ms 作为下次启用时的规则。`;
};

window.handleMemePanelPresetChange = function () {
    const presetEl = document.getElementById('meme-runtime-preset');
    const inputEl = document.getElementById('meme-runtime-probability');
    if (!presetEl || !inputEl) return;

    const presetId = String(presetEl.value || 'balanced');
    if (presetId !== 'custom' && AUTO_MEME_PRESETS[presetId]) {
        inputEl.value = AUTO_MEME_PRESETS[presetId].value.toFixed(2);
    }
    window.syncMemePanelProbabilityState();
};

window.applyMemePanelPreset = function (presetId) {
    const preset = AUTO_MEME_PRESETS[presetId];
    const presetEl = document.getElementById('meme-runtime-preset');
    const inputEl = document.getElementById('meme-runtime-probability');
    if (!preset || !presetEl || !inputEl) return;

    presetEl.value = presetId;
    inputEl.value = preset.value.toFixed(2);
    window.syncMemePanelProbabilityState();
};

window.saveMemeRuntimeSettings = async function () {
    const saveBtn = document.getElementById('btn-save-meme-runtime');
    if (saveBtn?.disabled) {
        return;
    }

    setMemeRuntimeSaving(true);
    try {
        const payload = {
            autoMemeEnabled: Boolean(document.getElementById('meme-runtime-enabled')?.checked),
            autoMemeProbability: getRuntimeFloatValue('meme-runtime-probability', '自动表情包概率', 0, 1),
            autoMemePerSessionCooldownMs: getRuntimeNumberValue('meme-runtime-session-cooldown', '会话冷却'),
            autoMemePerUserCooldownMs: getRuntimeNumberValue('meme-runtime-user-cooldown', '用户冷却'),
            autoMemeDisableInPrivate: Boolean(document.getElementById('meme-runtime-disable-private')?.checked),
            autoMemeDisableWhenToolSentMedia: Boolean(document.getElementById('meme-runtime-disable-tool-media')?.checked),
            autoMemeMaxRecentPerSession: getRuntimeNumberValue('meme-runtime-max-recent-session', '会话去重窗口'),
            autoMemeMaxRecentPerPackPerSession: getRuntimeNumberValue('meme-runtime-max-recent-pack', '单分组去重窗口'),
        };
        const result = await API.put('/api/config/runtime', payload);
        if (!result.success) {
            alert('保存失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        populateMemeRuntimeForm(result.config || {});
        alert(result.message || '自动表情包设置已保存');
    } catch (e) {
        alert('保存失败: ' + e.message);
    } finally {
        setMemeRuntimeSaving(false);
    }
};

window.applyMemePanelPresetAndSave = async function (presetId) {
    window.applyMemePanelPreset(presetId);
    await window.saveMemeRuntimeSettings();
};

function getRuntimeNumberValue(id, label) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`缺少字段: ${label}`);
    }

    const raw = String(el.value || '').trim();
    if (!raw) {
        throw new Error(`${label} 不能为空`);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} 必须是整数`);
    }

    return parsed;
}

function getRuntimeFloatValue(id, label, minimum = 0, maximum = 1) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`缺少字段: ${label}`);
    }

    const raw = String(el.value || '').trim();
    if (!raw) {
        throw new Error(`${label} 不能为空`);
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${label} 必须是数字`);
    }
    if (parsed < minimum || parsed > maximum) {
        throw new Error(`${label} 必须在 ${minimum} ~ ${maximum} 范围内`);
    }

    return Number(parsed.toFixed(4));
}

function getRuntimeStringValue(id, label) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`缺少字段: ${label}`);
    }

    const raw = String(el.value || '').trim();
    if (!raw) {
        throw new Error(`${label} 不能为空`);
    }

    return raw;
}

function getRuntimeToolListValue(id) {
    const el = document.getElementById(id);
    if (!el) return [];

    return String(el.value || '')
        .split(/[\n,，]+/)
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function populateRuntimeSettingsForm(d) {
    const selfMaintainer = d.selfMaintainer || {};
    const adapter = d.adapter || {};
    const autoMeme = d.autoMeme || {};
    setRuntimeInputValue('runtime-napcat-ws-url', d.napcatWsUrl ?? '');
    setRuntimeInputValue('runtime-adapter-mode', adapter.mode ?? 'reverse');
    setRuntimeInputValue('runtime-adapter-napcat-ws-url', adapter.napcatWsUrl ?? '');
    setRuntimeInputValue('runtime-adapter-access-token', '');
    setRuntimeInputValue('runtime-adapter-clear-access-token', false);
    setRuntimeInputValue('runtime-adapter-owner-qq', adapter.ownerQq ?? '');
    setRuntimeInputValue('runtime-adapter-owner-notify-text', adapter.ownerNotifyText ?? '');
    setRuntimeInputValue('runtime-adapter-reverse-host', adapter.reverseHost ?? '');
    setRuntimeInputValue('runtime-adapter-reverse-port', adapter.reversePort ?? '');
    setRuntimeInputValue('runtime-adapter-reverse-path', adapter.reversePath ?? '');
    setRuntimeInputValue('runtime-adapter-enable-stream', adapter.enableStream ?? false);
    setRuntimeInputValue('runtime-adapter-stream-host', adapter.streamHost ?? '');
    setRuntimeInputValue('runtime-adapter-stream-port', adapter.streamPort ?? '');
    setRuntimeInputValue('runtime-debounce-delay', d.settings?.debounceDelayMs ?? '');
    setRuntimeInputValue('runtime-memory-window-size', d.settings?.memoryWindowSize ?? '');
    setRuntimeInputValue('runtime-llm-strict-isolation', d.settings?.llmStrictIsolation ?? false);
    setRuntimeInputValue('runtime-show-reasoning-chain', d.settings?.showReasoningChain ?? false);
    setRuntimeInputValue('runtime-auto-meme-enabled', autoMeme.enabled ?? d.settings?.autoMemeEnabled ?? false);
    setRuntimeInputValue('runtime-auto-meme-probability', autoMeme.probability ?? d.settings?.autoMemeProbability ?? 0.24);
    setRuntimeInputValue('runtime-auto-meme-preset', detectAutoMemePreset(Number(autoMeme.probability ?? d.settings?.autoMemeProbability ?? 0.24)));
    setRuntimeInputValue('runtime-self-maintainer-enabled', d.settings?.selfMaintainerEnabled ?? false);
    setRuntimeInputValue('runtime-self-maintainer-interval', selfMaintainer.intervalMs ?? '');
    setRuntimeInputValue('runtime-self-maintainer-window', selfMaintainer.failureWindowMs ?? '');
    setRuntimeInputValue('runtime-self-maintainer-min-failures', selfMaintainer.minFailures ?? '');
    setRuntimeInputValue('runtime-self-maintainer-cooldown', selfMaintainer.cooldownMs ?? '');
    setRuntimeInputValue('runtime-self-maintainer-max-tools', selfMaintainer.maxToolsPerRun ?? '');
    setRuntimeInputValue('runtime-self-maintainer-allowed-tools', selfMaintainer.allowedTools ?? []);
    setRuntimeInputValue('runtime-self-maintainer-blocked-tools', selfMaintainer.blockedTools ?? []);

    const accessTokenInput = document.getElementById('runtime-adapter-access-token');
    if (accessTokenInput) {
        accessTokenInput.placeholder = adapter.accessTokenConfigured
            ? `已配置 (${adapter.accessTokenPreview || '已隐藏'})，留空则不修改`
            : '未配置，输入后保存';
    }

    window.toggleRuntimeSettingsState();
    window.toggleRuntimeAdapterState();
    window.syncAutoMemeProbabilityState();
}

window.toggleRuntimeSettingsState = function () {
    const enabledEl = document.getElementById('runtime-self-maintainer-enabled');
    const enabled = enabledEl ? enabledEl.checked : false;

    document.querySelectorAll('[data-self-maintainer-field]').forEach(el => {
        el.disabled = !enabled;
    });
};

window.toggleRuntimeAdapterState = function () {
    const adapterMode = String(document.getElementById('runtime-adapter-mode')?.value || 'reverse').trim().toLowerCase();
    const streamEnabled = Boolean(document.getElementById('runtime-adapter-enable-stream')?.checked);

    document.querySelectorAll('[data-adapter-mode-field]').forEach((el) => {
        const targetMode = String(el.getAttribute('data-adapter-mode-field') || '').trim().toLowerCase();
        el.disabled = targetMode !== adapterMode;
    });

    document.querySelectorAll('[data-adapter-mode-help]').forEach((el) => {
        const targetMode = String(el.getAttribute('data-adapter-mode-help') || '').trim().toLowerCase();
        el.style.display = targetMode === adapterMode ? '' : 'none';
    });

    document.querySelectorAll('[data-adapter-stream-field]').forEach((el) => {
        el.disabled = !streamEnabled;
    });
};

function setRuntimeSettingsSaving(isSaving) {
    const saveBtn = document.getElementById('btn-save-runtime-settings');
    if (!saveBtn) return;

    saveBtn.disabled = isSaving;
    saveBtn.textContent = isSaving ? '⏳ 保存中...' : '💾 保存设置';
}

window.saveRuntimeSettings = async function () {
    const saveBtn = document.getElementById('btn-save-runtime-settings');
    if (saveBtn?.disabled) {
        return;
    }

    setRuntimeSettingsSaving(true);
    try {
        const enabledEl = document.getElementById('runtime-self-maintainer-enabled');
        const adapterAccessToken = String(document.getElementById('runtime-adapter-access-token')?.value || '').trim();
        const adapterClearAccessToken = Boolean(document.getElementById('runtime-adapter-clear-access-token')?.checked);
        const adapterMode = String(document.getElementById('runtime-adapter-mode')?.value || '').trim().toLowerCase();
        const adapterEnableStream = Boolean(document.getElementById('runtime-adapter-enable-stream')?.checked);
        if (adapterAccessToken && adapterClearAccessToken) {
            throw new Error('不能同时输入新的访问令牌并勾选清空访问令牌');
        }
        const payload = {
            napcatWsUrl: String(document.getElementById('runtime-napcat-ws-url')?.value || '').trim(),
            adapterMode,
            adapterAccessToken: adapterAccessToken || undefined,
            adapterClearAccessToken: adapterClearAccessToken || undefined,
            adapterOwnerQq: String(document.getElementById('runtime-adapter-owner-qq')?.value || '').trim(),
            adapterOwnerNotifyText: String(document.getElementById('runtime-adapter-owner-notify-text')?.value || '').trim(),
            adapterEnableStream,
            debounceDelayMs: getRuntimeNumberValue('runtime-debounce-delay', '防抖延迟'),
            memoryWindowSize: getRuntimeNumberValue('runtime-memory-window-size', '记忆窗口大小'),
            llmStrictIsolation: Boolean(document.getElementById('runtime-llm-strict-isolation')?.checked),
            showReasoningChain: Boolean(document.getElementById('runtime-show-reasoning-chain')?.checked),
            autoMemeEnabled: Boolean(document.getElementById('runtime-auto-meme-enabled')?.checked),
            autoMemeProbability: getRuntimeFloatValue('runtime-auto-meme-probability', '自动表情包概率', 0, 1),
            selfMaintainerEnabled: enabledEl ? enabledEl.checked : false,
        };
        if (adapterMode === 'forward') {
            payload.adapterNapcatWsUrl = getRuntimeStringValue('runtime-adapter-napcat-ws-url', '上游 NapCat 地址');
        } else {
            payload.adapterReverseHost = getRuntimeStringValue('runtime-adapter-reverse-host', '适配器反向监听地址');
            payload.adapterReversePort = getRuntimeNumberValue('runtime-adapter-reverse-port', '适配器反向监听端口');
            payload.adapterReversePath = getRuntimeStringValue('runtime-adapter-reverse-path', '适配器反向路径');
        }
        if (adapterEnableStream) {
            payload.adapterStreamHost = getRuntimeStringValue('runtime-adapter-stream-host', '适配器消息流监听地址');
            payload.adapterStreamPort = getRuntimeNumberValue('runtime-adapter-stream-port', '适配器消息流端口');
        }
        if (payload.selfMaintainerEnabled) {
            payload.selfMaintainerIntervalMs = getRuntimeNumberValue('runtime-self-maintainer-interval', '巡检间隔');
            payload.selfMaintainerFailureWindowMs = getRuntimeNumberValue('runtime-self-maintainer-window', '失败窗口');
            payload.selfMaintainerMinFailures = getRuntimeNumberValue('runtime-self-maintainer-min-failures', '最少失败次数');
            payload.selfMaintainerCooldownMs = getRuntimeNumberValue('runtime-self-maintainer-cooldown', '冷却时间');
            payload.selfMaintainerMaxToolsPerRun = getRuntimeNumberValue('runtime-self-maintainer-max-tools', '单轮最多维护工具数');
            payload.selfMaintainerAllowedTools = getRuntimeToolListValue('runtime-self-maintainer-allowed-tools');
            payload.selfMaintainerBlockedTools = getRuntimeToolListValue('runtime-self-maintainer-blocked-tools');
        }

        const result = await API.put('/api/config/runtime', payload);
        if (!result.success) {
            alert('保存失败: ' + (result.error || result.message || '未知错误'));
            return;
        }

        await refreshConfigAndManagedProcessState();
        alert(result.message || '运行时配置已保存');
    } catch (e) {
        alert('保存失败: ' + e.message);
    } finally {
        setRuntimeSettingsSaving(false);
    }
};

async function loadConfig() {
    try {
        const d = await API.get('/api/config');
        currentLlmConfigData = d.llm || { modules: [], providers: [], templates: [] };
        closeAllLlmModelPickers();
        populateLlmProviderTemplates();
        renderRuntimeSettingsSubtitle(d.runtimeMeta);
        renderRuntimeHealthSummary(d.runtimeHealth, d.runtimeMeta);
        if (d.runtimeHealth?.agent) {
            applyAgentProcessState(d.runtimeHealth.agent);
        }
        if (d.runtimeHealth?.adapter) {
            applyAdapterProcessState(d.runtimeHealth.adapter);
        }

        // 机器人信息 (Hero 区域)
        const botQQ = d.botQQ || '未知';
        document.getElementById('dash-bot-qq-hero').innerText = botQQ;
        document.getElementById('dash-admin-hero').innerText = d.adminQQ?.join(', ') || '无';

        // 获取 Bot 详细信息（昵称、头像）
        try {
            const bot = await API.get('/api/bot');

            // 更新 Bot 名称
            const botNameEl = document.getElementById('dash-bot-name');
            if (botNameEl && bot.nickname) {
                botNameEl.innerText = `${bot.nickname} Bot`;
            }

            // 更新头像
            const avatarEl = document.getElementById('dash-bot-avatar');
            if (avatarEl && bot.avatar) {
                avatarEl.src = bot.avatar;
            }
        } catch (e) {
            console.warn('获取 Bot 信息失败', e);
        }

        const llmModuleGroups = document.getElementById('llm-module-groups');
        if (llmModuleGroups) {
            llmModuleGroups.innerHTML = currentLlmConfigData.modules.length > 0
                ? renderLlmModuleGroups(currentLlmConfigData.modules)
                : '<div class="llm-empty-state">还没有可配置的 LLM 模块。</div>';
            currentLlmConfigData.modules.forEach(item => updateLlmModuleCardState(item.id));
        }

        const llmProviderGrid = document.getElementById('llm-provider-grid');
        if (llmProviderGrid) {
            llmProviderGrid.innerHTML = renderLlmProviderCards(currentLlmConfigData.providers);
        }

        // Settings Grid (Config 页面用)
        const settingsGrid = document.getElementById('grid-settings');
        if (settingsGrid) {
            settingsGrid.innerHTML = Object.entries(d.settings).map(([k, v]) => `
                <div style="background:var(--bg-body);padding:12px;border-radius:6px;border:1px solid var(--border);">
                    <div style="font-size:12px;color:var(--text-sub);">${Utils.escapeHtml(String(k))}</div>
                    <div style="font-size:14px;font-weight:600;margin-top:4px;">${Utils.escapeHtml(String(v))}</div>
                </div>
            `).join('');
        }

        populateRuntimeSettingsForm(d);

        // 统计工具数（启用/总数）
        // tools 格式是 { likeEnabled: true, profileEnabled: true, ... }
        if (d.tools) {
            const toolValues = Object.values(d.tools);
            const enabledTools = toolValues.filter(v => v === true).length;
            const totalTools = toolValues.length;
            document.getElementById('dash-stat-tools').innerText = `${enabledTools}/${totalTools}`;
        }

    } catch (e) { console.error('Load config failed', e); }
}

// Dashboard - 加载统计数据
async function loadDashboardStats() {
    try {
        // 活跃会话数
        const sessions = await API.get('/api/context');
        document.getElementById('dash-stat-sessions').innerText = Array.isArray(sessions) ? sessions.length : 0;
    } catch (e) {
        document.getElementById('dash-stat-sessions').innerText = '0';
    }

    try {
        // 用户画像数
        const profiles = await API.get('/api/profiles');
        document.getElementById('dash-stat-profiles').innerText = Array.isArray(profiles) ? profiles.length : 0;
    } catch (e) {
        document.getElementById('dash-stat-profiles').innerText = '0';
    }

    try {
        // 知识条目数
        const knowledge = await API.get('/api/knowledge');
        document.getElementById('dash-stat-knowledge').innerText = Array.isArray(knowledge) ? knowledge.length : 0;
    } catch (e) {
        document.getElementById('dash-stat-knowledge').innerText = '0';
    }
}

// Global variable to store current logs for modal access
let currentToolLogs = [];

// Tools & Agents
async function loadTools() {
    const grid = document.getElementById('grid-tools');
    try {
        const d = await API.get('/api/tools');
        if (grid) {
            grid.innerHTML = Object.entries(d).map(([k, v]) => renderSwitchCard(k, v, 'tools')).join('');
            bindToggleGridActions(grid);
        }
        await loadToolLogs();
    } catch (e) {
        console.error('Load tools failed', e);
        if (grid) {
            grid.innerHTML = '<div class="llm-empty-state">工具配置加载失败，请稍后重试。</div>';
        }
    }
}

// Currently selected tool for testing
let currentTestTool = null;
let currentTestSchema = null;

// Tool Test: Open modal for specific tool
window.openToolTest = async function (toolName, icon, displayName) {
    currentTestTool = toolName;
    currentTestSchema = null;

    // Update modal header
    document.getElementById('test-tool-name').textContent = `${icon} ${displayName} (${toolName})`;

    // Clear previous data
    const formEl = document.getElementById('test-tool-params-form');
    const requestEl = document.getElementById('test-request');
    const responseEl = document.getElementById('test-response');
    const durationEl = document.getElementById('test-duration');

    formEl.innerHTML = '<div class="empty-params">加载参数中...</div>';
    requestEl.textContent = '';
    responseEl.textContent = '';
    responseEl.style.borderColor = '';
    durationEl.textContent = '';

    // 媒体工具特殊处理：直接显示路径和问题输入
    const mediaTools = {
        'vision': { pathKey: 'imagePath', pathLabel: '图片路径', pathPlaceholder: 'C:/path/to/image.jpg 或 https://...' },
        'read_audio': { pathKey: 'audioPath', pathLabel: '音频路径', pathPlaceholder: 'C:/path/to/audio.mp3 或 https://...' },
        'read_video': { pathKey: 'videoPath', pathLabel: '视频路径', pathPlaceholder: 'C:/path/to/video.mp4 或 https://...' },
    };

    if (mediaTools[toolName]) {
        const { pathKey, pathLabel, pathPlaceholder } = mediaTools[toolName];
        formEl.innerHTML = `
            <div class="tool-param-field">
                <div class="tool-param-label">
                    <span class="param-name">${pathKey}</span>
                    <span class="param-type">string</span>
                    <span class="param-required">必填</span>
                </div>
                <div class="tool-param-desc">${pathLabel}（本地文件路径或URL）</div>
                <textarea class="tool-param-input tool-param-textarea" id="param-${pathKey}" data-type="string" placeholder="${pathPlaceholder}" rows="3"></textarea>
            </div>
            <div class="tool-param-field">
                <div class="tool-param-label">
                    <span class="param-name">question</span>
                    <span class="param-type">string</span>
                    <span class="param-required">必填</span>
                </div>
                <div class="tool-param-desc">要问的问题</div>
                <textarea class="tool-param-input tool-param-textarea" id="param-question" data-type="string" placeholder="描述一下这个内容" rows="2"></textarea>
            </div>`;

        // Clear JSON textarea and open modal
        document.getElementById('test-tool-params-json').value = '{}';
        switchParamTab('form');
        openModal('modal-tool-test');
        return;
    }

    // Fetch schema for selected tool
    try {
        const schema = await API.get(`/api/tools/${toolName}/schema`);
        if (schema && schema.schema && schema.schema.parameters) {
            currentTestSchema = schema.schema.parameters;
            const props = schema.schema.parameters.properties || {};
            const required = schema.schema.parameters.required || [];

            if (Object.keys(props).length === 0) {
                formEl.innerHTML = '<div class="empty-params">该工具无需参数</div>';
            } else {
                // Generate form fields
                let formHtml = '';
                for (const [key, prop] of Object.entries(props)) {
                    const isRequired = required.includes(key);
                    const typeLabel = prop.type || 'string';
                    const desc = prop.description || '';

                    let inputHtml = '';
                    if (prop.type === 'boolean') {
                        inputHtml = `
                            <select class="tool-param-input" id="param-${key}" data-type="boolean">
                                <option value="true">true</option>
                                <option value="false">false</option>
                            </select>`;
                    } else if (prop.type === 'number' || prop.type === 'integer') {
                        inputHtml = `<input type="number" class="tool-param-input" id="param-${key}" data-type="${prop.type}" placeholder="输入数值">`;
                    } else {
                        // Use textarea for string fields to allow multi-line and better visibility
                        inputHtml = `<textarea class="tool-param-input tool-param-textarea" id="param-${key}" data-type="string" placeholder="${Utils.escapeHtml(desc.slice(0, 50))}" rows="2"></textarea>`;
                    }

                    formHtml += `
                        <div class="tool-param-field">
                            <div class="tool-param-label">
                                <span class="param-name">${key}</span>
                                <span class="param-type">${typeLabel}</span>
                                ${isRequired ? '<span class="param-required">必填</span>' : ''}
                            </div>
                            ${desc ? `<div class="tool-param-desc">${Utils.escapeHtml(desc)}</div>` : ''}
                            ${inputHtml}
                        </div>`;
                }
                formEl.innerHTML = formHtml;
            }
        } else {
            formEl.innerHTML = '<div class="empty-params">该工具无需参数</div>';
        }
    } catch (e) {
        console.warn('Failed to fetch tool schema:', e);
        formEl.innerHTML = '<div class="empty-params">加载参数失败</div>';
    }

    // Clear JSON textarea
    document.getElementById('test-tool-params-json').value = '{}';

    // Reset to form tab
    switchParamTab('form');

    // Open modal
    openModal('modal-tool-test');
};

// Current tab mode
let currentParamTab = 'form';

// Tab switching
window.switchParamTab = function (tab) {
    currentParamTab = tab;
    const formEl = document.getElementById('test-tool-params-form');
    const jsonEl = document.getElementById('test-tool-params-json');
    const tabs = document.querySelectorAll('.tab-btn');

    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

    if (tab === 'form') {
        formEl.style.display = 'block';
        jsonEl.style.display = 'none';
        // Sync JSON -> Form (parse JSON and fill form)
        const jsonData = Utils.safeParseJson(jsonEl.value || '{}', {});
        if (jsonData && typeof jsonData === 'object' && !Array.isArray(jsonData)) {
            Object.keys(jsonData).forEach(key => {
                const input = document.getElementById(`param-${key}`);
                if (input) {
                    input.value = jsonData[key];
                }
            });
        }
    } else {
        formEl.style.display = 'none';
        jsonEl.style.display = 'block';
        // Sync Form -> JSON
        const params = collectFormParams();
        jsonEl.value = JSON.stringify(params, null, 2);
    }
};

// Tool Test: Collect form values
function collectFormParams() {
    const params = {};
    const formEl = document.getElementById('test-tool-params-form');
    const inputs = formEl.querySelectorAll('.tool-param-input');

    inputs.forEach(input => {
        const key = input.id.replace('param-', '');
        const type = input.dataset.type;
        let value = input.value.trim();

        if (value === '') return; // Skip empty values

        if (type === 'boolean') {
            params[key] = value === 'true';
        } else if (type === 'number' || type === 'integer') {
            params[key] = Number(value);
        } else {
            params[key] = value;
        }
    });

    return params;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeToolTestResult(result) {
    const response = result?.response || {};
    const queueMeta = result?.queued
        ? {
            completed: Boolean(result.completed),
            requestId: result.requestId || '',
            message: result.message || '',
        }
        : null;

    return {
        ...result,
        response,
        queueMeta,
        responsePayload: queueMeta
            ? {
                ...response,
                _queue: {
                    completed: queueMeta.completed,
                    requestId: queueMeta.requestId,
                    message: queueMeta.message,
                },
            }
            : response,
    };
}

async function renderToolTestResult(result, elements) {
    const { responseEl, durationEl, replyEl } = elements;
    const normalized = normalizeToolTestResult(result);
    const { response, responsePayload, queueMeta } = normalized;
    const replyText = response.text || '';
    const queueHint = queueMeta
        ? `${queueMeta.completed ? '已完成' : '排队中'}${queueMeta.requestId ? ` | 请求ID: ${queueMeta.requestId}` : ''}`
        : '';
    const isPending = Boolean(queueMeta && !queueMeta.completed);
    const isSuccess = Boolean(normalized.success && response.success);

    responseEl.textContent = JSON.stringify(responsePayload, null, 2);
    durationEl.textContent = `⏱️ ${normalized.duration || 0}ms${isPending ? ' · 等待 genesis-agent 完成' : ''}`;

    if (isPending) {
        const lines = [queueMeta.message || '工具测试请求已提交给 genesis-agent，仍在执行中'];
        if (queueHint) {
            lines.push(queueHint);
        }
        replyEl.innerHTML = Utils.escapeHtml(lines.join('\n')).replace(/\n/g, '<br>');
        replyEl.className = 'reply-preview empty';
        responseEl.style.borderColor = '#d29922';
        return normalized;
    }

    if (!replyText) {
        const emptyLines = ['（无回复内容）'];
        if (queueHint) {
            emptyLines.push(queueHint);
        }
        replyEl.innerHTML = Utils.escapeHtml(emptyLines.join('\n')).replace(/\n/g, '<br>');
        replyEl.className = 'reply-preview empty';
    } else {
        await ensureBotInfo();
        const botName = (currentBotInfo && currentBotInfo.nickname) || 'Genesis Bot';
        const botAvatar = sanitizeImageSrc((currentBotInfo && currentBotInfo.avatar) || '') || 'assets/avatar_bot.png';

        replyEl.className = 'reply-preview';
        replyEl.innerHTML = `
            <div class="chat-message">
                <img src="${Utils.escapeHtml(botAvatar)}" class="chat-avatar" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzU4YTZmZiIgZD0iTTEyIDJhMTAgMTAgMCAwIDEgMTAgMTBHMTAgMjJhMTAgMTAgMCAwIDEtMTAtMTBTMiAxMiAyIDJ6bTAgMmE4IDggMCAwIDAgOCA4IDggOCAwIDAgMC04LThDOCA0IDggOCA4IDh6Ii8+PC9zdmc+'">
                <div class="chat-content">
                    <div class="chat-header">
                        <span class="chat-name">${Utils.escapeHtml(botName)}</span>
                        ${queueHint ? `<span class="chat-meta" style="margin-left:8px;color:var(--text-sub);font-size:12px;">${Utils.escapeHtml(queueHint)}</span>` : ''}
                    </div>
                    <div class="chat-bubble" ${response.data?.song ? 'style="padding:0;background:transparent;box-shadow:none;"' : ''}>
${response.data?.song ? (() => {
            const s = response.data.song;
            const safeSongPicUrl = Utils.escapeHtml(sanitizeImageSrc(s.picUrl || ''));
            return `<div class="music-card" data-ui-action="open-music-song" data-song-id="${Utils.escapeHtml(String(s.id || ''))}">
    <div class="music-cover">
        <img src="${safeSongPicUrl}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%23ccc\'%3E%3Cpath d=\'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z\'/%3E%3C/svg%3E'">
    </div>
    <div class="music-info">
        <div class="music-title">${Utils.escapeHtml(s.name)}</div>
        <div class="music-artist">${Utils.escapeHtml(s.artists)}</div>
        <div class="music-source">
            <svg viewBox="0 0 1024 1024" width="12" height="12" style="fill:#C20C0C;margin-right:2px"><path d="M512 0C229.23 0 0 229.23 0 512s229.23 512 512 512 512-229.23 512-512S794.77 0 512 0z m0 924.44c-227.18 0-412.44-185.26-412.44-412.44S284.82 99.56 512 99.56s412.44 185.26 412.44 412.44-185.26 412.44-412.44 412.44z"></path><path d="M460.8 732.44h-51.2v-256h51.2v256zM614.4 732.44h-51.2v-358.4l-128 35.84V358.4l179.2-51.2v425.24z"></path></svg> 网易云音乐
        </div>
    </div>
</div>`;
        })() : Utils.escapeHtml(replyText)}
                    </div>
                </div>
            </div>
        `;
    }

    if (isSuccess) {
        responseEl.style.borderColor = '#3fb950';
        return normalized;
    }

    responseEl.style.borderColor = '#f85149';
    const bubble = replyEl.querySelector('.chat-bubble');
    if (bubble) {
        bubble.classList.add('error');
    } else {
        replyEl.classList.add('error');
    }

    return normalized;
}

async function pollQueuedToolTest(requestId, elements) {
    const timeoutMs = 120000;
    const intervalMs = 1500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        await sleep(intervalMs);
        const polled = await API.get(`/api/tools/test/${encodeURIComponent(requestId)}`);
        const normalized = await renderToolTestResult(polled, elements);
        if (!normalized.queueMeta || normalized.queueMeta.completed) {
            return normalized;
        }
    }

    const timeoutResult = {
        success: false,
        queued: true,
        completed: false,
        requestId,
        message: '等待执行结果超时，请稍后手动刷新状态',
        duration: Date.now() - startedAt,
        response: {
            success: false,
            error: '等待 genesis-agent 执行结果超时',
        },
    };
    return renderToolTestResult(timeoutResult, elements);
}

// Tool Test: Execute test
window.executeToolTest = async function () {
    if (!currentTestTool) {
        alert('请先选择工具');
        return;
    }

    const toolName = currentTestTool;

    let params = {};
    if (currentParamTab === 'json') {
        const jsonText = document.getElementById('test-tool-params-json').value;
        const parsedParams = Utils.safeParseJson(jsonText || '{}');
        if (!parsedParams || typeof parsedParams !== 'object' || Array.isArray(parsedParams)) {
            alert('JSON 格式错误，请输入对象格式参数');
            return;
        }
        params = parsedParams;
    } else {
        params = collectFormParams();
    }

    const requestEl = document.getElementById('test-request');
    const responseEl = document.getElementById('test-response');
    const durationEl = document.getElementById('test-duration');
    const btnEl = document.getElementById('btn-execute-test');
    const replyEl = document.getElementById('test-reply-preview');
    const elements = { responseEl, durationEl, replyEl };

    btnEl.disabled = true;
    btnEl.textContent = '⏳ 执行中...';
    durationEl.textContent = '';
    responseEl.style.borderColor = '';

    const requestData = { toolName, params, timestamp: new Date().toISOString() };
    requestEl.textContent = JSON.stringify(requestData, null, 2);
    responseEl.textContent = '等待响应...';
    replyEl.textContent = '等待响应...';
    replyEl.className = 'reply-preview response-tab-content';

    try {
        const result = await API.post('/api/tools/test', { toolName, params });
        const normalized = await renderToolTestResult(result, elements);
        if (normalized.queueMeta && !normalized.queueMeta.completed && normalized.queueMeta.requestId) {
            await pollQueuedToolTest(normalized.queueMeta.requestId, elements);
        }
    } catch (e) {
        responseEl.textContent = JSON.stringify({ error: e.message }, null, 2);
        responseEl.style.borderColor = '#f85149';

        replyEl.textContent = e.message;
        replyEl.className = 'reply-preview error';
    } finally {
        btnEl.disabled = false;
        btnEl.textContent = '▶️ 执行测试';
    }
};

// Global bot info cache
let currentBotInfo = null;

// Helper to ensure we have bot info
async function ensureBotInfo() {
    if (currentBotInfo) return;
    try {
        currentBotInfo = await API.get('/api/bot');
    } catch (e) {
        console.warn('Failed to fetch bot info for preview:', e);
    }
}

// Response Tab Switching
let currentResponseTab = 'json';
window.switchResponseTab = function (tab) {
    currentResponseTab = tab;
    const tabs = document.querySelectorAll('.tool-test-output .tab-btn');
    const contents = document.querySelectorAll('.response-tab-content');

    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));

    if (tab === 'json') {
        document.getElementById('test-response').style.display = 'block';
        document.getElementById('test-reply-preview').style.display = 'none';
    } else {
        document.getElementById('test-response').style.display = 'none';
        document.getElementById('test-reply-preview').style.display = 'block';
    }
};

async function loadAgents() {
    const grid = document.getElementById('grid-agents');
    try {
        const d = await API.get('/api/agents');
        if (grid) {
            grid.innerHTML = Object.entries(d).map(([k, v]) => renderSwitchCard(k, v, 'agents')).join('');
            bindToggleGridActions(grid);
        }
    } catch (e) {
        console.error('Load agents failed', e);
        if (grid) {
            grid.innerHTML = '<div class="llm-empty-state">Agent 配置加载失败，请稍后重试。</div>';
        }
    }
}

function stringifyToolLogValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

async function loadToolLogs() {
    try {
        const logs = await API.get('/api/tools/logs');
        currentToolLogs = Array.isArray(logs) ? logs : [];
        const tbody = document.querySelector('#table-tool-logs tbody');
        const mobileContainer = document.getElementById('tool-logs-mobile');

        const emptyState = '<div class="tool-log-empty">还没有工具调用日志</div>';
        if (tbody) {
            if (!currentToolLogs.length) {
                tbody.innerHTML = `<tr class="tool-log-empty-row"><td colspan="7">${emptyState}</td></tr>`;
            } else {
                tbody.innerHTML = currentToolLogs.map((log, index) => {
                const isSuccess = log.success;
                const statusBadge = isSuccess ?
                    `<span class="badge badge-success">Success</span>` :
                    `<span class="badge badge-error">Fail</span>`;
                const userName = log.user?.name || 'Unknown';
                const userId = log.user?.id != null ? String(log.user.id) : '-';
                const rawResultText = stringifyToolLogValue(log.result);
                const rawParamsText = stringifyToolLogValue(log.params);

                // Truncate result text
                let resultText = rawResultText;
                if (resultText.length > 50) {
                    resultText = resultText.slice(0, 50) + '...';
                }

                return `
                <tr class="hover-row">
                    <td style="font-family:var(--font-mono);color:var(--text-sub);">${new Date(log.time).toLocaleTimeString()}</td>
                    <td><span style="font-weight:600;color:var(--accent);">${Utils.escapeHtml(log.name)}</span></td>
                    <td>
                        <span class="badge badge-neutral" style="font-family:var(--font-mono);cursor:help;" title="${Utils.escapeHtml(rawParamsText)}">
                            JSON Params
                        </span>
                    </td>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            ${statusBadge}
                            <span style="color:var(--text-sub);font-size:12px;opacity:0.8;" title="${Utils.escapeHtml(rawResultText)}">
                                ${Utils.escapeHtml(resultText)}
                            </span>
                        </div>
                    </td>
                    <td>${Utils.escapeHtml(userName)} <span style="font-size:12px;color:var(--text-sub);">(${Utils.escapeHtml(userId)})</span></td>
                    <td style="font-family:var(--font-mono);">${log.duration}ms</td>
                    <td>
                         <button class="btn btn-sm btn-primary btn-view-log" data-index="${index}">
                            查看 View
                        </button>
                        ${log.taskId ? `<button class="btn btn-sm" style="margin-left:4px;" data-task-action="view-detail" data-task-id="${Utils.escapeHtml(log.taskId)}" title="查看任务详情 Task Detail">📋</button>` : ''}
                    </td>
                </tr>
            `}).join('');
            }
        }

        if (mobileContainer) {
            if (!currentToolLogs.length) {
                mobileContainer.innerHTML = emptyState;
            } else {
                mobileContainer.innerHTML = currentToolLogs.map((log, index) => {
                    const isSuccess = log.success;
                    const statusBadge = isSuccess ?
                        `<span class="badge badge-success">Success</span>` :
                        `<span class="badge badge-error">Fail</span>`;
                    const userName = log.user?.name || 'Unknown';
                    const userId = log.user?.id != null ? String(log.user.id) : '-';
                    const rawResultText = stringifyToolLogValue(log.result);
                    const resultPreview = rawResultText.length > 96 ? rawResultText.slice(0, 96) + '...' : rawResultText;
                    const logDate = log.time ? new Date(log.time) : null;
                    const timeText = logDate ? logDate.toLocaleString() : '-';
                    const durationText = Number.isFinite(Number(log.duration)) ? `${log.duration}ms` : (log.duration || '-');
                    const paramsLabel = stringifyToolLogValue(log.params) ? 'JSON Params' : 'No Params';

                    return `
                    <article class="tool-log-card">
                        <div class="tool-log-card-head">
                            <div class="tool-log-card-heading">
                                <div class="tool-log-card-title">${Utils.escapeHtml(log.name || 'Unknown Tool')}</div>
                                <div class="tool-log-card-tags">
                                    <span class="badge badge-neutral">${paramsLabel}</span>
                                </div>
                            </div>
                            ${statusBadge}
                        </div>
                        <div class="tool-log-card-meta">
                            <div class="tool-log-card-field">
                                <div class="tool-log-card-label">时间</div>
                                <div class="tool-log-card-value">${Utils.escapeHtml(timeText)}</div>
                            </div>
                            <div class="tool-log-card-field">
                                <div class="tool-log-card-label">耗时</div>
                                <div class="tool-log-card-value tool-log-card-value-mono">${Utils.escapeHtml(durationText)}</div>
                            </div>
                            <div class="tool-log-card-field tool-log-card-field-full">
                                <div class="tool-log-card-label">用户</div>
                                <div class="tool-log-card-value">${Utils.escapeHtml(userName)} <span class="tool-log-card-user-id">(${Utils.escapeHtml(userId)})</span></div>
                            </div>
                        </div>
                        <div class="tool-log-card-summary">${Utils.escapeHtml(resultPreview || '暂无返回结果')}</div>
                        <div class="tool-log-card-actions${log.taskId ? '' : ' tool-log-card-actions-single'}">
                            <button class="btn btn-sm btn-primary btn-view-log" data-index="${index}">查看详情</button>
                            ${log.taskId ? `<button class="btn btn-sm" data-task-action="view-detail" data-task-id="${Utils.escapeHtml(log.taskId)}" title="查看任务详情 Task Detail">任务详情</button>` : ''}
                        </div>
                    </article>
                `;
                }).join('');
            }
        }
    } catch (e) { console.error('Load tool logs failed', e); }
}

document.addEventListener('mousedown', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    if (target.closest('.llm-model-option')) {
        e.preventDefault();
    }
});

document.addEventListener('change', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const providerSelect = target.closest('[data-llm-provider-select]');
    if (providerSelect) {
        window.handleLlmModuleProviderChange(providerSelect.dataset.moduleId || '');
    }
});

document.addEventListener('input', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const modelInput = target.closest('[data-llm-model-input]');
    if (modelInput) {
        window.handleLlmModuleModelInput(modelInput.dataset.moduleId || '');
    }
});

document.addEventListener('focusin', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const modelInput = target.closest('[data-llm-model-input]');
    if (modelInput) {
        window.handleLlmModuleModelFocus(modelInput.dataset.moduleId || '');
    }
});

document.addEventListener('focusout', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const modelInput = target.closest('[data-llm-model-input]');
    if (modelInput) {
        window.handleLlmModuleModelBlur();
    }
});

document.addEventListener('keydown', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const modelInput = target.closest('[data-llm-model-input]');
    if (modelInput) {
        window.handleLlmModuleModelKeydown(e, modelInput.dataset.moduleId || '');
    }
});

// Event Delegation for dynamic action buttons
document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    const llmActionEl = target.closest('[data-llm-action]');
    if (llmActionEl) {
        const action = llmActionEl.dataset.llmAction || '';
        const moduleId = llmActionEl.dataset.moduleId || '';
        const providerId = llmActionEl.dataset.providerId || '';
        const encodedModel = llmActionEl.dataset.model || '';

        if (action === 'open-model-browser') return void window.openLlmModelBrowser(moduleId);
        if (action === 'test-module') return void window.testLlmModule(moduleId);
        if (action === 'save-module') return void window.saveLlmModule(moduleId);
        if (action === 'edit-provider') return void window.editLlmProvider(providerId);
        if (action === 'refresh-provider-models') return void window.refreshLlmProviderModels(providerId);
        if (action === 'delete-provider') return void window.deleteLlmProvider(providerId);
        if (action === 'pick-module-model') return void window.pickLlmModuleModel(moduleId, encodedModel);
        if (action === 'choose-browser-model') return void window.chooseLlmModel(encodedModel);
    }

    const taskActionEl = target.closest('[data-task-action]');
    if (taskActionEl) {
        const action = taskActionEl.dataset.taskAction || '';
        const taskId = taskActionEl.dataset.taskId || '';

        if (action === 'view-detail') return void window.viewTaskDetail(taskId);
        if (action === 'cancel') return void window.cancelTask(taskId);
    }

    const uiActionEl = target.closest('[data-ui-action]');
    if (uiActionEl) {
        const action = uiActionEl.dataset.uiAction || '';
        if (action === 'open-music-song') {
            const songId = uiActionEl.dataset.songId || '';
            if (songId) {
                window.open(`https://music.163.com/#/song?id=${encodeURIComponent(songId)}`, '_blank');
            }
            return;
        }
    }

    const btn = target.closest('.btn-view-log');
    if (btn) {
        const index = btn.dataset.index;
        console.log('[App] View button clicked, index:', index);
        openLogDetails(index);
    }
});

function openLogDetails(index) {
    console.log('[App] openLogDetails called with:', index);
    const log = currentToolLogs[index];
    if (!log) {
        console.error('[App] Log not found in currentToolLogs of length', currentToolLogs.length);
        return;
    }

    document.getElementById('log-detail-tool').innerText = log.name;
    document.getElementById('log-detail-user').innerText = `${log.user.name} (${log.user.id})`;
    document.getElementById('log-detail-duration').innerText = log.duration + 'ms';
    document.getElementById('log-detail-time').innerText = new Date(log.time).toLocaleString();

    const statusEl = document.getElementById('log-detail-status');
    statusEl.innerHTML = log.success ?
        '<span class="badge badge-success">Success</span>' :
        '<span class="badge badge-error">Failed</span>';

    try {
        document.getElementById('log-detail-params').innerText = JSON.stringify(log.params, null, 2);
    } catch (e) {
        document.getElementById('log-detail-params').innerText = String(log.params);
    }

    document.getElementById('log-detail-result').innerText = log.result;
    document.getElementById('modal-log-details').classList.add('active');
}
window.openLogDetails = openLogDetails;

function renderSwitchCard(key, item, type) {
    const icon = Utils.escapeHtml(item.icon || '');
    const name = Utils.escapeHtml(item.name || key);
    const safeKey = Utils.escapeHtml(key);
    const testButton = type === 'tools'
        ? `<button class="btn btn-sm js-open-tool-test" style="margin-right:12px;" data-tool-name="${safeKey}" data-tool-icon="${icon}" data-tool-display-name="${name}">🧪</button>`
        : '';
    return `
    <div class="toggle-card">
        <div style="display:flex;align-items:center;gap:12px;">
            <div style="font-size:24px;">${icon}</div>
            <div>
                <div style="font-weight:600;">${name}</div>
                <div style="font-size:12px;color:var(--text-sub);">${safeKey}</div>
            </div>
        </div>
        <div style="display:flex;align-items:center;">
            ${testButton}
            <div class="switch ${item.enabled ? 'checked' : ''} js-toggle-switch" data-type="${Utils.escapeHtml(type)}" data-key="${safeKey}"></div>
        </div>
    </div>`;
}

function bindToggleGridActions(grid) {
    grid.querySelectorAll('.js-open-tool-test').forEach((button) => {
        button.addEventListener('click', () => {
            window.openToolTest(
                button.dataset.toolName || '',
                button.dataset.toolIcon || '',
                button.dataset.toolDisplayName || button.dataset.toolName || '',
            );
        });
    });

    grid.querySelectorAll('.js-toggle-switch').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            window.toggleSwitch(toggle);
        });
    });
}

// Expose to window for inline onclicks
window.toggleSwitch = async function (el) {
    const type = el.dataset.type;
    const key = el.dataset.key;
    if (!type || !key || el.dataset.loading === '1') return;

    const previousEnabled = el.classList.contains('checked');
    const enabled = !previousEnabled;

    el.dataset.loading = '1';
    el.style.pointerEvents = 'none';

    try {
        const result = await API.put(`/api/${type}/${key}`, { enabled });
        if (!result || result.success === false) {
            throw new Error(result?.error || result?.message || '未知错误');
        }

        const actualEnabled = typeof result[key] === 'boolean' ? result[key] : enabled;
        el.classList.toggle('checked', actualEnabled);

        if (type === 'tools') {
            await loadTools();
        } else if (type === 'agents') {
            await loadAgents();
        }

        if ('applied' in result || 'saved' in result) {
            await refreshManagedProcessState();
        }

        if (actualEnabled !== enabled || result.saved === false || ('applied' in result && result.applied === false)) {
            alert(result.message || '切换完成，但存在额外状态需要关注');
        }
    } catch (e) {
        el.classList.toggle('checked', previousEnabled);
        alert('切换失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
        delete el.dataset.loading;
        el.style.pointerEvents = '';
    }
};

// Profiles
const PROFILE_FAVORABILITY_BASELINE = 35;

async function loadProfiles() {
    try {
        const list = await API.get('/api/profiles');
        let container = document.querySelector('#table-profiles');
        // Prevent closest error if table is already cleared or replaced
        if (container) {
            container = container.closest('.table-container');
        } else {
            // Try to find if grid exists directly
            const grid = document.getElementById('profile-grid');
            if (grid) {
                // Grid exists, no need to replace
                grid.innerHTML = list.map(p => renderProfileCard(p)).join('');
                return;
            }
            // If neither exists, we might be in trouble or initial load failed.
            // Try to find parent by page structure?
            const page = document.getElementById('page-profiles');
            container = page.querySelector('.table-container');
        }

        // Replace table container with grid container if not already done
        if (container) {
            const grid = document.createElement('div');
            grid.className = 'profile-grid';
            grid.id = 'profile-grid';
            container.parentNode.replaceChild(grid, container);
        }

        const grid = document.getElementById('profile-grid');
        if (!grid) return; // Should not happen after replacement

        grid.innerHTML = list.map(p => renderProfileCard(p)).join('');
    } catch (e) { console.error('Load profiles failed', e); }
}

function renderProfileCard(p) {
    // 修复日期显示
    let lastActiveStr = '从未活跃';
    // Back-end returns 'lastSeen' (timestamp number)
    const ts = p.lastSeen || p.lastActive || 0;

    if (ts > 0) {
        lastActiveStr = Utils.formatDate(ts);
    }

    // Backend returns 'notes' as the summary/remark
    const summary = p.notes || p.summary || '暂无 AI 印象摘要';
    const favorFormatted = (typeof p.favorability === 'number') ? p.favorability.toFixed(2) : `${PROFILE_FAVORABILITY_BASELINE.toFixed(2)}`;

    return `
    <div class="profile-card">
        <div class="profile-header">
            <div style="display:flex;align-items:center;">
                <div class="profile-avatar">${p.nickname ? p.nickname[0] : '?'}</div>
                <div class="profile-info">
                    <div class="profile-name">${Utils.escapeHtml(p.nickname || '未命名')}</div>
                    <div class="profile-id">${p.userId}</div>
                </div>
            </div>
            <div style="font-size:24px;font-weight:bold;color:var(--accent);">${favorFormatted}</div>
        </div>
        
        <div class="profile-stats">
            <div class="profile-stat-item">💬 <span class="profile-stat-value">${p.messageCount || 0}</span></div>
            <div class="profile-stat-item">🕒 <span class="profile-stat-value" style="font-size:11px;">${lastActiveStr}</span></div>
        </div>

        <div class="profile-summary" title="${Utils.escapeHtml(summary)}">
            ${Utils.escapeHtml(summary)}
        </div>

        <div class="profile-actions">
            <button class="btn btn-sm btn-primary" onclick="window.viewProfile(${p.userId})">编辑详情</button>
        </div>
    </div>
    `;
}

const PROFILE_EVIDENCE_SOURCE_LABELS = {
    llm: 'LLM',
    manual: '人工',
    legacy: '历史',
};
const PROFILE_MEMORY_SENTIMENT_LABELS = {
    positive: '正向',
    neutral: '中性',
    negative: '负向',
};
const PROFILE_CONFLICT_STATUS_LABELS = {
    active: '进行中',
    resolved: '已缓和',
    lingering: '仍有余波',
};
const PROFILE_FAVORABILITY_LEVELS = {
    acquaintance: 55,
    goodFriend: 70,
    oldFriend: 85,
};
const PROFILE_FAVORABILITY_EVENT_SOURCE_LABELS = {
    profiler: '分析',
    manual: '人工',
    system: '系统',
};
const PROFILE_FAVORABILITY_EVENT_REASON_LABELS = {
    analysis: '画像分析',
    manual_edit: '手动调整',
    import: '导入同步',
};
const PROFILE_TEXT_SECTIONS = [
    {
        key: 'traits',
        evidenceKey: 'traitEvidence',
        title: '性格倾向 Traits',
        note: '长期稳定的行为风格和表达习惯。',
        placeholder: '添加性格倾向...',
    },
    {
        key: 'identityFacts',
        evidenceKey: 'identityEvidence',
        title: '基础身份',
        note: '稳定身份事实、自我定位、常驻角色。',
        placeholder: '添加身份事实...',
    },
    {
        key: 'interests',
        evidenceKey: 'interestEvidence',
        title: '兴趣主题 Interests',
        note: '长期会反复出现的兴趣方向。',
        placeholder: '添加兴趣主题...',
    },
    {
        key: 'likes',
        evidenceKey: 'likeEvidence',
        title: '明确偏好',
        note: '喜欢的内容、被对待的方式或常用选择。',
        placeholder: '添加偏好...',
    },
    {
        key: 'dislikes',
        evidenceKey: 'dislikeEvidence',
        title: '明显反感',
        note: '明确表示不喜欢的内容或互动方式。',
        placeholder: '添加反感项...',
    },
    {
        key: 'redLines',
        evidenceKey: 'redLineEvidence',
        title: '雷区与边界',
        note: '最好不要踩的禁区与底线。',
        placeholder: '添加雷区...',
    },
    {
        key: 'emotionPatterns',
        evidenceKey: 'emotionPatternEvidence',
        title: '情绪机制',
        note: '情绪上来时常见的表达模式。',
        placeholder: '添加情绪机制...',
    },
    {
        key: 'emotionalTriggers',
        evidenceKey: 'emotionalTriggerEvidence',
        title: '触发因素',
        note: '容易引起烦躁、开心、敏感的因素。',
        placeholder: '添加触发因素...',
    },
    {
        key: 'calmingSignals',
        evidenceKey: 'calmingSignalEvidence',
        title: '安抚方式',
        note: '什么样的回应更容易让对方放松下来。',
        placeholder: '添加安抚方式...',
    },
    {
        key: 'relationshipNotes',
        evidenceKey: 'relationshipNoteEvidence',
        title: '关系线索',
        note: '信任、依赖、亲近感等关系推进信号。',
        placeholder: '添加关系线索...',
    },
    {
        key: 'boundaryNotes',
        evidenceKey: 'boundaryNoteEvidence',
        title: '相处边界',
        note: '需要记住的相处禁忌与边界提醒。',
        placeholder: '添加边界提醒...',
    },
];
const PROFILE_TEXT_SECTION_MAP = Object.fromEntries(PROFILE_TEXT_SECTIONS.map((section) => [section.key, section]));
const PROFILE_SECTION_GROUPS = [
    {
        title: '基础身份',
        note: '这部分记录“这个人是谁、长期像什么样”。',
        keys: ['traits', 'identityFacts'],
    },
    {
        title: '偏好与雷区',
        note: '把喜欢什么、讨厌什么、最好别碰什么拆开记录。',
        keys: ['interests', 'likes', 'dislikes', 'redLines'],
    },
    {
        title: '情绪机制',
        note: '比单次 mood 更重要的是：什么会触发、什么能接住。',
        keys: ['emotionPatterns', 'emotionalTriggers', 'calmingSignals'],
    },
    {
        title: '关系与边界',
        note: '关系线索和相处边界要分开记，避免“亲近”和“越界”混在一起。',
        keys: ['relationshipNotes', 'boundaryNotes'],
    },
];
const PROFILE_MEMORY_SECTIONS = [
    {
        key: 'importantMemories',
        title: '重要对话记忆',
        note: '只保留以后继续聊天时真的有用的事件、约定和背景。',
        empty: '还没有沉淀出长期记忆。',
        showStatus: false,
    },
    {
        key: 'conflictRecords',
        title: '关系与冲突记录',
        note: '记录误会、冲突、边界碰撞，以及它们是否已经缓和。',
        empty: '目前没有需要长期记住的冲突记录。',
        showStatus: true,
    },
];
const PROFILE_MEMORY_SECTION_MAP = Object.fromEntries(PROFILE_MEMORY_SECTIONS.map((section) => [section.key, section]));
let profileModalState = null;

function formatProfileTimestamp(ts, fallback = '未记录') {
    return (typeof ts === 'number' && ts > 0) ? Utils.formatDate(ts) : fallback;
}

function renderProfileEvidence(entries) {
    const safeEntries = Array.isArray(entries) ? entries.slice(0, 6) : [];
    if (!safeEntries.length) {
        return '<div class="profile-evidence-empty">暂无画像证据</div>';
    }

    return `
        <div class="profile-evidence-list">
            ${safeEntries.map((item) => {
                const title = Utils.escapeHtml(item.value || '未命名');
                const score = (typeof item.score === 'number') ? item.score.toFixed(2) : '0.00';
                const count = Number.isFinite(item.count) ? Math.max(0, Math.round(item.count)) : 0;
                const source = PROFILE_EVIDENCE_SOURCE_LABELS[item.source] || '未知';
                const lastSeen = formatProfileTimestamp(item.lastSeen, '未知');

                return `
                    <div class="profile-evidence-item">
                        <div class="profile-evidence-header">
                            <div class="profile-evidence-title">${title}</div>
                            <span class="profile-evidence-badge">${Utils.escapeHtml(source)}</span>
                        </div>
                        <div class="profile-evidence-meta">
                            <span>权重 ${score}</span>
                            <span>命中 ${count} 次</span>
                            <span>最近 ${Utils.escapeHtml(lastSeen)}</span>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function getProfileRelationLevel(favorability) {
    if (favorability >= PROFILE_FAVORABILITY_LEVELS.oldFriend) return '老朋友';
    if (favorability >= PROFILE_FAVORABILITY_LEVELS.goodFriend) return '好朋友';
    if (favorability >= PROFILE_FAVORABILITY_LEVELS.acquaintance) return '熟人';
    return '新朋友';
}

function renderFavorabilityEvents(events) {
    const safeEntries = Array.isArray(events) ? events.slice(0, 6) : [];
    if (!safeEntries.length) {
        return '<div class="profile-evidence-empty">还没有记录好感度变化原因。</div>';
    }

    return `
        <div class="profile-favorability-event-list">
            ${safeEntries.map((item) => {
                const delta = typeof item.delta === 'number' ? item.delta : 0;
                const signedDelta = `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;
                const source = PROFILE_FAVORABILITY_EVENT_SOURCE_LABELS[item.source] || '未知';
                const reason = PROFILE_FAVORABILITY_EVENT_REASON_LABELS[item.reason] || '未知';
                const timestamp = formatProfileTimestamp(item.timestamp, '未记录');
                const before = typeof item.before === 'number' ? item.before.toFixed(2) : '0.00';
                const after = typeof item.after === 'number' ? item.after.toFixed(2) : '0.00';
                const note = item.note ? `<div class="profile-favorability-event-note">${Utils.escapeHtml(item.note)}</div>` : '';

                return `
                    <div class="profile-favorability-event-item">
                        <div class="profile-favorability-event-header">
                            <div class="profile-favorability-event-delta ${delta >= 0 ? 'is-positive' : 'is-negative'}">${Utils.escapeHtml(signedDelta)}</div>
                            <div class="profile-memory-badges">
                                <span class="profile-memory-badge">${Utils.escapeHtml(source)}</span>
                                <span class="profile-memory-badge">${Utils.escapeHtml(reason)}</span>
                                <span class="profile-memory-badge">${Utils.escapeHtml(timestamp)}</span>
                            </div>
                        </div>
                        <div class="profile-favorability-event-meta">
                            <span>${Utils.escapeHtml(before)} -> ${Utils.escapeHtml(after)}</span>
                        </div>
                        ${note}
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function formatProfileDateTimeLocal(ts) {
    if (typeof ts !== 'number' || ts <= 0) {
        return '';
    }

    const date = new Date(ts);
    const offsetMs = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getProfileSectionConfig(type) {
    return PROFILE_TEXT_SECTION_MAP[type];
}

function getProfileModalTags(profile, type, manualOnly) {
    if (!manualOnly) {
        return Array.isArray(profile?.[type]) ? profile[type] : [];
    }

    const config = getProfileSectionConfig(type);
    const entries = config && Array.isArray(profile?.[config.evidenceKey]) ? profile[config.evidenceKey] : [];
    return entries
        .filter(item => item.source === 'manual')
        .map(item => item.value)
        .filter(Boolean);
}

function getProfileModalEvidence(profile, key, manualOnly) {
    const entries = Array.isArray(profile?.[key]) ? profile[key] : [];
    return manualOnly ? entries.filter(item => item.source === 'manual') : entries;
}

function getProfileMemoryEntries(profile, key, manualOnly) {
    const entries = Array.isArray(profile?.[key]) ? profile[key] : [];
    return manualOnly ? entries.filter(item => item.source === 'manual') : entries;
}

function renderProfileTextSection(type, profile, manualOnly) {
    const config = getProfileSectionConfig(type);
    if (!config) {
        return '';
    }

    const tags = getProfileModalTags(profile, type, manualOnly);
    const evidence = getProfileModalEvidence(profile, config.evidenceKey, manualOnly);

    return `
        <div class="profile-archive-panel">
            <div class="profile-section-header">
                <div>
                    <div class="profile-section-title">${config.title}</div>
                    <div class="profile-section-note">${manualOnly ? '当前为人工视图，只展示人工维护内容。' : config.note}</div>
                </div>
            </div>
            <div class="chip-input-container" id="container-${type}">
                ${tags.map((tag) => renderChip(tag)).join('')}
                ${manualOnly ? '' : `<input class="chip-input" id="input-${type}" placeholder="${config.placeholder}">`}
            </div>
            ${renderProfileEvidence(evidence)}
        </div>
    `;
}

function renderProfileTextGroup(group, profile, manualOnly) {
    return `
        <div class="profile-modal-section profile-archive-group">
            <div class="profile-section-header">
                <div>
                    <div class="profile-section-title">${group.title}</div>
                    <div class="profile-section-note">${group.note}</div>
                </div>
            </div>
            <div class="profile-archive-grid">
                ${group.keys.map((key) => renderProfileTextSection(key, profile, manualOnly)).join('')}
            </div>
        </div>
    `;
}

function renderProfileMemoryEditorItem(type, entry = {}) {
    const section = PROFILE_MEMORY_SECTION_MAP[type];
    const happenedAt = formatProfileDateTimeLocal(entry.happenedAt);
    const source = PROFILE_EVIDENCE_SOURCE_LABELS[entry.source] || '人工';
    const sentiment = entry.sentiment || 'neutral';
    const status = entry.status || 'lingering';
    const importance = Number.isFinite(entry.importance) ? Math.max(1, Math.min(5, Math.round(entry.importance))) : 3;
    const count = Number.isFinite(entry.count) ? Math.max(1, Math.round(entry.count)) : 1;
    const lastSeen = formatProfileTimestamp(entry.lastSeen, '未记录');

    return `
        <div class="profile-memory-editor-item" data-memory-type="${type}">
            <div class="profile-memory-editor-header">
                <div class="profile-memory-editor-title">${Utils.escapeHtml(section?.title || '记忆条目')}</div>
                <div class="profile-memory-badges">
                    <span class="profile-memory-badge">${Utils.escapeHtml(source)}</span>
                    <span class="profile-memory-badge">命中 ${count} 次</span>
                    <span class="profile-memory-badge">最近 ${Utils.escapeHtml(lastSeen)}</span>
                </div>
            </div>
            <div class="profile-memory-editor-grid">
                <div class="form-group">
                    <label class="form-label">摘要</label>
                    <input class="form-input profile-memory-summary" value="${Utils.escapeHtml(entry.summary || '')}" placeholder="一句话说明为什么要长期记住">
                </div>
                <div class="form-group">
                    <label class="form-label">发生时间</label>
                    <input type="datetime-local" class="form-input profile-memory-happened-at" value="${Utils.escapeHtml(happenedAt)}">
                </div>
                <div class="form-group">
                    <label class="form-label">重要度</label>
                    <select class="form-input profile-memory-importance">
                        ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${value === importance ? 'selected' : ''}>${value}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">情绪色彩</label>
                    <select class="form-input profile-memory-sentiment">
                        ${Object.entries(PROFILE_MEMORY_SENTIMENT_LABELS).map(([value, label]) => `<option value="${value}" ${value === sentiment ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                </div>
                ${section?.showStatus ? `
                    <div class="form-group">
                        <label class="form-label">状态</label>
                        <select class="form-input profile-memory-status">
                            ${Object.entries(PROFILE_CONFLICT_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === status ? 'selected' : ''}>${label}</option>`).join('')}
                        </select>
                    </div>
                ` : ''}
            </div>
            <div class="form-group" style="margin-bottom:0;">
                <label class="form-label">补充说明</label>
                <textarea class="form-input form-textarea profile-memory-detail" placeholder="可选，写一点背景、触发原因或后续变化">${Utils.escapeHtml(entry.detail || '')}</textarea>
            </div>
            <div class="profile-memory-editor-actions">
                <button type="button" class="btn profile-action-btn" onclick="window.removeProfileMemoryItem(this)">删除条目</button>
            </div>
        </div>
    `;
}

function renderProfileMemoryEditor(type, entries, manualOnly) {
    const section = PROFILE_MEMORY_SECTION_MAP[type];
    const safeEntries = Array.isArray(entries) ? entries.slice(0, 8) : [];
    if (!safeEntries.length) {
        return `
            <div class="profile-memory-list" id="memory-list-${type}"></div>
            <div class="profile-evidence-empty">${manualOnly ? '当前人工视图下没有人工条目。' : (section?.empty || '暂无条目')}</div>
            ${manualOnly ? '' : `<button type="button" class="btn profile-action-btn" onclick="window.addProfileMemoryItem('${type}')">新增条目</button>`}
        `;
    }

    return `
        <div class="profile-memory-list" id="memory-list-${type}">
            ${safeEntries.map((item) => renderProfileMemoryEditorItem(type, item)).join('')}
        </div>
        ${manualOnly ? '' : `<button type="button" class="btn profile-action-btn" onclick="window.addProfileMemoryItem('${type}')">新增条目</button>`}
    `;
}

function renderProfileModal() {
    if (!profileModalState || !profileModalState.profile) return;

    const { profile, manualOnly } = profileModalState;
    const summary = profile.notes || profile.summary || '';
    const importantMemories = getProfileMemoryEntries(profile, 'importantMemories', manualOnly);
    const conflictRecords = getProfileMemoryEntries(profile, 'conflictRecords', manualOnly);
    const relationLevel = getProfileRelationLevel(
        typeof profile.favorability === 'number' ? profile.favorability : PROFILE_FAVORABILITY_BASELINE,
    );
    const moodLabel = profile.mood === 'positive'
        ? '偏正向'
        : profile.mood === 'negative'
            ? '偏低落'
            : '平稳';

    const body = document.querySelector('#modal-profile .modal-body');
    body.innerHTML = `
        ${manualOnly ? '<div class="profile-mode-hint">当前仅展示人工维护的档案内容。自动推断出的证据、记忆和冲突会暂时隐藏，保存也会锁定，避免误覆盖。</div>' : ''}
        <div class="profile-overview-grid">
            <div class="form-group">
                <label class="form-label">QQ ID</label>
                <input class="form-input" value="${profile.userId}" disabled style="opacity:0.6;">
            </div>
            <div class="form-group">
                <label class="form-label">昵称 Nickname</label>
                <input class="form-input" id="edit-nickname" value="${Utils.escapeHtml(profile.nickname || '')}">
            </div>
            <div class="form-group">
                <label class="form-label">好感度 Favorability</label>
                <input type="number" step="0.1" min="0" max="100" class="form-input" id="edit-favor" value="${profile.favorability}">
            </div>
            <div class="form-group">
                <label class="form-label">消息数 Messages</label>
                <input type="number" class="form-input" id="edit-msgs" value="${profile.messageCount}" disabled style="opacity:0.6;">
            </div>
        </div>

        <div class="profile-meta-grid">
            <div class="profile-meta-card">
                <div class="profile-meta-label">关系阶段</div>
                <div class="profile-meta-value">${Utils.escapeHtml(relationLevel)}</div>
            </div>
            <div class="profile-meta-card">
                <div class="profile-meta-label">当前情绪</div>
                <div class="profile-meta-value">${Utils.escapeHtml(moodLabel)}</div>
            </div>
            <div class="profile-meta-card">
                <div class="profile-meta-label">最后分析</div>
                <div class="profile-meta-value">${Utils.escapeHtml(formatProfileTimestamp(profile.lastAnalyzed, '未分析'))}</div>
            </div>
            <div class="profile-meta-card">
                <div class="profile-meta-label">好感度更新时间</div>
                <div class="profile-meta-value">${Utils.escapeHtml(formatProfileTimestamp(profile.favorabilityUpdatedAt, '未记录'))}</div>
            </div>
        </div>
        <div class="profile-modal-section">
            <div class="profile-section-header">
                <div>
                    <div class="profile-section-title">好感度变化记录</div>
                    <div class="profile-section-note">把分数变化和触发原因留痕，方便长期维护和人工校正。</div>
                </div>
            </div>
            ${renderFavorabilityEvents(profile.favorabilityEvents)}
        </div>
        ${PROFILE_SECTION_GROUPS.map((group) => renderProfileTextGroup(group, profile, manualOnly)).join('')}
        <div class="profile-modal-section">
            <div class="profile-section-header">
                <div>
                    <div class="profile-section-title">重要对话记忆</div>
                    <div class="profile-section-note">只保留未来继续聊天时真的有用的事件与约定，不记流水账。</div>
                </div>
            </div>
            ${renderProfileMemoryEditor('importantMemories', importantMemories, manualOnly)}
        </div>
        <div class="profile-modal-section">
            <div class="profile-section-header">
                <div>
                    <div class="profile-section-title">关系与冲突记录</div>
                    <div class="profile-section-note">记录误会、冲突、边界碰撞，以及它们是否已经缓和。</div>
                </div>
            </div>
            ${renderProfileMemoryEditor('conflictRecords', conflictRecords, manualOnly)}
        </div>
        <div class="profile-modal-section">
            <div class="profile-section-header">
                <div>
                    <div class="profile-section-title">长期印象摘要 Summary</div>
                    <div class="profile-section-note">这里适合写人工备注，或者沉淀一个更高层的整体印象。</div>
                </div>
            </div>
            <textarea class="form-input form-textarea profile-summary-textarea" id="edit-summary">${Utils.escapeHtml(summary)}</textarea>
        </div>
    `;

    PROFILE_TEXT_SECTIONS.forEach((section) => setupChipInput(section.key));

    // Footer Buttons
    const footer = document.querySelector('#modal-profile .modal-footer');
    footer.innerHTML = `
        <div class="profile-modal-toolbar">
            <button class="btn btn-danger profile-action-btn" onclick="window.deleteProfile(${profile.userId})">删除画像</button>
            <button class="btn profile-action-btn" onclick="window.resetProfileEvidence(${profile.userId})">清理证据</button>
            <button class="btn profile-action-btn" onclick="window.recalculateProfile(${profile.userId})">重算画像</button>
            <button class="btn profile-action-btn" onclick="window.toggleProfileManualOnly()">${manualOnly ? '查看全部' : '只看人工'}</button>
        </div>
        <div class="profile-modal-actions">
            <button class="btn profile-action-btn profile-action-secondary" onclick="window.closeModals()">取消</button>
            <button class="btn btn-primary profile-action-btn profile-action-primary" ${manualOnly ? 'disabled title="请先切回全部档案视图再保存"' : ''} onclick="window.saveProfile(${profile.userId})">保存修改</button>
        </div>
    `;
}

window.viewProfile = async function (id) {
    try {
        const p = await API.get(`/api/profiles/${id}`);
        profileModalState = { profile: p, manualOnly: false };
        renderProfileModal();
        document.getElementById('p-nickname').innerText = '编辑用户画像';
        openModal('modal-profile');
    } catch (e) {
        alert('加载画像失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

function renderChip(text) {
    return `<span class="chip chip-deletable"><span>${Utils.escapeHtml(text)}</span><span class="chip-delete" onclick="this.parentElement.remove()">×</span></span>`;
}

function setupChipInput(type) {
    const input = document.getElementById(`input-${type}`);
    const container = document.getElementById(`container-${type}`);

    if (!input || !container) {
        return;
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = input.value.trim();
            if (val) {
                const chip = document.createElement('div');
                chip.innerHTML = renderChip(val);
                container.insertBefore(chip.firstChild, input);
                input.value = '';
            }
        }
    });
}

window.saveProfile = async function (id) {
    const getChips = (type) => Array.from(document.querySelectorAll(`#container-${type} .chip span:first-child`)).map(e => e.innerText);
    const favorabilityInput = parseFloat(document.getElementById('edit-favor').value || String(PROFILE_FAVORABILITY_BASELINE));
    const getMemoryEntries = (type) => {
        return Array.from(document.querySelectorAll(`#memory-list-${type} .profile-memory-editor-item`))
            .map((item) => {
                const summary = item.querySelector('.profile-memory-summary')?.value?.trim() || '';
                if (!summary) {
                    return null;
                }

                const happenedAtRaw = item.querySelector('.profile-memory-happened-at')?.value || '';
                const happenedAt = happenedAtRaw ? new Date(happenedAtRaw).getTime() : undefined;
                const statusNode = item.querySelector('.profile-memory-status');

                return {
                    summary,
                    detail: item.querySelector('.profile-memory-detail')?.value?.trim() || undefined,
                    importance: parseInt(item.querySelector('.profile-memory-importance')?.value || '3', 10),
                    sentiment: item.querySelector('.profile-memory-sentiment')?.value || 'neutral',
                    happenedAt,
                    status: statusNode ? (statusNode.value || undefined) : undefined,
                };
            })
            .filter(Boolean);
    };

    if (profileModalState?.manualOnly) {
        alert('请先切回“查看全部”后再保存修改。');
        return;
    }

    const data = {
        nickname: document.getElementById('edit-nickname').value,
        favorability: Number.isFinite(favorabilityInput) ? favorabilityInput : PROFILE_FAVORABILITY_BASELINE,
        notes: document.getElementById('edit-summary').value, // Map edit-summary to notes
    };

    PROFILE_TEXT_SECTIONS.forEach((section) => {
        data[section.key] = getChips(section.key);
    });
    PROFILE_MEMORY_SECTIONS.forEach((section) => {
        data[section.key] = getMemoryEntries(section.key);
    });

    try {
        const result = await API.put(`/api/profiles/${id}`, data);
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '保存失败');
        }
        profileModalState = null;
        closeModals();
        await loadProfiles();
        if (result?.agentSync && result.agentSync.applied === false) {
            alert(result.message || '画像已保存，但 genesis-agent 同步失败');
        }
    } catch (e) {
        alert('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.toggleProfileManualOnly = function () {
    if (!profileModalState) return;
    profileModalState.manualOnly = !profileModalState.manualOnly;
    renderProfileModal();
};

window.addProfileMemoryItem = function (type) {
    const container = document.getElementById(`memory-list-${type}`);
    if (!container) return;

    container.insertAdjacentHTML('beforeend', renderProfileMemoryEditorItem(type, { source: 'manual' }));
    const emptyHint = container.parentElement?.querySelector('.profile-evidence-empty');
    if (emptyHint) {
        emptyHint.remove();
    }
};

window.removeProfileMemoryItem = function (button) {
    const item = button?.closest('.profile-memory-editor-item');
    if (!item) return;

    const container = item.parentElement;
    item.remove();

    if (!container || container.children.length > 0) {
        return;
    }

    const type = container.id.replace('memory-list-', '');
    const section = PROFILE_MEMORY_SECTION_MAP[type];
    container.insertAdjacentHTML('afterend', `<div class="profile-evidence-empty">${section?.empty || '暂无条目'}</div>`);
};

window.resetProfileEvidence = async function (id) {
    if (!confirm('这会清理自动提取的画像证据，但会保留人工标签。确定继续吗？')) return;

    try {
        const result = await API.post(`/api/profiles/${id}/reset-evidence`, {});
        if (result?.error) {
            alert('清空证据失败: ' + result.error);
            return;
        }
        profileModalState = { profile: result.profile, manualOnly: false };
        renderProfileModal();
        await loadProfiles();
        if (result?.agentSync && result.agentSync.applied === false) {
            alert(result.message || '画像证据已清理，但 genesis-agent 同步失败');
        }
    } catch (e) {
        alert('清空证据失败: ' + e.message);
    }
};

async function pollProfileRecalculate(id, requestId) {
    const timeoutMs = 120000;
    const intervalMs = 1500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        await sleep(intervalMs);
        const result = await API.get(`/api/profiles/${id}/recalculate/${encodeURIComponent(requestId)}`);
        if (!result?.queued || result.completed) {
            return result;
        }
    }

    return {
        success: false,
        queued: true,
        completed: false,
        requestId,
        error: '等待画像重算结果超时，请稍后刷新页面确认状态',
    };
}

window.recalculateProfile = async function (id) {
    try {
        const result = await API.post(`/api/profiles/${id}/recalculate`, {});
        if (result?.error) {
            alert('重算画像失败: ' + result.error);
            return;
        }

        let settled = result;
        if (result?.queued && !result.completed && result.requestId) {
            alert(result.message || '画像重算已提交给 genesis-agent，正在后台执行');
            settled = await pollProfileRecalculate(id, result.requestId);
        }

        if (settled?.error) {
            alert('重算画像失败: ' + settled.error);
            return;
        }

        if (settled?.profile) {
            profileModalState = { profile: settled.profile, manualOnly: false };
            renderProfileModal();
        }
        await loadProfiles();

        if (result?.queued && !result.completed && result.requestId) {
            alert(settled?.message || '画像重算已完成');
        } else if (settled?.agentSync && settled.agentSync.applied === false) {
            alert(settled.message || '画像已重算，但 genesis-agent 同步失败');
        }
    } catch (e) {
        alert('重算画像失败: ' + e.message);
    }
};

window.deleteProfile = async function (id) {
    if (!confirm('确定删除此用户画像？不可恢复。')) return;
    try {
        const result = await API.del(`/api/profiles/${id}`);
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '删除失败');
        }
        profileModalState = null;
        closeModals();
        await loadProfiles();
        if (result?.agentSync && result.agentSync.applied === false) {
            alert(result.message || '画像已删除，但 genesis-agent 同步失败');
        }
    } catch (e) {
        alert('删除画像失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.deleteAllProfiles = async function () {
    const warning = '这会删除所有用户画像，包括人工维护的长期档案、偏好、记忆和冲突记录，且不可恢复。确定继续吗？';
    if (!confirm(warning)) return;

    try {
        const result = await API.del('/api/profiles');
        profileModalState = null;
        closeModals();
        await loadProfiles();
        if (result?.agentSync && result.agentSync.applied === false) {
            alert(result.message || `已删除 ${result.deletedCount || 0} 条画像记录，但 genesis-agent 同步失败`);
            return;
        }
        alert(`已删除 ${result.deletedCount || 0} 条画像记录。`);
    } catch (e) {
        alert('删除全部画像失败: ' + e.message);
    }
};

// Knowledge
async function loadKnowledge() {
    try {
        const list = await API.get('/api/knowledge');
        let container = document.querySelector('#table-knowledge');
        if (container) {
            container = container.closest('.table-container');
        } else {
            const grid = document.getElementById('knowledge-grid');
            if (grid) {
                grid.innerHTML = list.map(k => renderKnowledgeCard(k)).join('');
                return;
            }
            const page = document.getElementById('page-knowledge');
            container = page.querySelector('.table-container');
        }

        // Replace table container with grid container if not already done
        if (container) {
            const grid = document.createElement('div');
            grid.className = 'knowledge-grid';
            grid.id = 'knowledge-grid';
            container.parentNode.replaceChild(grid, container);
        }

        const grid = document.getElementById('knowledge-grid');
        if (!grid) return;

        grid.innerHTML = list.map(k => renderKnowledgeCard(k)).join('');
    } catch (e) { console.error('Load knowledge failed', e); }
}

function renderKnowledgeCard(k) {
    const category = k.category ? `<span class="badge badge-success">${Utils.escapeHtml(k.category)}</span>` : '';
    const date = new Date(k.createdAt).toLocaleDateString();
    const knowledgeIdArg = encodeInlineJsString(k.id);

    return `
    <div class="knowledge-card">
        <div class="knowledge-header">
            <div style="display:flex;gap:8px;align-items:center;">
                <span class="badge badge-neutral">${Utils.escapeHtml(k.source || 'Unknown')}</span>
                ${category}
            </div>
            <div class="knowledge-id">${k.id.split('_').pop()}</div>
        </div>
        
        <div class="knowledge-text" title="${Utils.escapeHtml(k.text)}">
            ${Utils.escapeHtml(k.text)}
        </div>

        <div class="knowledge-meta">
            <span class="knowledge-meta-item">📅 ${date}</span>
            <div class="knowledge-actions">
                <button class="btn btn-sm btn-danger" onclick="window.deleteKnowledge(${knowledgeIdArg})">删除</button>
                <button class="btn btn-sm btn-primary" onclick="window.viewKnowledge(${knowledgeIdArg})">编辑</button>
            </div>
        </div>
    </div>`;
}

window.viewKnowledge = async function (id) {
    let data = { text: '', source: 'Manual', category: '' };
    let isEdit = false;

    if (id) {
        try {
            data = await API.get(`/api/knowledge/${id}`);
            isEdit = true;
        } catch (e) { return alert('加载失败: ' + e.message); }
    }

    const body = document.querySelector('#modal-knowledge .modal-body');
    // Overwrite modal content
    body.innerHTML = `
        <div class="form-group">
            <label class="form-label">来源 Source</label>
            <input class="form-input" id="k-source" value="${Utils.escapeHtml(data.source)}">
        </div>
        <div class="form-group">
            <label class="form-label">分类 Category</label>
            <input class="form-input" id="k-category" value="${Utils.escapeHtml(data.category || '')}" placeholder="可选，例如: Anime, Tech...">
        </div>
        <div class="form-group">
            <label class="form-label">内容 Content</label>
            <textarea class="form-input form-textarea" id="k-text" style="height:300px;">${Utils.escapeHtml(data.text)}</textarea>
        </div>
    `;

    const footer = document.querySelector('#modal-knowledge .modal-footer');
    const knowledgeIdArg = encodeInlineJsString(id || '');
    footer.innerHTML = `
        <button class="btn" onclick="window.closeModals()">取消</button>
        <button class="btn btn-primary" onclick="window.saveKnowledge(${knowledgeIdArg})">${isEdit ? '保存修改' : '立即添加'}</button>
    `;

    // Attempt to update title
    const titleEl = document.querySelector('#modal-knowledge .modal-header');
    if (titleEl) {
        // Keep potential close button if it exists, tough to know structure. 
        // We'll just prepend/update text node?
        // Safest: set innerHTML with a close button if needed, or just text?
        // Let's assume generic header text.
        // If we inspect modal-profile (step 3249 line 161), card-header is flex.
        // Modal header usually has text and close icon.
        // I will just ignore title update to avoid breaking structure, OR assume text is in first child span?
        // Let's rely on context: User didn't ask for perfect title behavior, just functionality. 
        // But "Edit" button opening "Add Knowledge" title is confusing.
        // I'll try to set innerHTML safely.
        titleEl.innerHTML = `<span>${isEdit ? '编辑知识' : '添加知识'}</span><div style="cursor:pointer;" onclick="window.closeModals()">×</div>`;
    }

    openModal('modal-knowledge');
};

window.openAddKnowledgeModal = function () {
    window.viewKnowledge(null);
}

window.saveKnowledge = async function (id) {
    const text = document.getElementById('k-text').value;
    const source = document.getElementById('k-source').value;
    const category = document.getElementById('k-category').value;

    if (!text) return alert('请输入内容');

    try {
        let result;
        if (id) {
            result = await API.put(`/api/knowledge/${id}`, { text, source, category });
        } else {
            result = await API.post('/api/knowledge', { text, source, category });
        }
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '保存失败');
        }
        closeModals();
        await loadKnowledge();
    } catch (e) {
        alert('操作失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.deleteKnowledge = async function (id) {
    if (!confirm('确定删除此条目？')) return;
    try {
        const result = await API.del(`/api/knowledge/${id}`);
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '删除失败');
        }
        await loadKnowledge();
    } catch (e) {
        alert('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

// Meme Packs
async function loadMemes() {
    try {
        const [memeResult, runtimeResult] = await Promise.allSettled([
            API.get('/api/memes'),
            API.get('/api/config'),
        ]);
        if (memeResult.status !== 'fulfilled') {
            throw memeResult.reason;
        }
        const result = memeResult.value;
        const runtimeConfig = runtimeResult.status === 'fulfilled' ? runtimeResult.value : null;
        const packs = Array.isArray(result?.packs) ? result.packs : [];
        const orphanFiles = Array.isArray(result?.orphanFiles) ? result.orphanFiles : [];
        const grid = document.getElementById('memes-pack-grid');
        const meta = document.getElementById('memes-meta-info');
        const orphanPanel = document.getElementById('memes-orphan-panel');
        if (!grid || !meta) return;

        if (runtimeConfig) {
            populateMemeRuntimeForm(runtimeConfig);
        } else {
            const statusEl = document.getElementById('meme-runtime-status');
            if (statusEl) {
                statusEl.textContent = '自动发表情配置读取失败，请稍后刷新后重试。';
            }
        }

        meta.textContent = `共 ${packs.length} 组 / ${Number(result?.totalFiles || 0)} 张图，孤儿文件 ${orphanFiles.length} 个，素材目录：${result?.sourceDir || '-'}，manifest：${result?.manifestPath || '-'}`;

        if (packs.length === 0) {
            grid.innerHTML = '<div class="stat-label">当前还没有表情包分组，先新建一个。</div>';
        } else {
            grid.innerHTML = packs.map(pack => renderMemePackCard(pack)).join('');
        }

        if (orphanPanel) {
            orphanPanel.innerHTML = orphanFiles.length > 0
                ? `
                    <div class="meme-orphan-title">未引用文件 ${orphanFiles.length} 个</div>
                    <div class="meme-pack-chips">
                        ${orphanFiles.map(file => `<span class="chip">${Utils.escapeHtml(file)}</span>`).join('')}
                    </div>
                `
                : '';
        }
    } catch (e) {
        console.error('Load memes failed', e);
        const grid = document.getElementById('memes-pack-grid');
        if (grid) {
            grid.innerHTML = '<div class="stat-label">表情包加载失败，请稍后重试。</div>';
        }
    }
}

function renderMemePackCard(pack) {
    const aliases = Array.isArray(pack.aliases) ? pack.aliases : [];
    const scenes = Array.isArray(pack.scenes) ? pack.scenes : [];
    const files = Array.isArray(pack.files) ? pack.files : [];
    const previews = Array.isArray(pack.previewUrls) ? pack.previewUrls : [];
    const description = String(pack.description || '').trim();
    const packIdArg = encodeInlineJsString(pack.id);

    return `
        <div class="meme-pack-card">
            <div class="meme-pack-header">
                <div>
                    <div class="meme-pack-title">${Utils.escapeHtml(pack.label || pack.id)}</div>
                    <div class="meme-pack-subtitle">${Utils.escapeHtml(pack.id)}</div>
                </div>
                <div class="meme-pack-actions">
                    <button class="btn btn-sm" onclick="window.openMemeModal(${packIdArg})">编辑</button>
                    <button class="btn btn-sm btn-danger" onclick="window.deleteMemePack(${packIdArg})">删除</button>
                </div>
            </div>
            <div class="meme-pack-meta">
                <span class="badge badge-neutral">weight ${Utils.escapeHtml(String(pack.weight ?? 1))}</span>
                <span class="badge badge-neutral">cooldown ${Utils.escapeHtml(String(pack.cooldownSec ?? 0))}s</span>
                <span class="badge badge-success">${files.length} 张</span>
            </div>
            ${description ? `<div class="meme-pack-description">${Utils.escapeHtml(description)}</div>` : ''}
            <div class="meme-pack-chips">
                ${aliases.map(item => `<span class="chip">${Utils.escapeHtml(item)}</span>`).join('')}
                ${scenes.map(item => `<span class="chip">${Utils.escapeHtml(item)}</span>`).join('')}
            </div>
            <div class="meme-pack-preview-grid">
                ${previews.slice(0, 6).map((url, index) => `<img class="meme-pack-preview" src="${Utils.escapeHtml(sanitizeImageSrc(url) || '')}" alt="${Utils.escapeHtml(files[index] || 'meme')}">`).join('')}
            </div>
        </div>
    `;
}

function renderMemeModal() {
    const body = document.getElementById('meme-modal-body');
    const title = document.getElementById('meme-modal-title');
    const footer = document.getElementById('meme-modal-footer');
    if (!body || !title || !footer) return;

    const pack = memeModalState.pack || {
        id: '',
        label: '',
        description: '',
        aliases: [],
        scenes: [],
        weight: 1,
        cooldownSec: 60,
        files: [],
        previewUrls: [],
    };
    const isEdit = memeModalState.mode === 'edit';
    title.textContent = isEdit ? `编辑表情包：${pack.label || pack.id}` : '新建表情包分组';

    body.innerHTML = `
        <div class="meme-form-grid">
            <div class="form-group">
                <label class="form-label">分组 ID</label>
                <input class="form-input" id="meme-pack-id" value="${Utils.escapeHtml(pack.id || '')}" placeholder="例如 angry_warning">
            </div>
            <div class="form-group">
                <label class="form-label">显示名称</label>
                <input class="form-input" id="meme-pack-label" value="${Utils.escapeHtml(pack.label || '')}" placeholder="例如 生气">
            </div>
            <div class="form-group">
                <label class="form-label">分组描述</label>
                <input class="form-input" id="meme-pack-description" value="${Utils.escapeHtml(pack.description || '')}" placeholder="例如 早晚安、招呼、拜拜这类日常用表情">
            </div>
            <div class="form-group">
                <label class="form-label">权重</label>
                <input class="form-input" id="meme-pack-weight" type="number" min="1" step="1" value="${Utils.escapeHtml(String(pack.weight ?? 1))}">
            </div>
            <div class="form-group">
                <label class="form-label">分组冷却（秒）</label>
                <input class="form-input" id="meme-pack-cooldown" type="number" min="0" step="1" value="${Utils.escapeHtml(String(pack.cooldownSec ?? 60))}">
            </div>
        </div>
        <div class="meme-form-grid">
            <div class="form-group">
                <label class="form-label">别名（逗号分隔）</label>
                <input class="form-input" id="meme-pack-aliases" value="${Utils.escapeHtml((pack.aliases || []).join(', '))}" placeholder="生气, 警告, 别惹">
            </div>
            <div class="form-group">
                <label class="form-label">场景（逗号分隔）</label>
                <input class="form-input" id="meme-pack-scenes" value="${Utils.escapeHtml((pack.scenes || []).join(', '))}" placeholder="angry, owner">
            </div>
        </div>
        <div class="meme-editor-section">
            <div class="meme-editor-toolbar">
                <div>
                    <div class="card-title">压缩包导入</div>
                    <div class="stat-label">支持 zip / rar / 7z，一次把整包图片导入当前分组。</div>
                </div>
                <input type="file" id="meme-archive-input" accept=".zip,.rar,.7z,.tar,.gz,.tgz" onchange="window.handleMemeArchiveSelected(event)">
            </div>
            <div class="stat-label" id="meme-archive-hint">${memeModalState.archiveFile ? `已选择压缩包：${Utils.escapeHtml(memeModalState.archiveFile.name)}` : '未选择压缩包；直接保存只更新分组配置。'}</div>
        </div>
        ${isEdit ? `
            <div class="meme-editor-section">
                <div class="meme-editor-toolbar">
                    <div>
                        <div class="card-title">图片管理</div>
                        <div class="stat-label">支持一次选多张，直接写入素材目录并更新 manifest。</div>
                    </div>
                    <input type="file" id="meme-upload-input" accept="image/*" multiple onchange="window.handleMemeFileUpload(event)">
                </div>
                <div class="meme-file-grid">
                    ${(pack.files || []).map((file, index) => `
                        <div class="meme-file-card">
                            <img class="meme-file-preview" src="${Utils.escapeHtml(sanitizeImageSrc(pack.previewUrls?.[index] || '') || '')}" alt="${Utils.escapeHtml(file)}">
                            <div class="meme-file-name">${Utils.escapeHtml(file)}</div>
                            <button class="btn btn-sm btn-danger" onclick="window.deleteMemeFile(${encodeInlineJsString(pack.id)}, ${encodeInlineJsString(file)})">删除图片</button>
                        </div>
                    `).join('') || '<div class="stat-label">当前分组还没有图片，先上传几张。</div>'}
                </div>
            </div>
        ` : '<div class="stat-label">先保存分组，再上传图片。</div>'}
    `;

    footer.innerHTML = `
        <button class="btn" onclick="window.closeModals()">取消</button>
        <button class="btn btn-primary" onclick="window.saveMemePack()">${isEdit ? '保存修改' : '创建分组'}</button>
    `;
}

function parseCsvInput(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

window.openMemeModal = async function (id) {
    try {
        if (!id) {
            memeModalState = {
                mode: 'create',
                originalId: '',
                pack: null,
                archiveFile: null,
            };
        } else {
            const result = await API.get('/api/memes');
            const packs = Array.isArray(result?.packs) ? result.packs : [];
            const pack = packs.find(item => item.id === id);
            if (!pack) {
                throw new Error('表情包分组不存在');
            }
            memeModalState = {
                mode: 'edit',
                originalId: id,
                pack,
                archiveFile: null,
            };
        }
        renderMemeModal();
        openModal('modal-meme');
    } catch (e) {
        alert('打开表情包编辑器失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.saveMemePack = async function () {
    const payload = {
        id: document.getElementById('meme-pack-id')?.value?.trim() || '',
        label: document.getElementById('meme-pack-label')?.value?.trim() || '',
        description: document.getElementById('meme-pack-description')?.value?.trim() || '',
        aliases: parseCsvInput(document.getElementById('meme-pack-aliases')?.value),
        scenes: parseCsvInput(document.getElementById('meme-pack-scenes')?.value),
        weight: Number(document.getElementById('meme-pack-weight')?.value || 1),
        cooldownSec: Number(document.getElementById('meme-pack-cooldown')?.value || 60),
    };
    const archiveFile = document.getElementById('meme-archive-input')?.files?.[0] || null;

    try {
        if (archiveFile) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`读取压缩包失败: ${archiveFile.name}`));
                reader.readAsDataURL(archiveFile);
            });
            const result = await API.post('/api/memes/import-archive', {
                ...payload,
                id: payload.id || memeModalState.originalId,
                name: archiveFile.name,
                dataUrl,
            });
            memeModalState = {
                mode: 'edit',
                originalId: result?.pack?.id || payload.id,
                pack: result?.pack || { ...payload, files: [], previewUrls: [] },
                archiveFile: null,
            };
            renderMemeModal();
        } else if (memeModalState.mode === 'edit') {
            const result = await API.put(`/api/memes/${encodeURIComponent(memeModalState.originalId)}`, payload);
            memeModalState = {
                mode: 'edit',
                originalId: result?.pack?.id || payload.id,
                pack: result?.pack || { ...payload, files: [], previewUrls: [] },
                archiveFile: null,
            };
            renderMemeModal();
        } else {
            const result = await API.post('/api/memes', payload);
            memeModalState = {
                mode: 'edit',
                originalId: result?.pack?.id || payload.id,
                pack: result?.pack || { ...payload, files: [], previewUrls: [] },
                archiveFile: null,
            };
            renderMemeModal();
        }
        await loadMemes();
    } catch (e) {
        alert('保存表情包分组失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.deleteMemePack = async function (id) {
    if (!confirm(`确定删除表情包分组 ${id}？这只会删除 manifest 中的分组，不会自动删素材目录里的其他文件。`)) return;
    try {
        await API.del(`/api/memes/${encodeURIComponent(id)}`);
        if (memeModalState.originalId === id) {
            closeModals();
        }
        await loadMemes();
    } catch (e) {
        alert('删除表情包分组失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.handleMemeFileUpload = async function (event) {
    const files = Array.from(event?.target?.files || []);
    if (!files.length || !memeModalState.originalId) return;

    try {
        for (const file of files) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
                reader.readAsDataURL(file);
            });
            const result = await API.post(`/api/memes/${encodeURIComponent(memeModalState.originalId)}/files`, {
                name: file.name,
                dataUrl,
            });
            memeModalState.pack = result?.pack || memeModalState.pack;
            memeModalState.originalId = result?.pack?.id || memeModalState.originalId;
        }
        renderMemeModal();
        await loadMemes();
        event.target.value = '';
    } catch (e) {
        alert('上传表情图片失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.deleteMemeFile = async function (packId, fileName) {
    if (!confirm(`确定删除图片 ${fileName}？`)) return;
    try {
        const result = await API.del(`/api/memes/${encodeURIComponent(packId)}/files/${encodeURIComponent(fileName)}`);
        memeModalState.pack = result?.pack || memeModalState.pack;
        renderMemeModal();
        await loadMemes();
    } catch (e) {
        alert('删除图片失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.reloadMemeCatalog = async function () {
    try {
        await API.post('/api/memes/reload', {});
        await loadMemes();
    } catch (e) {
        alert('重载表情包配置失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.handleMemeArchiveSelected = function (event) {
    memeModalState.archiveFile = event?.target?.files?.[0] || null;
    const hint = document.getElementById('meme-archive-hint');
    if (hint) {
        hint.textContent = memeModalState.archiveFile
            ? `已选择压缩包：${memeModalState.archiveFile.name}`
            : '未选择压缩包；直接保存只更新分组配置。';
    }
};

window.cleanupMemeOrphans = async function () {
    if (!confirm('确定清理当前素材目录里未被 manifest 引用的孤儿文件？')) return;
    try {
        const result = await API.post('/api/memes/cleanup-orphans', {});
        alert(result?.deletedCount > 0 ? `已清理 ${result.deletedCount} 个孤儿文件` : '没有需要清理的孤儿文件');
        await loadMemes();
    } catch (e) {
        alert('清理孤儿文件失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

// Blacklist
async function loadBlacklist() {
    const blacklistBody = document.querySelector('#table-blacklist tbody');
    const whitelistBody = document.querySelector('#table-whitelist tbody');
    const resolveDeleteId = (item) => encodeURIComponent(item.ruleId || String(item.id));
    const row = (item, type) => `<tr>
        <td>${item.type === 'user' ? '👤 私聊用户' : '👥 群聊群组'} ${Utils.escapeHtml(String(item.targetId ?? ''))}</td>
        <td>${Utils.escapeHtml(item.reason)}</td>
        <td><button class="btn btn-sm btn-danger" onclick="window.delBlacklist(${encodeInlineJsString(resolveDeleteId(item))}, ${encodeInlineJsString(type)})">移除</button></td>
    </tr>`;

    try {
        const d = await API.get('/api/blacklist');
        if (blacklistBody) {
            blacklistBody.innerHTML = d.blacklist.map(i => row(i, 'black')).join('');
        }
        if (whitelistBody) {
            whitelistBody.innerHTML = d.whitelist.map(i => row(i, 'white')).join('');
        }
    } catch (e) {
        console.error('Load blacklist failed', e);
        const errorRow = '<tr><td colspan="3" style="text-align:center;color:var(--text-sub);">名单加载失败，请稍后重试</td></tr>';
        if (blacklistBody) {
            blacklistBody.innerHTML = errorRow;
        }
        if (whitelistBody) {
            whitelistBody.innerHTML = errorRow;
        }
    }
}

// Context Memory
async function loadContext() {
    try {
        const list = await API.get('/api/context');
        // DEBUG: Alert content
        // alert(`Debug: API returned ${list.length} sessions`);

        const tbody = document.querySelector('#table-context tbody');
        if (!tbody) return;

        if (!Array.isArray(list)) {
            alert('API返回格式错误: ' + JSON.stringify(list));
            return;
        }

        tbody.replaceChildren();
        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#666;">暂无活跃会话 (No Active Sessions)</td></tr>';
            return;
        }

        for (const item of list) {
            const row = document.createElement('tr');

            const keyCell = document.createElement('td');
            keyCell.style.fontFamily = 'monospace';
            keyCell.style.fontSize = '12px';
            keyCell.textContent = String(item.key || '');

            const countCell = document.createElement('td');
            const countBadge = document.createElement('span');
            countBadge.className = 'badge badge-neutral';
            countBadge.textContent = String(item.count ?? 0);
            countCell.appendChild(countBadge);

            const timeCell = document.createElement('td');
            timeCell.textContent = item.lastActivity
                ? new Date(item.lastActivity > 1e11 ? item.lastActivity : item.lastActivity * 1000).toLocaleString()
                : '-';

            const actionCell = document.createElement('td');
            const viewButton = document.createElement('button');
            viewButton.className = 'btn btn-sm btn-primary';
            viewButton.textContent = '查看';
            viewButton.addEventListener('click', () => {
                window.viewContext(String(item.key || ''));
            });

            const clearButton = document.createElement('button');
            clearButton.className = 'btn btn-sm btn-danger';
            clearButton.textContent = '清除';
            clearButton.addEventListener('click', () => {
                window.clearContext(String(item.key || ''));
            });

            actionCell.append(viewButton, clearButton);
            row.append(keyCell, countCell, timeCell, actionCell);
            tbody.appendChild(row);
        }
    } catch (e) {
        console.error('Load context error', e);
        alert('Load context error: ' + e.message);
    }
}

window.viewContext = async function (key) {
    try {
        const encodedKey = encodeURIComponent(key);
        const messages = await API.get(`/api/context/${encodedKey}`);

        // 获取 Bot QQ 号用于判断 [Bot] 标签
        let botQQ = null;
        try {
            const configData = await API.get('/api/config');
            botQQ = configData.botQQ;
        } catch (e) { /* ignore */ }

        const container = document.getElementById('context-messages');
        if (!container) return;

        container.innerHTML = messages.map(msg => {
            const time = new Date(msg.time * 1000).toLocaleString();
            const sender = msg.sender_name || msg.sender_id;
            const safeSender = Utils.escapeHtml(sender || '');
            const safeSenderId = Utils.escapeHtml(msg.sender_id || '');
            let content = Utils.escapeHtml(msg.text || '');

            // 替换 @QQ 为 @昵称(QQ)
            if (msg.at_users_details && msg.at_users_details.length > 0) {
                const details = [...msg.at_users_details].sort((a, b) => String(b.id).length - String(a.id).length);
                for (const u of details) {
                    const name = u.card || u.name || String(u.id);
                    const regex = new RegExp(`@${u.id}(?![0-9])`, 'g');
                    const replacement = `@${Utils.escapeHtml(name)}(${u.id})`;
                    content = content.replace(regex, replacement);
                }
            }
            if (msg.images?.length) content += ` <span class="badge badge-neutral">[Image x${msg.images.length}]</span>`;
            if (msg.reply) {
                const replySender = msg.reply.sender_name || msg.reply.sender_id || '未知';
                const replyId = msg.reply.sender_id || '';
                const safeReplySender = Utils.escapeHtml(replySender);
                const safeReplyId = Utils.escapeHtml(replyId);
                const replyText = Utils.escapeHtml(msg.reply.text?.slice(0, 20) || '');
                // 引用时间戳（含日期）
                const replyTime = msg.reply.time
                    ? new Date(msg.reply.time * 1000).toLocaleString('zh-CN', {
                        month: 'numeric', day: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                    })
                    : '';
                const timePrefix = replyTime ? `[${replyTime}]` : '';

                // 引用消息的媒体文件
                const replyMedia = [];
                if (msg.reply.media) {
                    const m = msg.reply.media;
                    if (m.images?.length) replyMedia.push(m.images.length > 1 ? `[图x${m.images.length}]` : '[图]');
                    if (m.videos?.length) replyMedia.push(m.videos.length > 1 ? `[视频x${m.videos.length}]` : '[视频]');
                    if (m.records?.length) replyMedia.push(m.records.length > 1 ? `[语音x${m.records.length}]` : '[语音]');
                    if (m.files?.length) replyMedia.push(m.files.length > 1 ? `[文件x${m.files.length}]` : '[文件]');
                }
                const mediaStr = replyMedia.length > 0 ? ` ${replyMedia.join(' ')}` : '';
                const textPart = replyText ? `"${replyText}"` : '';
                content = `<div style="opacity:0.6;font-size:12px;">↩️ ${timePrefix}[${safeReplySender}(${safeReplyId}): ${textPart}${mediaStr}]</div>` + content;
            }

            // 判断是否是 Bot 消息
            const isBot = botQQ && msg.sender_id === botQQ;

            let roleStr = '';
            if (isBot) roleStr += '<span class="badge badge-primary" style="margin-right:4px;font-size:10px;">Bot</span>';
            if (msg.sender_role === 'owner') roleStr += '<span class="badge badge-warning" style="margin-right:4px;font-size:10px;">群主</span>';
            else if (msg.sender_role === 'admin') roleStr += '<span class="badge badge-success" style="margin-right:4px;font-size:10px;">管理员</span>';

            return `
            <div style="margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px;">
                <div style="color: #8b949e; margin-bottom: 4px;">[${Utils.escapeHtml(time)}] ${roleStr}${safeSender} (${safeSenderId})</div>
                <div style="color: #e6edf3; white-space: pre-wrap;">${content}</div>
            </div>`;
        }).join('');

        document.getElementById('btn-clear-context').onclick = () => window.clearContext(key, true);
        openModal('modal-context');
    } catch (e) {
        alert('Load session failed: ' + e.message);
    }
};

window.clearContext = async function (key, close = false) {
    if (!confirm(`确定清除会话 ${key} 的记忆？`)) return;
    try {
        const result = await API.del(`/api/context/${encodeURIComponent(key)}`);
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '清除失败');
        }
        if (close) closeModals();
        await loadContext();
        if (result?.agentSync && result.agentSync.applied === false) {
            alert(result.message || '会话记忆已清除，但 genesis-agent 同步失败');
        }
    } catch (e) {
        alert('清除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.clearAllContext = async function () {
    if (!confirm('确定清除所有短期记忆？此操作不可恢复！')) return;
    try {
        const result = await API.del('/api/context');
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '清除失败');
        }
        await loadContext();
        if (result?.agentSync && result.agentSync.applied === false) {
            alert(result.message || '已清除全部会话记忆，但 genesis-agent 同步失败');
        }
    } catch (e) {
        alert('清除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.addBlacklist = async function () {
    const targetId = document.getElementById('bl-target').value;
    if (!targetId) return;
    try {
        const result = await API.post('/api/blacklist', {
            type: document.getElementById('bl-type').value,
            targetId,
            reason: document.getElementById('bl-reason').value,
            listType: document.getElementById('bl-list').value
        });
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '添加失败');
        }
        await loadBlacklist();
        if (result?.duplicate && result?.message) {
            alert(result.message);
        }
        if (result?.adapterSync && result.adapterSync.applied === false) {
            alert(result.message || '规则已保存，但 NapCat 适配器同步失败');
        }
    } catch (e) {
        alert('添加失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.delBlacklist = async function (id, type) {
    try {
        const result = await API.del(`/api/blacklist/${id}?listType=${type}`);
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '移除失败');
        }
        await loadBlacklist();
        if (result?.adapterSync && result.adapterSync.applied === false) {
            alert(result.message || '规则已保存，但 NapCat 适配器同步失败');
        }
    } catch (e) {
        alert('移除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

// ================== Tasks Management ==================

let currentTaskList = [];

async function loadTasks() {
    try {
        // 加载任务统计
        const stats = await API.get('/api/tasks/stats');
        document.getElementById('task-stat-total').innerText = stats.total || 0;
        document.getElementById('task-stat-pending').innerText = stats.byStatus?.pending || 0;
        document.getElementById('task-stat-running').innerText = stats.byStatus?.running || 0;
        document.getElementById('task-stat-success').innerText = stats.byStatus?.success || 0;
        document.getElementById('task-stat-failed').innerText = (stats.byStatus?.failed || 0) + (stats.byStatus?.timeout || 0);

        // 计算平均耗时
        const avgTime = stats.avgDuration ? `${Math.round(stats.avgDuration)}ms` : '-';
        document.getElementById('task-stat-avgtime').innerText = avgTime;

        // 加载任务列表
        const tasks = await API.get('/api/tasks');
        currentTaskList = Array.isArray(tasks) ? tasks : [];

        // 应用筛选
        const filterStatus = document.getElementById('task-filter-status').value;
        let filteredTasks = currentTaskList;
        if (filterStatus) {
            filteredTasks = currentTaskList.filter(t => t.status === filterStatus);
        }

        renderTaskTable(filteredTasks);
    } catch (e) {
        console.error('Load tasks failed', e);
    }
}

function renderTaskTable(tasks) {
    const tbody = document.querySelector('#table-tasks tbody');
    if (!tbody) return;

    if (tasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sub);padding:40px;">暂无任务</td></tr>';
        return;
    }

    tbody.innerHTML = tasks.map(task => {
        const statusBadge = getTaskStatusBadge(task.status);
        const priorityBadge = getTaskPriorityBadge(task.priority);
        const duration = task.finishedAt
            ? `${task.finishedAt - task.startedAt}ms`
            : (task.startedAt ? `${Date.now() - task.startedAt}ms` : '-');
        const createdTime = new Date(task.createdAt).toLocaleTimeString();

        const canCancel = task.status === 'pending' || task.status === 'running';

        return `
            <tr class="hover-row">
                <td style="font-family:var(--font-mono);font-size:12px;">${task.id.slice(0, 8)}</td>
                <td><span style="font-weight:600;color:var(--accent);">${Utils.escapeHtml(task.toolName)}</span></td>
                <td>${task.userId || '-'}</td>
                <td>${statusBadge}</td>
                <td>${priorityBadge}</td>
                <td style="font-family:var(--font-mono);color:var(--text-sub);">${createdTime}</td>
                <td style="font-family:var(--font-mono);">${duration}</td>
                <td>
                    <button class="btn btn-sm" data-task-action="view-detail" data-task-id="${Utils.escapeHtml(task.id)}">查看</button>
                    ${canCancel ? `<button class="btn btn-sm btn-danger" data-task-action="cancel" data-task-id="${Utils.escapeHtml(task.id)}">取消</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

function getTaskStatusBadge(status) {
    const map = {
        'pending': '<span class="badge badge-neutral">⏳ 等待中</span>',
        'running': '<span class="badge badge-warning">🔄 执行中</span>',
        'success': '<span class="badge badge-success">✅ 成功</span>',
        'failed': '<span class="badge badge-error">❌ 失败</span>',
        'timeout': '<span class="badge badge-error">⏱️ 超时</span>',
        'cancelled': '<span class="badge badge-neutral">🚫 已取消</span>',
    };
    return map[status] || `<span class="badge">${Utils.escapeHtml(String(status || '未知'))}</span>`;
}

function getTaskPriorityBadge(priority) {
    const map = {
        'high': '<span style="color:#f85149;">🔴 高</span>',
        'normal': '<span style="color:#58a6ff;">🔵 中</span>',
        'low': '<span style="color:#8b949e;">⚪ 低</span>',
    };
    return map[priority] || Utils.escapeHtml(String(priority || '-'));
}

window.refreshTasks = function () {
    loadTasks();
};

window.viewTaskDetail = async function (taskId) {
    try {
        const task = await API.get(`/api/tasks/${taskId}`);
        if (!task) {
            alert('任务不存在');
            return;
        }

        document.getElementById('task-detail-id').innerText = taskId.slice(0, 8);
        document.getElementById('task-detail-tool').innerText = task.toolName;
        document.getElementById('task-detail-user').innerText = task.userId || '-';
        document.getElementById('task-detail-status').innerHTML = getTaskStatusBadge(task.status);
        document.getElementById('task-detail-priority').innerHTML = getTaskPriorityBadge(task.priority);
        document.getElementById('task-detail-created').innerText = new Date(task.createdAt).toLocaleString();

        const duration = task.finishedAt
            ? `${task.finishedAt - task.startedAt}ms`
            : (task.startedAt ? `${Date.now() - task.startedAt}ms (进行中)` : '-');
        document.getElementById('task-detail-duration').innerText = duration;

        // 参数
        try {
            document.getElementById('task-detail-params').innerText = JSON.stringify(task.params || {}, null, 2);
        } catch (e) {
            document.getElementById('task-detail-params').innerText = String(task.params);
        }

        // 结果
        if (task.result) {
            document.getElementById('task-detail-result').innerText =
                typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2);
        } else {
            document.getElementById('task-detail-result').innerText = '(暂无结果)';
        }

        // 错误信息
        const errorSection = document.getElementById('task-detail-error-section');
        if (task.error) {
            errorSection.style.display = 'block';
            document.getElementById('task-detail-error').innerText = task.error;
        } else {
            errorSection.style.display = 'none';
        }

        // 取消按钮
        const cancelBtn = document.getElementById('btn-cancel-task');
        if (task.status === 'pending' || task.status === 'running') {
            cancelBtn.style.display = 'inline-block';
            cancelBtn.onclick = () => cancelTask(taskId);
        } else {
            cancelBtn.style.display = 'none';
        }

        openModal('modal-task');
    } catch (e) {
        console.error('View task detail failed', e);
        alert('获取任务详情失败: ' + e.message);
    }
};

window.cancelTask = async function (taskId) {
    if (!confirm('确定要取消这个任务吗？')) return;

    try {
        const result = await API.post(`/api/tasks/${taskId}/cancel`);
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '取消失败');
        }
        closeModals();
        await loadTasks();
        alert(result.message || '任务已取消');
    } catch (e) {
        alert('取消任务失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

// 筛选器变化时重新加载
document.getElementById('task-filter-status')?.addEventListener('change', loadTasks);

// Logs
let logSocket = null;
let logReconnectTimer = null;
let logPollingTimer = null;
let logLastTimestamp = 0;
let logLastFingerprint = '';

function getLogTerminal() {
    return document.getElementById('log-terminal');
}

function getLogStatusBadge() {
    return document.getElementById('connection-status');
}

function setLogStatus(mode) {
    const status = getLogStatusBadge();
    if (!status) return;

    if (mode === 'online') {
        status.innerText = '🟢 在线 Online';
        status.className = 'badge badge-success';
        return;
    }

    if (mode === 'polling') {
        status.innerText = '🟡 轮询 Polling';
        status.className = 'badge badge-warning';
        return;
    }

    status.innerText = '🔴 离线 Offline';
    status.className = 'badge badge-error';
}

function appendLogLine(entry) {
    const term = getLogTerminal();
    if (!term || !entry) return;

    const msg = typeof entry.message === 'string' ? entry.message : '';
    const time = typeof entry.time === 'number' ? entry.time : Date.now();
    const levelRaw = typeof entry.level === 'string' ? entry.level : 'INFO';
    const level = levelRaw.toUpperCase();
    const fingerprint = `${time}:${level}:${msg}`;
    if (fingerprint === logLastFingerprint) {
        return;
    }
    logLastFingerprint = fingerprint;
    logLastTimestamp = Math.max(logLastTimestamp, time);

    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = `<span class="log-time">${new Date(time).toLocaleTimeString()}</span><span class="LOG-${level}">[${level}]</span> ${Utils.escapeHtml(msg)}`;
    term.appendChild(line);
    term.scrollTop = term.scrollHeight;
    while (term.children.length > 500) {
        term.removeChild(term.firstChild);
    }
}

async function fetchSystemLogs(options = {}) {
    const params = new URLSearchParams();
    if (options.initial) {
        params.set('limit', '120');
    } else if (logLastTimestamp > 0) {
        params.set('since', String(logLastTimestamp));
        params.set('limit', '120');
    }
    const query = params.toString();
    const data = await API.get(`/api/system/logs${query ? `?${query}` : ''}`);
    return Array.isArray(data?.logs) ? data.logs : [];
}

async function pollSystemLogs(initial = false) {
    const logs = await fetchSystemLogs({ initial });
    logs.forEach(appendLogLine);
}

function stopLogPolling() {
    if (logPollingTimer) {
        clearInterval(logPollingTimer);
        logPollingTimer = null;
    }
}

function scheduleLogReconnect(delayMs = 10000) {
    if (logReconnectTimer) return;
    logReconnectTimer = setTimeout(() => {
        logReconnectTimer = null;
        initLogs();
    }, delayMs);
}

function startLogPolling() {
    if (logPollingTimer) return;

    setLogStatus('polling');
    pollSystemLogs(logLastTimestamp === 0).catch((e) => {
        console.error('Initial system log polling failed', e);
        setLogStatus('offline');
    });

    logPollingTimer = setInterval(async () => {
        try {
            await pollSystemLogs(false);
            setLogStatus('polling');
        } catch (e) {
            console.error('Poll system logs failed', e);
            setLogStatus('offline');
        }
    }, 3000);
}

function initLogs() {
    if (logSocket && (logSocket.readyState === WebSocket.OPEN || logSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const wsUrl = new URL(getAppUrl('/ws/logs'), window.location.origin);
    wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl.toString());
    logSocket = ws;
    const term = getLogTerminal();

    ws.onopen = () => {
        stopLogPolling();
        setLogStatus('online');
        if (term) {
            term.innerHTML += '<div class="log-line">> Connection established.</div>';
        }
    };
    ws.onmessage = (e) => {
        const d = Utils.safeParseJson(e.data);
        if (!d || typeof d !== 'object') return;
        appendLogLine(d);
    };
    ws.onerror = (e) => {
        console.error('System log websocket failed', e);
    };
    ws.onclose = () => {
        if (logSocket === ws) {
            logSocket = null;
        }
        startLogPolling();
        scheduleLogReconnect(15000);
    };
}

// ==================== LLM Logs ====================

// Global variable to store current LLM logs for modal access
let currentLlmLogs = [];
let currentLlmLogViewMode = 'flat';
let currentLlmLogGroupMode = 'family';

function classifyExplicitLlmCaller(caller) {
    const value = String(caller || 'unknown');
    if (!value || value === 'unknown') return null;
    if (value.startsWith('router')) return { key: 'router', label: 'Router', hint: value };
    if (value.startsWith('sentry')) return { key: 'sentry', label: 'Sentry', hint: value };
    if (value.startsWith('persona_loader')) return { key: 'persona_loader', label: 'Persona Loader', hint: value };
    if (value.startsWith('persona')) return { key: 'persona', label: 'Persona', hint: value };
    if (value.startsWith('profiler')) return { key: 'profiler', label: 'Profiler', hint: value };
    if (value.startsWith('ReActAgent') || value.startsWith('react_')) return { key: 'react', label: 'ReAct', hint: value };
    if (value.startsWith('tech_')) return { key: 'tech', label: 'Tech', hint: value };
    if (value.startsWith('auto-meme')) return { key: 'auto_meme', label: 'Auto Meme', hint: value };
    if (value.startsWith('create_skill') || value.startsWith('manage_skill')) return { key: 'skill_tooling', label: 'Skill Tooling', hint: value };
    return { key: value, label: value, hint: value };
}

function inferUnknownLlmCallerGroup(log) {
    const messages = Array.isArray(log?.request?.messages) ? log.request.messages : [];
    const systemContent = messages
        .filter(item => item && item.role === 'system' && typeof item.content === 'string')
        .map(item => item.content)
        .join('\n');

    if (systemContent.includes('用户画像分析专家') || systemContent.includes('根据上下文准确判断用户态度')) {
        return { key: 'profiler', label: 'Profiler', hint: 'unknown · 推测来自 Profiler' };
    }
    if (systemContent.includes('JSON 转换助手')) {
        return { key: 'persona_loader', label: 'Persona Loader', hint: 'unknown · 推测来自 Persona Loader' };
    }
    if (systemContent.includes('自动发表情包')) {
        return { key: 'auto_meme', label: 'Auto Meme', hint: 'unknown · 推测来自 Auto Meme' };
    }
    if (systemContent.includes('You write final image-generation prompts')) {
        return { key: 'self_draw_prompt', label: 'Self Draw Prompt', hint: 'unknown · 推测来自自画像 Prompt 生成' };
    }
    if (systemContent.includes('你是一个任务规划助手') || systemContent.includes('任务计划结构')) {
        return { key: 'router', label: 'Router', hint: 'unknown · 推测来自 Router' };
    }
    return { key: 'unknown', label: 'Unknown / 未归类', hint: 'unknown' };
}

function getLlmLogGroupMeta(log, mode = currentLlmLogGroupMode) {
    const rawCaller = String(log?.caller || 'unknown');
    if (mode === 'caller') {
        return {
            key: rawCaller || 'unknown',
            label: rawCaller || 'unknown',
            hint: rawCaller || 'unknown',
        };
    }

    const explicit = classifyExplicitLlmCaller(rawCaller);
    if (explicit) return explicit;
    return inferUnknownLlmCallerGroup(log);
}

function buildLlmStatusBadge(log) {
    return log.success
        ? `<span class="badge badge-success">Success</span>`
        : `<span class="badge badge-error">Fail</span>`;
}

function buildLlmLogTableRow(log, index) {
    const tokens = (log.response.input_tokens || 0) + (log.response.output_tokens || 0);
    const tokenStr = tokens > 0 ? tokens : '-';
    let modelName = log.model || '-';
    if (modelName.length > 25) {
        modelName = modelName.slice(0, 22) + '...';
    }
    const groupMeta = getLlmLogGroupMeta(log);
    const callerTitle = groupMeta.hint && groupMeta.hint !== log.caller
        ? `${Utils.escapeHtml(log.caller)}\n${Utils.escapeHtml(groupMeta.hint)}`
        : Utils.escapeHtml(log.caller);

    return `
        <tr class="hover-row">
            <td style="font-family:var(--font-mono);color:var(--text-sub);">${new Date(log.time).toLocaleTimeString()}</td>
            <td><span style="font-weight:600;color:var(--accent);" title="${callerTitle}">${Utils.escapeHtml(log.caller)}</span></td>
            <td><span class="badge badge-neutral" title="${Utils.escapeHtml(log.model)}">${Utils.escapeHtml(modelName)}</span></td>
            <td style="font-family:var(--font-mono);">${tokenStr}</td>
            <td style="font-family:var(--font-mono);">${log.duration}ms</td>
            <td>${buildLlmStatusBadge(log)}</td>
            <td>
                <button class="btn btn-sm btn-primary btn-view-llm" data-index="${index}">
                    详情 Detail
                </button>
            </td>
        </tr>
    `;
}

function buildGroupedLlmLogTable(logs) {
    const groups = [];
    const groupMap = new Map();

    logs.forEach((log, index) => {
        const meta = getLlmLogGroupMeta(log);
        if (!groupMap.has(meta.key)) {
            const group = { ...meta, items: [] };
            groupMap.set(meta.key, group);
            groups.push(group);
        }
        groupMap.get(meta.key).items.push({ log, index });
    });

    return groups.map(group => {
        const total = group.items.length;
        const success = group.items.filter(item => item.log.success).length;
        const avgDuration = total > 0
            ? Math.round(group.items.reduce((sum, item) => sum + (item.log.duration || 0), 0) / total)
            : 0;

        const header = `
            <tr style="background:rgba(255,255,255,0.03);">
                <td colspan="7" style="padding:12px 14px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
                        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                            <span style="font-weight:700;color:var(--accent);">${Utils.escapeHtml(group.label)}</span>
                            <span class="badge badge-neutral">${total} 条</span>
                            <span style="color:var(--text-sub);font-size:12px;">成功 ${success}/${total}</span>
                            <span style="color:var(--text-sub);font-size:12px;">平均 ${avgDuration}ms</span>
                        </div>
                        <div style="color:var(--text-sub);font-size:12px;">${Utils.escapeHtml(group.hint || group.label)}</div>
                    </div>
                </td>
            </tr>
        `;

        return header + group.items.map(({ log, index }) => buildLlmLogTableRow(log, index)).join('');
    }).join('');
}

function renderCurrentLlmLogs() {
    const tbody = document.querySelector('#table-llm-logs tbody');
    if (!tbody) return;

    if (currentLlmLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-sub);padding:40px;">暂无 LLM 调用记录</td></tr>';
        return;
    }

    if (currentLlmLogViewMode === 'grouped') {
        tbody.innerHTML = buildGroupedLlmLogTable(currentLlmLogs);
        return;
    }

    tbody.innerHTML = currentLlmLogs.map((log, index) => buildLlmLogTableRow(log, index)).join('');
}

function syncLlmLogViewControls() {
    const viewModeEl = document.getElementById('llm-log-view-mode');
    const groupModeEl = document.getElementById('llm-log-group-mode');
    if (viewModeEl) viewModeEl.value = currentLlmLogViewMode;
    if (groupModeEl) {
        groupModeEl.value = currentLlmLogGroupMode;
        groupModeEl.disabled = currentLlmLogViewMode !== 'grouped';
    }
}

window.onLlmLogViewOptionsChange = function onLlmLogViewOptionsChange() {
    currentLlmLogViewMode = document.getElementById('llm-log-view-mode')?.value || 'flat';
    currentLlmLogGroupMode = document.getElementById('llm-log-group-mode')?.value || 'family';
    syncLlmLogViewControls();
    renderCurrentLlmLogs();
};

// Load LLM logs
async function loadLlmLogs() {
    try {
        const data = await API.get('/api/llm/logs');
        const logs = data.logs || [];
        const stats = data.stats || {};
        currentLlmLogs = logs;

        // Update stats
        document.getElementById('llm-stat-total').innerText = stats.total || 0;
        const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
        document.getElementById('llm-stat-success').innerText = `${successRate}%`;
        document.getElementById('llm-stat-avgtime').innerText = `${stats.avgDuration || 0}ms`;
        document.getElementById('llm-stat-input-tokens').innerText = Utils.formatNumber(stats.totalInputTokens || 0);
        document.getElementById('llm-stat-output-tokens').innerText = Utils.formatNumber(stats.totalOutputTokens || 0);
        syncLlmLogViewControls();
        renderCurrentLlmLogs();
    } catch (e) { console.error('Load LLM logs failed', e); }
}

// Event Delegation for LLM Log Table
document.addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('.btn-view-llm') : null;
    if (btn) {
        const index = btn.dataset.index;
        showLlmDetail(index);
    }
});

// Show LLM log detail modal
function showLlmDetail(index) {
    const log = currentLlmLogs[index];
    if (!log) {
        console.error('[App] LLM log not found at index', index);
        return;
    }

    document.getElementById('llm-detail-id').innerText = log.id;
    document.getElementById('llm-detail-caller').innerText = log.caller;
    document.getElementById('llm-detail-model').innerText = log.model;
    document.getElementById('llm-detail-duration').innerText = log.duration + 'ms';
    document.getElementById('llm-detail-time').innerText = new Date(log.time).toLocaleString();
    document.getElementById('llm-detail-input-tokens').innerText = log.response.input_tokens || '-';
    document.getElementById('llm-detail-output-tokens').innerText = log.response.output_tokens || '-';

    const statusEl = document.getElementById('llm-detail-status');
    statusEl.innerHTML = log.success ?
        '<span class="badge badge-success">Success</span>' :
        '<span class="badge badge-error">Failed</span>';

    // Request payload
    try {
        document.getElementById('llm-detail-request').innerText = JSON.stringify(log.request, null, 2);
    } catch (e) {
        document.getElementById('llm-detail-request').innerText = String(log.request);
    }

    // Response payload
    try {
        document.getElementById('llm-detail-response').innerText = JSON.stringify(log.response, null, 2);
    } catch (e) {
        document.getElementById('llm-detail-response').innerText = String(log.response);
    }

    // Error section
    const errorSection = document.getElementById('llm-detail-error-section');
    if (log.error) {
        errorSection.style.display = 'block';
        document.getElementById('llm-detail-error').innerText = log.error;
    } else {
        errorSection.style.display = 'none';
    }

    openModal('modal-llm-detail');
}

// Clear LLM logs
window.clearLlmLogs = async function () {
    if (!confirm('确定要清空所有 LLM 调用日志吗？')) return;
    try {
        const result = await API.delete('/api/llm/logs');
        if (!result?.success) {
            throw new Error(result?.error || result?.message || '清空失败');
        }
        await loadLlmLogs();
    } catch (e) {
        console.error('Clear LLM logs failed', e);
        alert('清空失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

// Refresh LLM logs (exposed for button)
window.refreshLlmLogs = loadLlmLogs;

// ==================== Scheduler ====================

let currentSchedulerTasks = [];
let schedulerConfig = null;

async function fetchSchedulerConfig(forceRefresh = false) {
    if (!schedulerConfig || forceRefresh) {
        schedulerConfig = await API.get('/api/scheduler/config');
    }
    return schedulerConfig;
}

function populateSchedulerToolOptions(selectedToolName = '') {
    const toolSelect = document.getElementById('sched-form-tool');
    if (!toolSelect || !schedulerConfig) return;

    const allowedTools = Array.isArray(schedulerConfig.allowedTools) ? schedulerConfig.allowedTools : [];
    const options = [...allowedTools];
    if (selectedToolName && !options.includes(selectedToolName)) {
        options.push(selectedToolName);
    }

    toolSelect.innerHTML = options.map((toolName) => {
        const missing = toolName === selectedToolName && !allowedTools.includes(toolName);
        const label = missing ? `${toolName}（当前任务）` : toolName;
        return `<option value="${toolName}">${Utils.escapeHtml(label)}</option>`;
    }).join('');
}

async function loadScheduler() {
    try {
        // 加载配置
        await fetchSchedulerConfig();

        // 加载列表
        const res = await API.get('/api/scheduler/tasks');
        if (!res.success) throw new Error(res.error);
        currentSchedulerTasks = res.tasks || [];

        // 筛选
        const filterStatus = document.getElementById('sched-filter-status').value;
        let filteredTasks = currentSchedulerTasks;
        if (filterStatus) {
            filteredTasks = currentSchedulerTasks.filter(t => t.state === filterStatus);
        }

        // 更新统计 (基于所有任务)
        document.getElementById('sched-stat-total').innerText = currentSchedulerTasks.length;
        document.getElementById('sched-stat-enabled').innerText = currentSchedulerTasks.filter(t => t.enabled).length;
        document.getElementById('sched-stat-running').innerText = currentSchedulerTasks.filter(t => t.state === 'running').length;
        document.getElementById('sched-stat-success').innerText = currentSchedulerTasks.filter(t => t.last_status === 'success').length;
        document.getElementById('sched-stat-failed').innerText = currentSchedulerTasks.filter(t => t.last_status === 'failed').length;

        // 渲染表格
        const tbody = document.querySelector('#table-scheduler tbody');
        if (!tbody) return;

        if (filteredTasks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-sub);padding:40px;">暂无定时任务</td></tr>';
            return;
        }

        tbody.innerHTML = filteredTasks.map(task => {
            const statusBadge = getSchedStatusBadge(task.state);
            const taskIdArg = encodeInlineJsString(task.task_id);
            const scheduleMap = task.schedule_type === 'cron'
                ? `<span style="font-family:var(--font-mono);font-size:12px;">🔄 ${task.cron}</span><div style="font-size:11px;color:var(--text-sub);margin-top:2px;">${Utils.escapeHtml(task.timezone || '-')}</div>`
                : `<span style="font-family:var(--font-mono);font-size:12px;">🕐 一次性</span>`;

            const nextRun = task.enabled && task.next_run_time ? formatSchedulerDisplayTime(task.next_run_time) : '-';
            const lastRun = task.last_run_time ? formatSchedulerDisplayTime(task.last_run_time) : '-';
            const nextRunTitle = task.enabled && task.next_run_time ? getSchedulerDisplayTimeTitle(task.next_run_time) : '';
            const lastRunTitle = task.last_run_time ? getSchedulerDisplayTimeTitle(task.last_run_time) : '';

            return `
                <tr class="hover-row">
                    <td><span style="font-weight:600;color:var(--accent);">${Utils.escapeHtml(task.name)}</span></td>
                    <td style="font-family:var(--font-mono);font-size:12px;">${Utils.escapeHtml(task.tool_name)}</td>
                    <td>${scheduleMap}</td>
                    <td>${statusBadge}</td>
                    <td style="color:var(--text-sub);font-size:12px;" title="${Utils.escapeHtml(nextRunTitle)}">${Utils.escapeHtml(nextRun)}</td>
                    <td style="color:var(--text-sub);font-size:12px;" title="${Utils.escapeHtml(lastRunTitle)}">${Utils.escapeHtml(lastRun)}</td>
                    <td>${task.run_count}</td>
                    <td>
                        <button class="btn btn-sm" onclick="window.viewSchedulerTask(${taskIdArg})">详情</button>
                        <button class="btn btn-sm ${task.enabled ? 'btn-danger' : 'btn-primary'}" onclick="window.toggleSchedulerTask(${taskIdArg}, ${task.enabled})">
                            ${task.enabled ? '禁用' : '启用'}
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.error('Load scheduler tasks failed', e);
    }
}

function getSchedStatusBadge(status) {
    const map = {
        'idle': '<span class="badge badge-neutral">💤 空闲</span>',
        'running': '<span class="badge badge-warning">🔄 运行中</span>',
        'success': '<span class="badge badge-success">✅ 成功</span>',
        'failed': '<span class="badge badge-error">❌ 失败</span>',
        'disabled': '<span class="badge badge-neutral" style="opacity:0.6;">🚫 已禁用</span>',
    };
    return map[status] || `<span class="badge">${Utils.escapeHtml(String(status || '未知'))}</span>`;
}

function formatSchedulerDisplayTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', {
        hour12: false,
        timeZoneName: 'short',
    }).replace(/\//g, '-');
}

function getSchedulerDisplayTimeTitle(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `原始 UTC: ${date.toISOString()}`;
}

window.refreshScheduler = function () {
    loadScheduler();
};

document.getElementById('sched-filter-status')?.addEventListener('change', loadScheduler);

function formatSchedulerDateTimeLocal(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

window.openCreateSchedulerTask = async function () {
    await fetchSchedulerConfig(true);

    document.getElementById('sched-form-title').innerText = '创建定时任务';
    document.getElementById('sched-form-id').value = '';
    document.getElementById('sched-form-name').value = '';
    document.getElementById('sched-form-schedule-type').value = 'cron';
    document.getElementById('sched-form-cron').value = '';
    document.getElementById('sched-form-runat').value = '';
    document.getElementById('sched-form-params').value = '{}';
    document.getElementById('sched-form-timezone').value = schedulerConfig.defaultTimezone;
    document.getElementById('sched-form-retries').value = schedulerConfig.defaultRetries;
    document.getElementById('sched-form-timeout').value = schedulerConfig.defaultTimeoutSec;
    document.getElementById('sched-form-group').value = '';

    // Populate tools
    populateSchedulerToolOptions();

    window.onSchedTypeChange();
    openModal('modal-scheduler-form');
};

window.onSchedTypeChange = function () {
    const type = document.getElementById('sched-form-schedule-type').value;
    document.getElementById('sched-form-cron-group').style.display = type === 'cron' ? 'block' : 'none';
    document.getElementById('sched-form-runat-group').style.display = type === 'once' ? 'block' : 'none';
};

window.saveSchedulerTask = async function () {
    const id = document.getElementById('sched-form-id').value;
    const name = document.getElementById('sched-form-name').value.trim();
    const toolName = document.getElementById('sched-form-tool').value;
    const scheduleType = document.getElementById('sched-form-schedule-type').value;
    const cron = document.getElementById('sched-form-cron').value.trim();
    const runAt = document.getElementById('sched-form-runat').value;
    const paramsStr = document.getElementById('sched-form-params').value.trim() || '{}';
    const timezone = document.getElementById('sched-form-timezone').value.trim();
    const retries = parseInt(document.getElementById('sched-form-retries').value) || 0;
    const timeout = parseInt(document.getElementById('sched-form-timeout').value) || 60;
    const groupIdStr = document.getElementById('sched-form-group').value.trim();

    if (!name) return alert('任务名称不能为空');
    if (scheduleType === 'cron' && !cron) return alert('Cron 表达式不能为空');
    if (scheduleType === 'once' && !runAt) return alert('执行时间不能为空');

    let toolParams = {};
    const parsedToolParams = Utils.safeParseJson(paramsStr);
    if (!parsedToolParams || typeof parsedToolParams !== 'object' || Array.isArray(parsedToolParams)) {
        return alert('参数必须是有效的 JSON 格式');
    }
    toolParams = parsedToolParams;

    const payload = {
        name,
        tool_name: toolName,
        schedule_type: scheduleType,
        timezone,
        tool_params: toolParams,
        retries,
        timeout_sec: timeout
    };

    if (scheduleType === 'cron') payload.cron = cron;
    if (scheduleType === 'once') {
        const date = new Date(runAt);
        payload.run_at = date.toISOString();
    }

    if (groupIdStr) {
        payload.group_id = parseInt(groupIdStr);
    } else if (id) {
        payload.group_id = null;
    }

    try {
        let res;
        if (id) {
            res = await API.put(`/api/scheduler/tasks/${id}`, payload);
        } else {
            res = await API.post('/api/scheduler/tasks', payload);
        }

        await finalizeSchedulerMutation(res, {
            closeModal: true,
            successMessage: id ? '定时任务已更新' : '定时任务已创建',
        });
    } catch (e) {
        alert('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

window.toggleSchedulerTask = async function (id, currentEnabled) {
    try {
        const res = await API.post(`/api/scheduler/tasks/${id}/toggle`, { enabled: !currentEnabled });
        if (!res.success) {
            alert('操作失败: ' + getSchedulerActionMessage(res, '未知错误'));
            return;
        }

        await Promise.all([
            loadScheduler(),
            refreshManagedProcessState(),
        ]);

        if (res?.agentSync && res.agentSync.applied === false) {
            alert(res.message || (currentEnabled ? '定时任务已禁用，但 genesis-agent 同步失败' : '定时任务已启用，但 genesis-agent 同步失败'));
        }
    } catch (e) {
        alert('操作失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

let currentDetailTaskId = null;
let currentDetailTask = null;

function getSchedulerActionMessage(result, fallback) {
    return result?.data?.message || result?.error || result?.text || fallback;
}

async function finalizeSchedulerMutation(result, options = {}) {
    const {
        closeModal = false,
        successMessage = '',
    } = options;

    if (!result?.success) {
        throw new Error(getSchedulerActionMessage(result, '未知错误'));
    }

    if (closeModal) {
        closeModals();
    }

    await Promise.all([
        loadScheduler(),
        refreshManagedProcessState(),
    ]);

    if (result?.agentSync && result.agentSync.applied === false) {
        alert(result.message || successMessage || '操作已完成，但 genesis-agent 同步失败');
        return;
    }

    if (successMessage) {
        alert(result.message || successMessage);
    }
}

async function pollSchedulerRunRequest(requestId) {
    const timeoutMs = 120000;
    const intervalMs = 1500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        await sleep(intervalMs);
        const result = await API.get(`/api/scheduler/run-requests/${encodeURIComponent(requestId)}`);
        if (!result?.queued || result.completed) {
            return result;
        }
    }

    return {
        success: false,
        queued: true,
        completed: false,
        requestId,
        error: '等待调度任务执行结果超时，请稍后手动刷新',
        data: {
            message: '等待调度任务执行结果超时，请稍后手动刷新',
        },
    };
}

function formatSchedulerLogStatusBadge(status) {
    if (status === 'success') {
        return '<span class="badge badge-success">✅ 成功</span>';
    }
    if (status === 'failed') {
        return '<span class="badge badge-error">❌ 失败</span>';
    }
    return `<span class="badge badge-neutral">${Utils.escapeHtml(String(status || '未知'))}</span>`;
}

function getSchedulerLogDuration(log) {
    return Number.isFinite(log?.durationMs) ? log.durationMs : log?.duration_ms;
}

function getSchedulerLogTriggerSource(log) {
    return log?.triggerSource || log?.trigger_source || '-';
}

function getSchedulerLogErrorMessage(log) {
    return log?.errorMessage || log?.error_message || '';
}

function renderSchedulerLogCards(logs) {
    const mobile = document.getElementById('sched-logs-mobile');
    if (!mobile) return;

    if (!Array.isArray(logs) || logs.length === 0) {
        mobile.innerHTML = '<div class="sched-log-empty">暂无执行日志</div>';
        return;
    }

    mobile.innerHTML = logs.map(log => {
        const message = Utils.escapeHtml(log.message || '无');
        const logErrorMessage = getSchedulerLogErrorMessage(log);
        const errorMessage = logErrorMessage
            ? `<div class="sched-log-card-error">${Utils.escapeHtml(logErrorMessage)}</div>`
            : '';
        const durationMs = getSchedulerLogDuration(log);
        const duration = Number.isFinite(durationMs) ? `${durationMs}ms` : '-';
        const attempts = Number.isFinite(log.attempts) ? String(log.attempts) : '-';
        const triggerSource = Utils.escapeHtml(getSchedulerLogTriggerSource(log));

        return `
            <article class="sched-log-card">
                <div class="sched-log-card-head">
                    <div class="sched-log-card-title">${Utils.escapeHtml(new Date(log.time).toLocaleString())}</div>
                    ${formatSchedulerLogStatusBadge(log.status)}
                </div>
                <div class="sched-log-card-meta">
                    <div class="sched-log-card-field">
                        <div class="sched-log-card-label">耗时</div>
                        <div class="sched-log-card-value">${duration}</div>
                    </div>
                    <div class="sched-log-card-field">
                        <div class="sched-log-card-label">触发</div>
                        <div class="sched-log-card-value">${triggerSource}</div>
                    </div>
                    <div class="sched-log-card-field">
                        <div class="sched-log-card-label">尝试次数</div>
                        <div class="sched-log-card-value">${attempts}</div>
                    </div>
                </div>
                <div class="sched-log-card-message">${message}${errorMessage}</div>
            </article>
        `;
    }).join('');
}

function renderSchedulerLogs(logs) {
    const tbody = document.querySelector('#table-sched-logs tbody');
    if (!tbody) return;

    if (!Array.isArray(logs) || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-sub);">暂无日志</td></tr>';
        renderSchedulerLogCards([]);
        return;
    }

    tbody.innerHTML = logs.map(log => {
        let msg = Utils.escapeHtml(log.message || '');
        const logErrorMessage = getSchedulerLogErrorMessage(log);
        if (logErrorMessage) msg += `<br><span style="color:#f85149;font-size:11px;">${Utils.escapeHtml(logErrorMessage)}</span>`;
        const durationMs = getSchedulerLogDuration(log);
        const duration = Number.isFinite(durationMs) ? `${durationMs}ms` : '-';
        const attempts = Number.isFinite(log.attempts) ? String(log.attempts) : '-';
        const triggerSource = Utils.escapeHtml(getSchedulerLogTriggerSource(log));

        return `
            <tr>
                <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-sub);">${new Date(log.time).toLocaleString()}</td>
                <td>${formatSchedulerLogStatusBadge(log.status)}</td>
                <td style="font-family:var(--font-mono);">${duration}</td>
                <td><span class="badge badge-neutral" style="font-size:10px;">${triggerSource}</span></td>
                <td>${attempts}</td>
                <td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;">${msg}</td>
            </tr>
        `;
    }).join('');

    renderSchedulerLogCards(logs);
}

function applySchedulerDetail(task, logs) {
    currentDetailTaskId = task.task_id;
    currentDetailTask = task;

    document.getElementById('sched-detail-id').innerText = task.task_id.slice(0, 8);
    document.getElementById('sched-detail-name').innerText = task.name;
    document.getElementById('sched-detail-tool').innerHTML = `<span class="badge badge-neutral">${Utils.escapeHtml(task.tool_name)}</span>`;
    document.getElementById('sched-detail-status').innerHTML = getSchedStatusBadge(task.state);

    const schedStr = task.schedule_type === 'cron'
        ? `Cron: ${task.cron} (${task.timezone || '-'})`
        : `Once (${task.timezone || '-'})`;
    document.getElementById('sched-detail-schedule').innerText = schedStr;
    const nextNode = document.getElementById('sched-detail-next');
    nextNode.innerText = task.enabled && task.next_run_time ? formatSchedulerDisplayTime(task.next_run_time) : '-';
    nextNode.title = task.enabled && task.next_run_time ? getSchedulerDisplayTimeTitle(task.next_run_time) : '';
    document.getElementById('sched-detail-count').innerText = task.run_count;
    document.getElementById('sched-detail-params').innerText = JSON.stringify(task.tool_params || {}, null, 2);

    const errSection = document.getElementById('sched-detail-error-section');
    if (task.last_error) {
        errSection.style.display = 'block';
        document.getElementById('sched-detail-error').innerText = task.last_error;
    } else {
        errSection.style.display = 'none';
    }

    const taskIndex = currentSchedulerTasks.findIndex(item => item.task_id === task.task_id);
    if (taskIndex >= 0) {
        currentSchedulerTasks[taskIndex] = { ...currentSchedulerTasks[taskIndex], ...task };
    } else {
        currentSchedulerTasks.unshift(task);
    }

    renderSchedulerLogs(logs);
}

async function refreshSchedulerDetail(id, { open = false } = {}) {
    const res = await API.get(`/api/scheduler/tasks/${id}`);
    if (!res.success) {
        throw new Error(res.error || '获取失败');
    }

    applySchedulerDetail(res.task, res.logs || []);
    if (open) {
        openModal('modal-scheduler-detail');
    }
}

window.viewSchedulerTask = async function (id) {
    try {
        await refreshSchedulerDetail(id, { open: true });
    } catch (e) {
        alert('获取详情失败: ' + e.message);
    }
};

window.runSchedulerFromDetail = async function () {
    if (!currentDetailTaskId) return;

    const runBtn = document.getElementById('btn-sched-run');
    const originalLabel = runBtn?.innerHTML;
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.innerHTML = '⏳ 执行中...';
    }

    try {
        const res = await API.post(`/api/scheduler/tasks/${currentDetailTaskId}/run`, {});
        if (!res.success) {
            alert('执行失败: ' + getSchedulerActionMessage(res, '未知错误'));
            await refreshSchedulerDetail(currentDetailTaskId);
            return;
        }

        let settled = res;
        if (res?.data?.result === 'queued' && res?.data?.request_id) {
            alert(getSchedulerActionMessage(res, '任务已加入 genesis-agent 执行队列'));
            settled = await pollSchedulerRunRequest(res.data.request_id);
        }

        if (!settled.success) {
            alert('执行失败: ' + getSchedulerActionMessage(settled, '未知错误'));
            await refreshSchedulerDetail(currentDetailTaskId);
            return;
        }

        await Promise.all([
            loadScheduler(),
            refreshSchedulerDetail(currentDetailTaskId),
        ]);
        alert(getSchedulerActionMessage(settled, '任务已提交执行'));
    } catch (e) {
        alert('请求失败: ' + e.message);
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = originalLabel || '▶️ 立即执行';
        }
    }
};

window.editSchedulerFromDetail = async function () {
    const task = currentDetailTask;
    if (!task) return;

    await fetchSchedulerConfig(true);
    closeModals();

    document.getElementById('sched-form-title').innerText = '编辑定时任务';
    document.getElementById('sched-form-id').value = task.task_id;
    document.getElementById('sched-form-name').value = task.name;

    populateSchedulerToolOptions(task.tool_name);
    document.getElementById('sched-form-tool').value = task.tool_name;

    document.getElementById('sched-form-schedule-type').value = task.schedule_type;
    if (task.schedule_type === 'cron') {
        document.getElementById('sched-form-cron').value = task.cron || '';
    } else if (task.run_at) {
        document.getElementById('sched-form-runat').value = formatSchedulerDateTimeLocal(task.run_at);
    }

    document.getElementById('sched-form-params').value = JSON.stringify(task.tool_params, null, 2);
    document.getElementById('sched-form-timezone').value = task.timezone;
    document.getElementById('sched-form-retries').value = task.retries;
    document.getElementById('sched-form-timeout').value = task.timeout_sec;
    document.getElementById('sched-form-group').value = task.group_id || '';

    window.onSchedTypeChange();
    openModal('modal-scheduler-form');
};

window.deleteSchedulerFromDetail = async function () {
    if (!currentDetailTaskId) return;
    if (!confirm('确定要彻底删除该定时任务吗？这也会删除其所有执行日志。')) return;

    try {
        const res = await API.delete(`/api/scheduler/tasks/${currentDetailTaskId}`);
        await finalizeSchedulerMutation(res, {
            closeModal: true,
            successMessage: '定时任务已删除',
        });
    } catch (e) {
        alert('删除失败: ' + (e instanceof Error ? e.message : String(e)));
    }
};

// Utils
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModals() { document.querySelectorAll('.modal-overlay').forEach(e => e.classList.remove('active')); }
window.closeModals = closeModals;
window.exportProfiles = function () { window.open(getAppUrl('/api/database/export')); };


// Initialization
initNavigation();
loadSystem();
loadConfig();
loadDashboardStats();
initLogs();
setInterval(loadSystem, 5000);
setInterval(loadDashboardStats, 30000); // 每30秒更新统计
setInterval(() => {
    if (document.getElementById('page-tools').classList.contains('active')) {
        loadToolLogs();
    }
    if (document.getElementById('page-llm').classList.contains('active')) {
        loadLlmLogs();
    }
    if (document.getElementById('page-tasks').classList.contains('active')) {
        loadTasks();
    }
    if (document.getElementById('page-scheduler').classList.contains('active')) {
        loadScheduler();
    }
}, 3000);
