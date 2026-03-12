// public/dmx-console.js
class DMXConsole extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        const pathParts = window.location.pathname.split('/').filter(Boolean);
        this.deviceName = pathParts.length > 0 ? pathParts[0] : 'default';
        this.isDeepLinked = pathParts.length > 1;
        const requestedLayout = pathParts.length > 1 ? pathParts[1] : '8';

        this.totalChannels = 512;
        
        if (requestedLayout === 'custom') {
            this.physicalFaders = 'custom';
            this.totalBanks = 1; 
        } else if (isNaN(parseInt(requestedLayout))) {
            this.physicalFaders = requestedLayout; 
            this.totalBanks = 1;
        } else {
            this.physicalFaders = parseInt(requestedLayout) || 8;
            this.totalBanks = this.totalChannels / this.physicalFaders;
        }
        
        this.currentBank = 0;
        
        this.channelState = new Map(); 
        
        for (let i = 0; i < this.totalChannels; i++) {
            this.channelState.set(`${this.deviceName}:${i}`, this.createEmptyChannel());
        }

        this.redTimeouts = new Map();
        this.greenTimeouts = new Map();
        
        this.presetList = []; 
        this.customLayout = []; 
        this.customLayoutName = 'CUSTOM LAYOUT'; 
        this.serverLayout = null; 
        
        this.editingDevice = null;
        this.editingChannel = null; 

        this.globalMeta = {};
        this.tempLayout = [];

        this.render();
        this.setupExternalListeners();
        this.recalculateTotalBanks();
    }

    createEmptyChannel() {
        return {
            value: 0,
            enabled: true,
            protected: false,
            name: '',
            defaultName: '',
            glyph: '',
            radioColor: '',
            history: []
        };
    }

    getChannel(device, channel) {
        const key = `${device}:${channel}`;
        if (!this.channelState.has(key)) {
            this.channelState.set(key, this.createEmptyChannel());
        }
        return this.channelState.get(key);
    }

    getCustomBanks(layoutArray = this.customLayout) {
        const banks = [[]];
        layoutArray.forEach(item => {
            if (item === 'bank_break') {
                banks.push([]);
            } else {
                banks[banks.length - 1].push(item);
            }
        });
        return banks;
    }

    getExpandedBankChannels(bankItems) {
        const expanded = new Set();
        bankItems.forEach(item => {
            if (typeof item === 'string') {
                if (item.includes(':group:')) {
                    const parts = item.split(':');
                    const dev = parts[0];
                    const gIdx = parseInt(parts[2]);
                    if (this.globalMeta[dev] && this.globalMeta[dev].radioGroups && this.globalMeta[dev].radioGroups[gIdx]) {
                        this.globalMeta[dev].radioGroups[gIdx].forEach(ch => expanded.add(`${dev}:${ch}`));
                    }
                } else if (item.includes(':')) {
                    const parts = item.split(':');
                    if (!isNaN(parseInt(parts[1]))) expanded.add(item);
                } else if (!isNaN(parseInt(item))) {
                    expanded.add(`${this.deviceName}:${item}`);
                }
            } else if (typeof item === 'number') {
                expanded.add(`${this.deviceName}:${item}`);
            }
        });
        return expanded;
    }

    recalculateTotalBanks() {
        if (this.physicalFaders === 'custom') {
            this.totalBanks = this.getCustomBanks().length;
            if (this.currentBank >= this.totalBanks) this.currentBank = Math.max(0, this.totalBanks - 1);
        } else if (!isNaN(parseInt(this.physicalFaders))) {
            this.totalBanks = Math.ceil(this.totalChannels / parseInt(this.physicalFaders));
        } else {
            this.totalBanks = 1; 
        }
    }

    setupExternalListeners() {
        this.addEventListener('dmx-status', (e) => {
            const isOnline = e.detail.online;
            const modal = this.shadowRoot.getElementById('offline-modal');
            if (isOnline) modal.style.display = 'none';
            else modal.style.display = 'flex';
        });

        this.addEventListener('dmx-presets-list', (e) => {
            this.presetList = e.detail || [];
            this.renderPresetListDOM();
        });

        this.addEventListener('dmx-global-meta', (e) => {
            this.globalMeta = e.detail || {};
            this.populateSorterDeviceSelect();
            this.renderSorterAvailableList();
            if (this.physicalFaders === 'custom') {
                this.renderFadersDOM();
                this.updateVisibleFaders();
            }
        });

        this.addEventListener('dmx-layout-sync', (e) => {
            this.customLayout = e.detail || [];
            if (this.physicalFaders === 'custom') {
                this.recalculateTotalBanks();
                this.renderFadersDOM();
                this.updateVisibleFaders();
            }
        });

        this.addEventListener('dmx-layout-name-sync', (e) => {
            this.customLayoutName = e.detail || 'CUSTOM LAYOUT';
            if (this.physicalFaders === 'custom') this.updateVisibleFaders();
        });

        this.addEventListener('dmx-server-layout-sync', (e) => {
            this.serverLayout = e.detail;
            this.updateSelectOptions();
            if (this.serverLayout && this.physicalFaders === this.serverLayout.slug) {
                this.recalculateTotalBanks();
                this.renderFadersDOM();
                this.updateVisibleFaders();
            }
        });

        this.addEventListener('dmx-radio-colors', (e) => {
            const colors = e.detail || [];
            let needsUpdate = false;
            colors.forEach((color, i) => {
                const chData = this.getChannel(this.deviceName, i);
                if (chData.radioColor !== color) {
                    chData.radioColor = color;
                    needsUpdate = true;
                }
            });
            if (needsUpdate) this.updateVisibleFaders();
        });

        this.addEventListener('dmx-set', (e) => {
            const device = e.detail.device || this.deviceName;
            const channel = parseInt(e.detail.channel);
            const { value, enabled, protected: isProtected, name, defaultName, glyph, source, history } = e.detail;
            
            const chData = this.getChannel(device, channel);
            let needsUpdate = false;

            if (history !== undefined) chData.history = history;
            if (defaultName !== undefined) chData.defaultName = defaultName;

            if (glyph !== undefined && chData.glyph !== glyph) {
                chData.glyph = glyph;
                needsUpdate = true;
            }

            if (name !== undefined && chData.name !== name) {
                chData.name = name;
                needsUpdate = true;
            }

            if (isProtected !== undefined && chData.protected !== !!isProtected) {
                chData.protected = !!isProtected;
                needsUpdate = true;
            }

            if (enabled !== undefined && chData.enabled !== !!enabled) {
                chData.enabled = !!enabled;
                needsUpdate = true;
            }

            if (value !== undefined) {
                if (source !== 'console' || chData.enabled) {
                    if (chData.value !== value) {
                        chData.value = Math.max(0, Math.min(255, value));
                        needsUpdate = true;
                    }
                }
            }

            if (source === 'human') this.triggerLed(device, channel, 'red');
            if (source === 'console') this.triggerLed(device, channel, 'green');

            if (needsUpdate && this.isChannelVisible(device, channel)) {
                this.updateVisibleFaders();
            }

            if (source === 'console' && !chData.enabled && this.isChannelVisible(device, channel)) {
                this.refreshTooltipIfActive(device, channel);
            }
        });
    }

    isChannelVisible(device, channel) {
        if (this.physicalFaders === 'custom') {
            const currentBankItems = this.getCustomBanks()[this.currentBank] || [];
            return currentBankItems.some(item => {
                if (typeof item === 'number') return device === this.deviceName && channel === item;
                if (typeof item === 'string') {
                    if (item === `${device}:${channel}`) return true;
                    if (!item.includes(':') && !isNaN(parseInt(item))) return device === this.deviceName && channel === parseInt(item);
                    
                    if (item.startsWith(`${device}:group:`)) {
                        const gIdx = parseInt(item.split(':')[2]);
                        if (this.globalMeta[device] && this.globalMeta[device].radioGroups && this.globalMeta[device].radioGroups[gIdx]) {
                            return this.globalMeta[device].radioGroups[gIdx].includes(channel);
                        }
                    }
                }
                return false;
            });
        } else if (this.serverLayout && this.physicalFaders === this.serverLayout.slug) {
            return device === this.deviceName && this.serverLayout.channels.includes(channel);
        } else {
            if (device !== this.deviceName) return false;
            const startChannel = this.currentBank * parseInt(this.physicalFaders);
            const endChannel = startChannel + parseInt(this.physicalFaders) - 1;
            return channel >= startChannel && channel <= endChannel;
        }
    }

    triggerLed(device, channel, color) {
        const key = `${device}:${channel}`;
        const timeoutMap = color === 'red' ? this.redTimeouts : this.greenTimeouts;
        
        if (timeoutMap.has(key)) clearTimeout(timeoutMap.get(key));
        
        timeoutMap.set(key, setTimeout(() => {
            timeoutMap.delete(key);
            this.updateLedDOM(device, channel, color);
        }, 5000));
        
        this.updateLedDOM(device, channel, color);
    }

    updateLedDOM(device, channel, color) {
        if (!this.isChannelVisible(device, channel)) return;

        const strips = this.shadowRoot.querySelectorAll('.fader-strip');
        strips.forEach((strip) => {
            if (strip.dataset.device === device && parseInt(strip.dataset.channel) === channel) {
                const led = strip.querySelector(`.led-${color}`);
                const timeoutMap = color === 'red' ? this.redTimeouts : this.greenTimeouts;
                const isActive = timeoutMap.has(`${device}:${channel}`);
                led.className = `led-${color} ${isActive ? 'on' : ''}`;
            }
        });
    }

    dispatchChange(device, channel, source) {
        const chData = this.getChannel(device, channel);
        document.dispatchEvent(new CustomEvent('dmx-change', {
            detail: {
                device: device,
                channel: channel,
                value: chData.value,
                enabled: chData.enabled,
                protected: chData.protected,
                name: chData.name,
                source: source
            }
        }));
    }

    dispatchPresetAction(action, presetName) {
        document.dispatchEvent(new CustomEvent('dmx-action-preset', {
            detail: { action: action, name: presetName }
        }));
    }

    dispatchBank() {
        if (this.physicalFaders === 'custom' || isNaN(parseInt(this.physicalFaders))) {
            if (this.totalBanks <= 1) return;
        }
        
        const start = this.physicalFaders === 'custom' ? null : this.currentBank * this.physicalFaders;
        
        document.dispatchEvent(new CustomEvent('dmx-bank', {
            detail: { bank: this.currentBank, start: start, end: start !== null ? start + this.physicalFaders - 1 : null }
        }));
    }

    changeBank(offset) {
        if (this.totalBanks <= 1) return;
        this.currentBank = (this.currentBank + offset + this.totalBanks) % this.totalBanks;
        
        this.renderFadersDOM();
        this.updateVisibleFaders();
        this.dispatchBank();
    }

    changeBankSize(newSize) {
        if (newSize === 'custom' || isNaN(parseInt(newSize))) {
            this.physicalFaders = newSize;
            this.recalculateTotalBanks();
            this.renderFadersDOM();
            this.updateVisibleFaders();
            return;
        }

        const oldStartChannel = (this.physicalFaders === 'custom' || isNaN(parseInt(this.physicalFaders))) ? 0 : this.currentBank * this.physicalFaders;
        this.physicalFaders = parseInt(newSize);
        this.recalculateTotalBanks();
        
        this.currentBank = Math.floor(oldStartChannel / this.physicalFaders);
        
        this.renderFadersDOM();
        this.updateVisibleFaders();
        this.dispatchBank();
    }

    openLayoutSorter() {
        this.tempLayout = [...this.customLayout]; 
        
        const nameInput = this.shadowRoot.getElementById('layout-name-input');
        if (nameInput) nameInput.value = this.customLayoutName;

        document.dispatchEvent(new CustomEvent('dmx-request-meta')); 
        this.renderSorterSelectedList();
        this.toggleModal('layout-editor-modal');
    }

    saveLayoutSorter() {
        const nameInput = this.shadowRoot.getElementById('layout-name-input');
        if (nameInput) {
            const newName = nameInput.value.trim() || 'CUSTOM LAYOUT';
            if (this.customLayoutName !== newName) {
                this.customLayoutName = newName;
                document.dispatchEvent(new CustomEvent('dmx-layout-name-change', { detail: this.customLayoutName }));
            }
        }

        const normalized = this.tempLayout.map(item => {
            if (item === 'bank_break') return item;
            if (typeof item === 'number') return `${this.deviceName}:${item}`;
            if (typeof item === 'string' && !item.includes(':')) return `${this.deviceName}:${item}`;
            return item;
        });

        this.customLayout = normalized;
        document.dispatchEvent(new CustomEvent('dmx-layout-change', { detail: this.customLayout }));
        
        this.recalculateTotalBanks();
        this.renderFadersDOM();
        this.updateVisibleFaders();
        this.toggleModal('layout-editor-modal');
    }

    populateSorterDeviceSelect() {
        const select = this.shadowRoot.getElementById('editor-device-select');
        if (!select) return;

        let html = '';
        for (const [devName, meta] of Object.entries(this.globalMeta)) {
            const isLocal = devName === this.deviceName ? ' (Local)' : '';
            html += `<option value="${devName}">${devName}${isLocal}</option>`;
        }
        select.innerHTML = html;
        select.value = this.deviceName; 
    }

    renderSorterAvailableList() {
        const listContainer = this.shadowRoot.getElementById('editor-available-list');
        const select = this.shadowRoot.getElementById('editor-device-select');
        if (!listContainer || !select) return;

        const selectedDevice = select.value;
        const meta = this.globalMeta[selectedDevice];
        
        if (!meta || !meta.names) {
            listContainer.innerHTML = '<div style="color: #6c7086; padding: 10px;">No channels found.</div>';
            return;
        }

        const panelName = meta.serverLayoutName ? meta.serverLayoutName : selectedDevice;

        const radioChannels = new Set();
        if (meta.radioGroups) {
            meta.radioGroups.forEach(g => g.forEach(ch => radioChannels.add(ch)));
        }

        let html = '';

        if (meta.radioGroups) {
            meta.radioGroups.forEach((group, gIdx) => {
                const groupNames = group.map(ch => {
                    const n = meta.names[ch] || meta.defaultNames[ch];
                    return n ? n : `CH ${ch+1}`;
                }).join(' / ');
                
                html += `
                    <div class="sorter-item" style="border-left: 3px solid #f9e2af;">
                        <span><strong>${panelName}</strong><br><span style="font-size:0.75em; color:#a6adc8;">${groupNames}</span></span>
                        <button class="preset-btn load" data-action="add-group" data-device="${selectedDevice}" data-group="${gIdx}">+</button>
                    </div>
                `;
            });
        }

        for (let i = 0; i < 512; i++) {
            if (radioChannels.has(i)) continue;

            const chName = meta.names[i] || meta.defaultNames[i] || '';
            const nameStr = chName ? `<strong>${chName}</strong>` : `<span style="font-style:italic; opacity:0.5;">---</span>`;
            const displayLabel = `<span class="editable-sorter-name" data-device="${selectedDevice}" data-channel="${i}" title="Click to rename">${nameStr} (CH ${i+1})</span>`;
            
            html += `
                <div class="sorter-item">
                    <span>${displayLabel}</span>
                    <button class="preset-btn load" data-action="add-channel" data-device="${selectedDevice}" data-channel="${i}">+</button>
                </div>
            `;
        }
        listContainer.innerHTML = html;
    }

    renderSorterSelectedList() {
        const listContainer = this.shadowRoot.getElementById('editor-selected-list');
        if (!listContainer) return;

        if (this.tempLayout.length === 0) {
            listContainer.innerHTML = '<div style="color: #6c7086; text-align: center; margin-top: 20px;">Layout is empty.</div>';
            return;
        }

        let html = '';
        this.tempLayout.forEach((item, index) => {
            
            if (item === 'bank_break') {
                html += `
                    <div class="sorter-item selected-item" style="background: #45475a; justify-content: center; position: relative;">
                        <strong style="color: #a6e3a1; letter-spacing: 2px;">--- PAGE BREAK ---</strong>
                        <div class="sorter-actions" style="position: absolute; right: 12px;">
                            <button class="preset-btn" data-action="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>▲</button>
                            <button class="preset-btn" data-action="move-down" data-index="${index}" ${index === this.tempLayout.length - 1 ? 'disabled' : ''}>▼</button>
                            <button class="preset-btn delete" data-action="remove-channel" data-index="${index}">X</button>
                        </div>
                    </div>
                `;
                return; 
            }

            if (typeof item === 'string' && item.includes(':group:')) {
                const parts = item.split(':');
                const dev = parts[0];
                const gIdx = parseInt(parts[2]);
                
                let panelName = dev;
                if (this.globalMeta[dev] && this.globalMeta[dev].serverLayoutName) {
                    panelName = this.globalMeta[dev].serverLayoutName;
                }

                let groupLabel = "Unknown Group";
                if (this.globalMeta[dev] && this.globalMeta[dev].radioGroups && this.globalMeta[dev].radioGroups[gIdx]) {
                    const group = this.globalMeta[dev].radioGroups[gIdx];
                    groupLabel = group.map(ch => this.globalMeta[dev].names[ch] || this.globalMeta[dev].defaultNames[ch] || `CH ${ch+1}`).join(' / ');
                }

                const devBadge = dev === this.deviceName ? '' : `<span class="dev-badge">${dev}</span>`;
                const displayLabel = `${devBadge} <strong>${panelName}</strong><br><span style="font-size:0.75em; color:#a6adc8; display:block; margin-top:3px;">${groupLabel}</span>`;

                html += `
                    <div class="sorter-item selected-item" style="border-color: #f9e2af;">
                        <span style="display:flex; align-items:flex-start; gap: 8px;">
                            <span style="color:#6c7086; font-size:0.8em; width:20px; padding-top:2px;">${index+1}.</span>
                            <span>${displayLabel}</span>
                        </span>
                        <div class="sorter-actions">
                            <button class="preset-btn" data-action="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>▲</button>
                            <button class="preset-btn" data-action="move-down" data-index="${index}" ${index === this.tempLayout.length - 1 ? 'disabled' : ''}>▼</button>
                            <button class="preset-btn delete" data-action="remove-channel" data-index="${index}">X</button>
                        </div>
                    </div>
                `;
                return; 
            }

            let dev = this.deviceName;
            let ch = item;
            
            if (typeof item === 'string' && item.includes(':')) {
                const parts = item.split(':');
                dev = parts[0];
                ch = parseInt(parts[1]);
            } else if (typeof item === 'string') {
                ch = parseInt(item);
            }

            let chName = '';
            if (this.globalMeta[dev] && this.globalMeta[dev].names[ch]) {
                chName = this.globalMeta[dev].names[ch];
            } else if (this.globalMeta[dev] && this.globalMeta[dev].defaultNames[ch]) {
                chName = this.globalMeta[dev].defaultNames[ch];
            } else {
                const stateData = this.getChannel(dev, ch);
                chName = stateData.name || stateData.defaultName || '';
            }

            const isLocal = dev === this.deviceName;
            const devBadge = isLocal ? '' : `<span class="dev-badge">${dev}</span>`;
            const nameStr = chName ? `<strong>${chName}</strong>` : `<span style="font-style:italic; opacity:0.5;">---</span>`;
            const displayLabel = `${devBadge} <span class="editable-sorter-name" data-device="${dev}" data-channel="${ch}" title="Click to rename">${nameStr} (CH ${ch + 1})</span>`;

            html += `
                <div class="sorter-item selected-item">
                    <span style="display:flex; align-items:center; gap: 8px;">
                        <span style="color:#6c7086; font-size:0.8em; width:20px;">${index+1}.</span>
                        ${displayLabel}
                    </span>
                    <div class="sorter-actions">
                        <button class="preset-btn" data-action="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>▲</button>
                        <button class="preset-btn" data-action="move-down" data-index="${index}" ${index === this.tempLayout.length - 1 ? 'disabled' : ''}>▼</button>
                        <button class="preset-btn delete" data-action="remove-channel" data-index="${index}">X</button>
                    </div>
                </div>
            `;
        });
        listContainer.innerHTML = html;
    }

    openNameEditor(device, channel) {
        this.editingDevice = device;
        this.editingChannel = channel;
        const chData = this.getChannel(device, channel);
        
        if (this.globalMeta[device] && this.globalMeta[device].defaultNames) {
            chData.defaultName = this.globalMeta[device].defaultNames[channel] || '';
        }

        const modal = this.shadowRoot.getElementById('name-edit-modal');
        const input = this.shadowRoot.getElementById('name-edit-input');
        const title = this.shadowRoot.getElementById('name-edit-title');
        const restoreBtn = this.shadowRoot.getElementById('restore-name-btn');
        
        const devLabel = device === this.deviceName ? '' : ` (${device})`;
        title.textContent = `Edit CH ${channel + 1}${devLabel}`;
        input.value = chData.name || '';
        
        if (chData.defaultName) {
            restoreBtn.style.opacity = '1';
            restoreBtn.style.pointerEvents = 'auto';
        } else {
            restoreBtn.style.opacity = '0.3';
            restoreBtn.style.pointerEvents = 'none';
        }
        
        modal.style.display = 'flex';
        input.focus();
    }

    closeNameEditor() {
        this.shadowRoot.getElementById('name-edit-modal').style.display = 'none';
        this.editingDevice = null;
        this.editingChannel = null;
    }

    saveEditedName() {
        if (this.editingDevice !== null && this.editingChannel !== null) {
            const input = this.shadowRoot.getElementById('name-edit-input');
            const newName = input.value.substring(0, 20).trim();
            const chData = this.getChannel(this.editingDevice, this.editingChannel);
            
            chData.name = newName;
            
            if (this.globalMeta[this.editingDevice]) {
                if (!this.globalMeta[this.editingDevice].names) {
                    this.globalMeta[this.editingDevice].names = new Array(512).fill('');
                }
                this.globalMeta[this.editingDevice].names[this.editingChannel] = newName;
            }

            this.updateVisibleFaders();
            
            const layoutModal = this.shadowRoot.getElementById('layout-editor-modal');
            if (layoutModal && layoutModal.style.display === 'flex') {
                this.renderSorterAvailableList();
                this.renderSorterSelectedList();
            }

            this.dispatchChange(this.editingDevice, this.editingChannel, 'human');
            this.closeNameEditor();
        }
    }

    toggleModal(modalId) {
        const modal = this.shadowRoot.getElementById(modalId);
        const isVisible = modal.style.display === 'flex';
        
        if (modalId === 'qr-modal' && !isVisible) {
            const qrContainer = this.shadowRoot.getElementById('qrcode');
            qrContainer.innerHTML = ''; 
            
            const baseUrl = window.location.origin;
            const qrUrl = `${baseUrl}/${this.deviceName}/${this.physicalFaders}`;

            new QRCode(qrContainer, {
                text: qrUrl,
                width: 256, height: 256,
                colorDark : "#000000", colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.H
            });

            this.shadowRoot.getElementById('qr-url-text').textContent = qrUrl;
            const copyBtn = this.shadowRoot.getElementById('copy-url-btn');
            copyBtn.dataset.url = qrUrl;
            copyBtn.textContent = 'Copy URL';
        }
        
        modal.style.display = isVisible ? 'none' : 'flex';
    }

    refreshTooltipIfActive(device, channel) {
        const tooltip = this.shadowRoot.getElementById('history-tooltip');
        if (tooltip && tooltip.style.display === 'block' && tooltip.dataset.channel == channel && tooltip.dataset.device == device) {
            this.populateTooltip(device, channel, tooltip);
        }
    }

    populateTooltip(device, channel, tooltipElement) {
        const chData = this.getChannel(device, channel);
        const displayChannel = channel + 1;
        const channelName = chData.name ? ` (${chData.name})` : '';
        const devLabel = device === this.deviceName ? '' : ` [${device}]`;
        
        if (!chData.history || chData.history.length === 0) {
            tooltipElement.innerHTML = `<strong>CH ${displayChannel}${devLabel}${channelName} Blocked</strong><br>No recent console activity.`;
            return;
        }

        let html = `<strong>CH ${displayChannel}${devLabel}${channelName} Blocked</strong><br><div style="margin-top:5px;">`;
        chData.history.forEach(entry => {
            const timeStr = new Date(entry.time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
            html += `<div style="display:flex; justify-content:space-between; width: 120px;">
                        <span>${timeStr}</span> <span style="color:#a6e3a1;">Val: ${entry.value}</span>
                     </div>`;
        });
        html += `</div>`;
        tooltipElement.innerHTML = html;
    }

    updateVisibleFaders() {
        const prevBankBtn = this.shadowRoot.getElementById('prev-bank');
        const nextBankBtn = this.shadowRoot.getElementById('next-bank');
        const bankLabel = this.shadowRoot.querySelector('.bank-label');
        const editLayoutBtn = this.shadowRoot.getElementById('edit-layout-btn');

        if (this.serverLayout && this.physicalFaders === this.serverLayout.slug) {
            prevBankBtn.style.visibility = 'hidden';
            nextBankBtn.style.visibility = 'hidden';
            bankLabel.textContent = this.serverLayout.name;
            editLayoutBtn.style.display = 'none';
        } 
        else if (this.physicalFaders === 'custom') {
            if (this.totalBanks > 1) {
                prevBankBtn.style.visibility = 'visible';
                nextBankBtn.style.visibility = 'visible';
                bankLabel.textContent = `${this.customLayoutName} (Pg ${this.currentBank + 1}/${this.totalBanks})`;
            } else {
                prevBankBtn.style.visibility = 'hidden';
                nextBankBtn.style.visibility = 'hidden';
                bankLabel.textContent = this.customLayoutName;
            }
            editLayoutBtn.style.display = 'flex';
        } 
        else {
            if (this.totalBanks > 1) {
                prevBankBtn.style.visibility = 'visible';
                nextBankBtn.style.visibility = 'visible';
            } else {
                prevBankBtn.style.visibility = 'hidden';
                nextBankBtn.style.visibility = 'hidden';
            }
            const startChannel = this.currentBank * this.physicalFaders;
            bankLabel.textContent = `CH ${startChannel + 1} - ${startChannel + this.physicalFaders}`;
            editLayoutBtn.style.display = 'none';
        }

        const strips = this.shadowRoot.querySelectorAll('.fader-strip');
        strips.forEach((strip) => {
            const device = strip.dataset.device;
            const channelIndex = parseInt(strip.dataset.channel);
            const chData = this.getChannel(device, channelIndex);
            
            // Look up if this channel is in a radio group
            let isRadioCh = false;
            if (this.globalMeta[device] && this.globalMeta[device].radioGroups) {
                isRadioCh = this.globalMeta[device].radioGroups.some(g => g.includes(channelIndex));
            }

            strip.classList.remove('radio-green', 'radio-yellow');
            if (chData.radioColor) {
                strip.classList.add(`radio-${chData.radioColor}`);
            }

            strip.querySelector('.channel-label').textContent = channelIndex + 1;

            const nameBadge = strip.querySelector('.channel-name');
            nameBadge.textContent = chData.name || '---';
            nameBadge.className = `channel-name ${chData.name ? '' : 'empty'}`;

            // --- HTML/URL Glyph Rendering ---
            const glyphBadge = strip.querySelector('.channel-glyph');
            if (chData.glyph) {
                glyphBadge.classList.add('has-content');
                if (chData.glyph.trim().startsWith('<')) {
                    glyphBadge.style.backgroundImage = 'none';
                    glyphBadge.innerHTML = chData.glyph;
                } else {
                    glyphBadge.style.backgroundImage = `url('${chData.glyph}')`;
                    glyphBadge.innerHTML = '';
                }
            } else {
                glyphBadge.style.backgroundImage = 'none';
                glyphBadge.innerHTML = '';
                glyphBadge.classList.remove('has-content');
            }

            const slider = strip.querySelector('.fader-input');
            slider.value = chData.value;
            
            const btn = strip.querySelector('.toggle-btn');

            if (chData.protected) {
                strip.classList.add('is-protected');
                slider.classList.add('radio-locked'); 
                slider.style.opacity = chData.enabled ? '0.8' : '0.4'; 
                btn.textContent = chData.enabled ? '🔒 CONSOLE' : '🔒 MANUAL';
                btn.className = `toggle-btn protected-btn ${chData.enabled ? 'active' : ''}`;
            } else {
                strip.classList.remove('is-protected');
                
                // --- Fader Locking for Radio Groups ---
                if (isRadioCh) {
                    slider.classList.add('radio-locked');
                } else {
                    slider.classList.remove('radio-locked');
                }

                slider.style.opacity = chData.enabled ? '1' : '0.5'; 
                btn.textContent = chData.enabled ? 'CONSOLE' : 'MANUAL';
                btn.className = `toggle-btn ${chData.enabled ? 'active' : ''}`;
            }

            const isRedActive = this.redTimeouts.has(`${device}:${channelIndex}`);
            strip.querySelector('.led-red').className = `led-red ${isRedActive ? 'on' : ''}`;

            const isGreenActive = this.greenTimeouts.has(`${device}:${channelIndex}`);
            strip.querySelector('.led-green').className = `led-green ${isGreenActive ? 'on' : ''}`;
        });
    }

    renderPresetListDOM() {
        const listContainer = this.shadowRoot.getElementById('preset-list-container');
        if (!listContainer) return;

        if (this.presetList.length === 0) {
            listContainer.innerHTML = '<div style="color: #6c7086; text-align: center;">No presets saved yet.</div>';
            return;
        }

        let html = '';
        this.presetList.forEach(presetName => {
            html += `
                <div class="preset-item">
                    <span class="preset-name">${presetName}</span>
                    <div class="preset-actions">
                        <button class="preset-btn load" data-action="load" data-name="${presetName}">Load</button>
                        <button class="preset-btn delete" data-action="delete" data-name="${presetName}">X</button>
                    </div>
                </div>
            `;
        });
        listContainer.innerHTML = html;
    }

    renderFadersDOM() {
        let activeFaders = [];
        
        if (this.physicalFaders === 'custom') {
            const currentBankItems = this.getCustomBanks()[this.currentBank] || [];
            
            currentBankItems.forEach(item => {
                if (typeof item === 'number') {
                    activeFaders.push({ device: this.deviceName, channel: item });
                } else if (typeof item === 'string') {
                    if (item.includes(':group:')) {
                        const parts = item.split(':');
                        const dev = parts[0];
                        const gIdx = parseInt(parts[2]);
                        if (this.globalMeta[dev] && this.globalMeta[dev].radioGroups && this.globalMeta[dev].radioGroups[gIdx]) {
                            this.globalMeta[dev].radioGroups[gIdx].forEach(ch => {
                                activeFaders.push({ device: dev, channel: ch });
                            });
                        }
                    } 
                    else if (item.includes(':')) {
                        const [dev, target] = item.split(':');
                        if (!isNaN(parseInt(target))) {
                            activeFaders.push({ device: dev, channel: parseInt(target) });
                        }
                    } else if (!isNaN(parseInt(item))) {
                        activeFaders.push({ device: this.deviceName, channel: parseInt(item) });
                    }
                }
            });
        } else if (this.serverLayout && this.physicalFaders === this.serverLayout.slug) {
            this.serverLayout.channels.forEach(ch => {
                activeFaders.push({ device: this.deviceName, channel: parseInt(ch) });
            });
        } else {
            const startChannel = this.currentBank * parseInt(this.physicalFaders);
            for (let i = 0; i < parseInt(this.physicalFaders); i++) {
                activeFaders.push({ device: this.deviceName, channel: startChannel + i });
            }
        }

        let fadersHtml = '';
        activeFaders.forEach(fader => {
            fadersHtml += `
                <div class="fader-strip" data-device="${fader.device}" data-channel="${fader.channel}">
                    <div class="led-green"></div>
                    <div class="led-red"></div>
                    <input type="range" min="0" max="255" value="0" class="fader-input" data-device="${fader.device}" data-channel="${fader.channel}">
                    <button class="toggle-btn" data-device="${fader.device}" data-channel="${fader.channel}"></button>
                    <div class="channel-label">${fader.channel + 1}</div>
                    <div class="channel-name empty" data-device="${fader.device}" data-channel="${fader.channel}">---</div>
                    <div class="channel-glyph" data-device="${fader.device}" data-channel="${fader.channel}"></div>
                </div>
            `;
        });
        
        fadersHtml += `<div class="history-tooltip" id="history-tooltip"></div>`;
        this.shadowRoot.querySelector('.fader-bank').innerHTML = fadersHtml;
    }

    updateSelectOptions() {
        const select = this.shadowRoot.getElementById('size-select');
        if (!select) return;

        let html = `
            <option value="4" ${this.physicalFaders === 4 ? 'selected' : ''}>4 CH</option>
            <option value="8" ${this.physicalFaders === 8 ? 'selected' : ''}>8 CH</option>
            <option value="16" ${this.physicalFaders === 16 ? 'selected' : ''}>16 CH</option>
            <option value="32" ${this.physicalFaders === 32 ? 'selected' : ''}>32 CH</option>
            <option value="64" ${this.physicalFaders === 64 ? 'selected' : ''}>64 CH</option>
            <option value="custom" ${this.physicalFaders === 'custom' ? 'selected' : ''}>Custom</option>
        `;

        if (this.serverLayout) {
            html += `<option value="${this.serverLayout.slug}" ${this.physicalFaders === this.serverLayout.slug ? 'selected' : ''}>${this.serverLayout.name}</option>`;
        }

        select.innerHTML = html;
    }

    render() {
        const hideUiStyle = this.isDeepLinked ? 'display: none;' : '';

        const style = `
            :host { display: block; font-family: monospace, sans-serif; background-color: #1e1e2e; color: #cdd6f4; padding: 20px; border-radius: 8px; width: max-content; user-select: none; position: relative; }
            .controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 10px; background: #11111b; border-radius: 6px; gap: 10px; }
            .bank-btn, .sync-btn, .bank-select { background: #45475a; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
            .bank-btn:hover, .sync-btn:hover, .bank-select:hover { background: #585b70; }
            .bank-select { font-family: monospace; outline: none; }
            
            .sync-btn.orange { background: #fab387; color: #11111b; }
            .sync-btn.orange:hover { background: #f9e2af; }
            .sync-btn.blue { background: #89b482; color: #11111b; }
            .sync-btn.blue:hover { background: #a6e3a1; }
            
            .edit-layout-btn { display: none; background: transparent; color: #a6adc8; margin-left: 5px; border: none; font-size: 1.2em; font-weight: bold; cursor: pointer; border-radius: 4px; padding: 2px 8px; transition: all 0.2s; letter-spacing: 1px; align-items: center; justify-content: center; }
            .edit-layout-btn:hover { background: #313244; color: #cdd6f4; }

            .bank-label { font-size: 1.2em; font-weight: bold; letter-spacing: 2px; flex-grow: 1; text-align: center; transition: all 0.2s; padding-bottom: 2px;}

            .fader-bank { display: flex; gap: 15px; position: relative; flex-wrap: wrap; }
            .fader-strip { display: flex; flex-direction: column; align-items: center; background: #181825; padding: 15px 10px; border-radius: 6px; box-shadow: inset 0 0 5px rgba(0,0,0,0.5); position: relative; transition: all 0.2s ease; }
            
            .fader-strip.radio-green { background: rgba(166, 227, 161, 0.15); box-shadow: 0 0 15px rgba(166, 227, 161, 0.3) inset; }
            .fader-strip.radio-yellow { background: rgba(249, 226, 175, 0.15); box-shadow: 0 0 15px rgba(249, 226, 175, 0.3) inset; }

            .fader-input { -webkit-appearance: slider-vertical; writing-mode: bt-lr; width: 70px; height: 250px; margin: 15px 0; cursor: pointer; transition: opacity 0.2s; }
            
            /* Stops mouse from interacting with the locked fader slider */
            .fader-input.radio-locked { pointer-events: none; }

            .toggle-btn { background: #313244; color: #6c7086; border: 2px solid #45475a; padding: 8px 0; width: 100%; border-radius: 4px; cursor: pointer; font-weight: bold; transition: all 0.1s ease; }
            .toggle-btn.active { background: #a6e3a1; color: #11111b; border-color: #89b482; box-shadow: 0 0 8px rgba(166, 227, 161, 0.4); }
            
            .toggle-btn.protected-btn { border: 2px dashed #f38ba8; color: #f38ba8; cursor: pointer; }
            .toggle-btn.protected-btn.active { border-color: #89b482; color: #a6e3a1; }
            
            .channel-label { margin-top: 10px; font-size: 0.9em; color: #a6adc8; font-weight: bold; }
            .channel-name { margin-top: 5px; font-size: 0.75em; background: #313244; color: #cdd6f4; padding: 4px 8px; border-radius: 12px; cursor: pointer; width: 60px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border: 1px solid transparent; transition: all 0.1s ease; }
            .channel-name:hover { border-color: #89b482; background: #45475a; }
            .channel-name.empty { opacity: 0.5; font-style: italic; color: #6c7086; }
            
            .channel-glyph { width: 45px; height: 80px; margin-top: 8px; border-radius: 4px; background-size: cover; background-position: center; border: 1px solid #45475a; display: none; align-items: center; justify-content: center; overflow: hidden;}
            .channel-glyph.has-content { display: flex; cursor: pointer; transition: transform 0.1s ease, border-color 0.1s; }
            .channel-glyph.has-content:hover { border-color: #89b482; }
            .channel-glyph.has-content:active { transform: scale(0.95); border-color: #a6e3a1; }
            
            .led-red, .led-green { width: 20px; height: 20px; border-radius: 50%; transition: background-color 0.1s; margin-bottom: 10px; }
            .led-red { background-color: #5c1919; box-shadow: #000 0 -1px 7px 1px, inset #600 0 -1px 9px, #F00 0 2px 12px; }
            .led-red.on{ background-color: #F00; }
            .led-green { background-color: #1a3300; box-shadow: #000 0 -1px 7px 1px, inset #460 0 -1px 9px, #7D0 0 2px 12px; }
            .led-green.on{ background-color: #0F0; }
            
            .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: rgba(0,0,0,0.85); z-index: 9999; justify-content: center; align-items: center; flex-direction: column; box-sizing: border-box; }
            .modal-content { background: #1e1e2e; padding: 20px; border-radius: 8px; box-shadow: 0 0 20px rgba(0,0,0,0.5); margin-bottom: 15px; border: 1px solid #45475a; min-width: 300px; color: #cdd6f4; max-height: 90vh; overflow-y: auto; display: flex; flex-direction: column; }
            
            .modal-instruction { color: #a6adc8; font-size: 0.9em; cursor: pointer; }
            .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #45475a; padding-bottom: 10px; margin-bottom: 15px; margin-top: 0; }
            .modal-close { background: none; border: none; color: #f38ba8; font-size: 1.5em; cursor: pointer; }
            
            .preset-item, .sorter-item { display: flex; justify-content: space-between; align-items: center; background: #313244; padding: 8px 12px; border-radius: 4px; margin-bottom: 8px; }
            .preset-name { font-weight: bold; }
            .preset-actions, .sorter-actions { display: flex; gap: 8px; }
            .preset-btn { border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-weight: bold; background: #45475a; color: white;}
            .preset-btn:hover:not(:disabled) { background: #585b70; }
            .preset-btn:disabled { opacity: 0.3; cursor: not-allowed; }
            .preset-btn.load { background: #89b482; color: #11111b; }
            .preset-btn.delete { background: #f38ba8; color: #11111b; }
            
            .save-preset-box { display: flex; gap: 10px; margin-top: 20px; border-top: 1px solid #45475a; padding-top: 15px; }
            .preset-input { flex-grow: 1; padding: 8px; border-radius: 4px; border: 1px solid #45475a; background: #11111b; color: #cdd6f4; font-family: monospace; box-sizing: border-box; }
            .preset-btn.save { background: #89dceb; color: #11111b; padding: 8px 16px; width: 100%;}

            .history-tooltip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background-color: #313244; border: 1px solid #45475a; padding: 10px; border-radius: 6px; z-index: 50; box-shadow: 0 4px 10px rgba(0,0,0,0.5); margin-bottom: 10px; font-size: 0.8em; white-space: nowrap; pointer-events: none; }
            .history-tooltip::after { content: ''; position: absolute; top: 100%; left: 50%; margin-left: -5px; border-width: 5px; border-style: solid; border-color: #313244 transparent transparent transparent; }
            
            .offline-modal { background-color: rgba(30, 30, 46, 0.95); z-index: 200; }
            .offline-spinner { width: 50px; height: 50px; border: 5px solid #45475a; border-top: 5px solid #89b482; border-radius: 50%; animation: spin 1s linear infinite; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

            .editor-container { display: flex; gap: 20px; max-height: 500px; }
            .editor-col { flex: 1; display: flex; flex-direction: column; background: #11111b; border-radius: 6px; padding: 10px; min-width: 250px; }
            .editor-list { flex-grow: 1; overflow-y: auto; margin-top: 10px; padding-right: 5px; }
            .editor-col h4 { margin: 0 0 10px 0; color: #89b482; text-align: center;}
            .dev-badge { background: #cba6f7; color: #11111b; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; font-weight: bold;}
            .selected-item { border-left: 3px solid #89dceb; }
            
            .editable-sorter-name { cursor: pointer; border-bottom: 1px dashed #6c7086; transition: color 0.1s; }
            .editable-sorter-name:hover { color: #89dceb; border-color: #89dceb; }

            .layout-name-input { background: #313244; color: #a6e3a1; border: 1px solid #45475a; padding: 8px; font-size: 1.1em; font-weight: bold; text-align: center; border-radius: 4px; outline: none; width: 100%; box-sizing: border-box; margin-bottom: 10px; font-family: monospace; transition: border-color 0.2s; }
            .layout-name-input:focus { border-color: #89b482; }
        `;

        this.shadowRoot.innerHTML = `
            <style>${style}</style>
            <div class="controls">
                <button class="bank-btn" id="prev-bank"> &lt;&lt; </button>
                <div style="display: flex; align-items: center; justify-content: center; flex-grow: 1;">
                    <div class="bank-label" id="bank-label-text">CH 1 - 8</div>
                    <button class="edit-layout-btn" id="edit-layout-btn" title="Edit Custom Layout">...</button>
                </div>
                <button class="bank-btn" id="next-bank">  &gt;&gt; </button>
                
                <select class="bank-select" id="size-select" style="${hideUiStyle}">
                    </select>

                <button class="sync-btn blue" id="presets-btn" style="${hideUiStyle}"> Presets </button>
                <button class="sync-btn orange" id="sync-btn"> Sync Phone </button>
            </div>
            <div class="fader-bank"></div>
            
            <div class="modal-overlay" id="qr-modal">
                <div class="modal-content" style="background: white; border: none; min-width: auto; max-width: 300px; display: flex; flex-direction: column; align-items: center;">
                    <div id="qrcode"></div>
                    <div id="qr-url-text" style="margin-top: 15px; font-size: 0.85em; color: #1e1e2e; word-break: break-all; text-align: center;"></div>
                    <button id="copy-url-btn" style="margin-top: 10px; padding: 8px 16px; background: #89b482; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; color: #11111b; width: 100%;">Copy URL</button>
                </div>
                <div class="modal-instruction" id="close-qr">Scan to sync device (Click to close)</div>
            </div>

            <div class="modal-overlay" id="presets-modal">
                <div class="modal-content">
                    <h2 class="modal-header">
                        Presets
                        <button class="modal-close" id="close-presets">&times;</button>
                    </h2>
                    <div id="preset-list-container"></div>
                    <div class="save-preset-box">
                        <input type="text" id="new-preset-name" class="preset-input" placeholder="New preset name...">
                        <button class="preset-btn save" style="width: auto;" id="save-preset-btn">Save</button>
                    </div>
                </div>
            </div>

            <div class="modal-overlay" id="layout-editor-modal">
                <div class="modal-content" style="max-width: 750px; width: 100%;">
                    <h2 class="modal-header">
                        Custom Layout Editor
                        <button class="modal-close" id="close-layout-editor">&times;</button>
                    </h2>
                    
                    <div class="editor-container">
                        <div class="editor-col">
                            <select class="bank-select" style="width:100%; padding: 8px; font-size: 1.1em;" id="editor-device-select"></select>
                            <div class="editor-list" id="editor-available-list"></div>
                        </div>
                        
                        <div class="editor-col">
                            <input type="text" id="layout-name-input" class="layout-name-input" title="Custom Layout Name" placeholder="Layout Name">
                            <div class="editor-list" id="editor-selected-list"></div>
                            
                            <button class="preset-btn load" style="margin-top: 10px; width: 100%; padding: 10px; font-size: 1em;" id="add-bank-break-btn">+ Insert Page Break</button>
                        </div>
                    </div>
                    
                    <div style="margin-top: 20px; text-align: center;">
                        <button class="preset-btn save" id="save-layout-btn" style="font-size: 1.1em; padding: 12px;">Save Custom Layout</button>
                    </div>
                </div>
            </div>

            <div class="modal-overlay" id="name-edit-modal">
                <div class="modal-content" style="width: 250px;">
                    <h2 class="modal-header" id="name-edit-title">
                        Edit Channel
                        <button class="modal-close" id="close-name-edit">&times;</button>
                    </h2>
                    <div style="margin-bottom: 15px;">
                        <input type="text" id="name-edit-input" class="preset-input" style="width: 100%; text-align: center;" placeholder="Leave blank to clear...">
                    </div>
                    <div style="display: flex; gap: 10px; flex-direction: column;">
                        <button class="preset-btn save" id="save-name-btn" style="padding: 10px;">Save Name</button>
                        <div style="display: flex; gap: 10px;">
                            <button class="preset-btn delete" id="clear-name-btn" style="flex: 1; padding: 8px;">Clear</button>
                            <button class="preset-btn load" id="restore-name-btn" style="flex: 1; padding: 8px;">Default</button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="modal-overlay offline-modal" id="offline-modal">
                <div class="offline-spinner"></div>
                <h2 style="color: #cdd6f4; margin-top: 20px;">Waiting for Console</h2>
                <div class="modal-instruction">Device: ${this.deviceName}</div>
            </div>
        `;

        this.updateSelectOptions();
        this.renderFadersDOM();

        this.shadowRoot.getElementById('prev-bank').addEventListener('click', () => this.changeBank(-1));
        this.shadowRoot.getElementById('next-bank').addEventListener('click', () => this.changeBank(1));
        
        this.shadowRoot.getElementById('edit-layout-btn').addEventListener('click', () => this.openLayoutSorter());
        this.shadowRoot.getElementById('close-layout-editor').addEventListener('click', () => this.toggleModal('layout-editor-modal'));
        
        this.shadowRoot.getElementById('editor-device-select').addEventListener('change', () => this.renderSorterAvailableList());
        this.shadowRoot.getElementById('save-layout-btn').addEventListener('click', () => this.saveLayoutSorter());

        this.shadowRoot.getElementById('add-bank-break-btn').addEventListener('click', () => {
            this.tempLayout.push('bank_break');
            this.renderSorterSelectedList();
            const list = this.shadowRoot.getElementById('editor-selected-list');
            list.scrollTop = list.scrollHeight;
        });

        this.shadowRoot.getElementById('editor-available-list').addEventListener('click', (e) => {
            const editableName = e.target.closest('.editable-sorter-name');
            if (editableName) {
                this.openNameEditor(editableName.dataset.device, parseInt(editableName.dataset.channel));
                return;
            }

            if (e.target.dataset.action === 'add-channel') {
                const dev = e.target.dataset.device;
                const ch = parseInt(e.target.dataset.channel);
                
                const banks = this.getCustomBanks(this.tempLayout);
                const currentBank = banks[banks.length - 1]; 
                const expandedCurrentBank = this.getExpandedBankChannels(currentBank);

                if (expandedCurrentBank.has(`${dev}:${ch}`)) {
                    alert("This channel is already in the current layout page/bank.");
                    return;
                }

                this.tempLayout.push(`${dev}:${ch}`);
                this.renderSorterSelectedList();
                const list = this.shadowRoot.getElementById('editor-selected-list');
                list.scrollTop = list.scrollHeight;
            }
            
            if (e.target.dataset.action === 'add-group') {
                const dev = e.target.dataset.device;
                const gIdx = parseInt(e.target.dataset.group);
                
                const banks = this.getCustomBanks(this.tempLayout);
                const currentBank = banks[banks.length - 1]; 
                const expandedCurrentBank = this.getExpandedBankChannels(currentBank);
                
                let conflict = false;
                if (this.globalMeta[dev] && this.globalMeta[dev].radioGroups && this.globalMeta[dev].radioGroups[gIdx]) {
                    for (const ch of this.globalMeta[dev].radioGroups[gIdx]) {
                        if (expandedCurrentBank.has(`${dev}:${ch}`)) conflict = true;
                    }
                }

                if (conflict) {
                    alert("One or more channels from this group are already in the current layout page/bank.");
                    return;
                }

                this.tempLayout.push(`${dev}:group:${gIdx}`);
                this.renderSorterSelectedList();
                const list = this.shadowRoot.getElementById('editor-selected-list');
                list.scrollTop = list.scrollHeight;
            }
        });

        this.shadowRoot.getElementById('editor-selected-list').addEventListener('click', (e) => {
            const editableName = e.target.closest('.editable-sorter-name');
            if (editableName) {
                this.openNameEditor(editableName.dataset.device, parseInt(editableName.dataset.channel));
                return;
            }

            const action = e.target.dataset.action;
            const index = parseInt(e.target.dataset.index);
            
            if (action === 'remove-channel') {
                this.tempLayout.splice(index, 1);
                this.renderSorterSelectedList();
            } else if (action === 'move-up' && index > 0) {
                [this.tempLayout[index - 1], this.tempLayout[index]] = [this.tempLayout[index], this.tempLayout[index - 1]];
                this.renderSorterSelectedList();
            } else if (action === 'move-down' && index < this.tempLayout.length - 1) {
                [this.tempLayout[index + 1], this.tempLayout[index]] = [this.tempLayout[index], this.tempLayout[index + 1]];
                this.renderSorterSelectedList();
            }
        });

        this.shadowRoot.getElementById('sync-btn').addEventListener('click', () => this.toggleModal('qr-modal'));
        
        this.shadowRoot.getElementById('qr-modal').addEventListener('click', (e) => {
            if (e.target.id === 'qr-modal' || e.target.id === 'close-qr') this.toggleModal('qr-modal');
        });
        
        this.shadowRoot.getElementById('copy-url-btn').addEventListener('click', (e) => {
            const url = e.target.dataset.url;
            navigator.clipboard.writeText(url).then(() => {
                e.target.textContent = 'Copied!';
                setTimeout(() => {
                    if (e.target.textContent === 'Copied!') e.target.textContent = 'Copy URL';
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
                e.target.textContent = 'Failed';
            });
        });

        this.shadowRoot.getElementById('size-select').addEventListener('change', (e) => {
            this.changeBankSize(e.target.value);
        });

        this.shadowRoot.getElementById('presets-btn').addEventListener('click', () => this.toggleModal('presets-modal'));
        this.shadowRoot.getElementById('close-presets').addEventListener('click', () => this.toggleModal('presets-modal'));
        this.shadowRoot.getElementById('presets-modal').addEventListener('click', (e) => {
            if (e.target.id === 'presets-modal') this.toggleModal('presets-modal');
        });

        this.shadowRoot.getElementById('save-preset-btn').addEventListener('click', () => {
            const input = this.shadowRoot.getElementById('new-preset-name');
            const name = input.value.trim();
            if (name) {
                this.dispatchPresetAction('save-preset', name);
                input.value = ''; 
            }
        });

        this.shadowRoot.getElementById('preset-list-container').addEventListener('click', (e) => {
            if (e.target.classList.contains('preset-btn')) {
                const action = e.target.dataset.action; 
                const presetName = e.target.dataset.name;
                
                if (action === 'delete') {
                    if (!confirm(`Delete preset '${presetName}'?`)) return;
                }
                
                this.dispatchPresetAction(`${action}-preset`, presetName);
                if (action === 'load') this.toggleModal('presets-modal'); 
            }
        });

        this.shadowRoot.getElementById('close-name-edit').addEventListener('click', () => this.closeNameEditor());
        this.shadowRoot.getElementById('name-edit-modal').addEventListener('click', (e) => {
            if (e.target.id === 'name-edit-modal') this.closeNameEditor();
        });
        
        this.shadowRoot.getElementById('name-edit-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.saveEditedName();
        });

        this.shadowRoot.getElementById('save-name-btn').addEventListener('click', () => this.saveEditedName());
        
        this.shadowRoot.getElementById('clear-name-btn').addEventListener('click', () => {
            this.shadowRoot.getElementById('name-edit-input').value = '';
            this.shadowRoot.getElementById('name-edit-input').focus();
        });
        
        this.shadowRoot.getElementById('restore-name-btn').addEventListener('click', () => {
            if (this.editingDevice !== null && this.editingChannel !== null) {
                const chData = this.getChannel(this.editingDevice, this.editingChannel);
                if (chData.defaultName) {
                    this.shadowRoot.getElementById('name-edit-input').value = chData.defaultName;
                    this.shadowRoot.getElementById('name-edit-input').focus();
                }
            }
        });

        const faderBank = this.shadowRoot.querySelector('.fader-bank');

        faderBank.addEventListener('mouseover', (e) => {
            const strip = e.target.closest('.fader-strip');
            if (strip) {
                const device = strip.dataset.device;
                const channel = parseInt(strip.dataset.channel);
                const chData = this.getChannel(device, channel);
                const tooltip = this.shadowRoot.getElementById('history-tooltip');
                if (!chData.enabled) {
                    this.populateTooltip(device, channel, tooltip);
                    strip.appendChild(tooltip); 
                    tooltip.style.display = 'block';
                    tooltip.dataset.device = device;
                    tooltip.dataset.channel = channel;
                }
            }
        });

        faderBank.addEventListener('mouseout', (e) => {
            const strip = e.target.closest('.fader-strip');
            if (strip) {
                const tooltip = this.shadowRoot.getElementById('history-tooltip');
                if (tooltip) tooltip.style.display = 'none';
            }
        });

        faderBank.addEventListener('input', (e) => {
            if (e.target.classList.contains('fader-input')) {
                const strip = e.target.closest('.fader-strip');
                const device = strip.dataset.device;
                const channel = parseInt(strip.dataset.channel);
                const chData = this.getChannel(device, channel);
                
                if (chData.protected) return; 

                chData.value = parseInt(e.target.value);
                chData.enabled = false;
                this.updateVisibleFaders();
                
                const tooltip = this.shadowRoot.getElementById('history-tooltip');
                if (tooltip) this.populateTooltip(device, channel, tooltip);
                
                this.dispatchChange(device, channel, 'human');
            }   
        });

        faderBank.addEventListener('click', (e) => {
            const strip = e.target.closest('.fader-strip');
            if (!strip) return;
            const device = strip.dataset.device;
            const channel = parseInt(strip.dataset.channel);
            const chData = this.getChannel(device, channel);

            if (e.target.classList.contains('channel-name')) {
                this.openNameEditor(device, channel);
                return;
            }
            
            const glyphEl = e.target.closest('.channel-glyph');
            if (glyphEl) {
                if (chData.protected) return; 

                let targetGroup = null;
                if (this.globalMeta[device] && this.globalMeta[device].radioGroups) {
                    targetGroup = this.globalMeta[device].radioGroups.find(g => g.includes(channel));
                }

                if (targetGroup) {
                    const activeChannels = targetGroup.filter(ch => this.getChannel(device, ch).value >= 128);
                    const isOnlyTargetActive = activeChannels.length === 1 && activeChannels[0] === channel;

                    targetGroup.forEach(ch => {
                        const groupChData = this.getChannel(device, ch);
                        if (groupChData.protected) return;

                        let newValue = 0;
                        if (!isOnlyTargetActive && ch === channel) {
                            newValue = 255;
                        }

                        if (groupChData.value !== newValue) {
                            groupChData.value = newValue;
                            groupChData.enabled = false; 
                            this.dispatchChange(device, ch, 'human');
                        }
                    });
                } else {
                    chData.value = chData.value >= 128 ? 0 : 255;
                    chData.enabled = false;
                    this.dispatchChange(device, channel, 'human');
                }
                
                this.updateVisibleFaders();
                return;
            }

            if (e.target.classList.contains('toggle-btn')) {
                if (e.shiftKey) {
                    chData.protected = !chData.protected;
                    this.updateVisibleFaders();
                    this.dispatchChange(device, channel, 'human');
                    return;
                }

                if (chData.protected) return; 

                // --- NEW: Group Sync for Manual/Console Toggle ---
                let targetGroup = null;
                if (this.globalMeta[device] && this.globalMeta[device].radioGroups) {
                    targetGroup = this.globalMeta[device].radioGroups.find(g => g.includes(channel));
                }

                const newEnabledState = !chData.enabled;

                if (targetGroup) {
                    targetGroup.forEach(ch => {
                        const groupChData = this.getChannel(device, ch);
                        if (groupChData.protected) return;

                        groupChData.enabled = newEnabledState;
                        if (groupChData.enabled && groupChData.history && groupChData.history.length > 0) {
                            groupChData.value = groupChData.history[0].value;
                        }
                        this.dispatchChange(device, ch, 'human');
                    });
                } else {
                    chData.enabled = newEnabledState;
                    if (chData.enabled && chData.history && chData.history.length > 0) {
                        chData.value = chData.history[0].value;
                    }
                    this.dispatchChange(device, channel, 'human');
                }

                if (newEnabledState) {
                    const tooltip = this.shadowRoot.getElementById('history-tooltip');
                    if (tooltip) tooltip.style.display = 'none';
                }

                this.updateVisibleFaders();
            }
        });
    }
}

customElements.define('dmx-console', DMXConsole);