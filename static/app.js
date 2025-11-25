document.addEventListener('DOMContentLoaded', () => {
  console.log('app.js: DOM ready');
  const buttons = document.querySelectorAll('.boot-btn');
  const panels = document.querySelectorAll('.panel');
  const terminal = document.getElementById('terminal-output');
  const logList = document.getElementById('log-list');
  console.log('app.js: found', buttons.length, 'buttons and', panels.length, 'panels');
  const socket = window.io ? window.io('/ui') : null;
  const socketState = { isConnected: false };
  const knownTasks = new Map();
  const pendingTasks = new Map();
  const pendingTerminal = new Map();
  const TERMINAL_CHANNEL_GLOBAL = 'global';
  const TERMINAL_CHANNEL_META = 'meta';
  const channelForPi = piId => (piId ? `pi:${piId}` : TERMINAL_CHANNEL_GLOBAL);
  let activeTerminalChannel = TERMINAL_CHANNEL_GLOBAL;
  let activePiSelection = null;
  // Prevent page-level scrolling but allow wheel/touch inside terminal or log areas
  try{
    ['wheel','touchmove'].forEach(evt => {
      window.addEventListener(evt, e => {
        const allowLogScroll = e.target.closest && e.target.closest('.log-list');
        if(!allowLogScroll){ e.preventDefault(); }
      }, {passive:false});
    });
    window.addEventListener('keydown', (e)=>{
      const block = ['PageUp','PageDown','Home','End'];
      if(block.includes(e.key)){
        // allow arrow keys and space so users can interact with inputs normally
        e.preventDefault();
      }
    });
    console.log('app.js: scroll prevention enabled (except inside terminal/log)');
  }catch(err){ console.warn('app.js: could not attach scroll prevention', err); }

  const bootTimestamp = Date.now();
  const root = document.documentElement;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const themePresets = {
    green: { accent:'#39ff14', accent2:'#7eff3f', muted:'#63b36b', bg:'#000a00', panel:'#001200' },
    amber: { accent:'#ffb347', accent2:'#ffd166', muted:'#ffc680', bg:'#1d1200', panel:'#2a1a00' },
    blue: { accent:'#5ad1ff', accent2:'#89e0ff', muted:'#7aa6ff', bg:'#00111d', panel:'#001a2b' },
    purple: { accent:'#c77dff', accent2:'#e0aaff', muted:'#b794f6', bg:'#140016', panel:'#1f0026' }
  };

  function showTab(target){
    panels.forEach(p=>p.classList.toggle('active', p.id===target));
    buttons.forEach(b=>b.classList.toggle('active', b.dataset.target===target));
    const numpad = document.getElementById('numpad');
    const symbolPad = document.getElementById('symbol-pad');
    if(numpad){
      const shouldHide = target !== 'terminal';
      numpad.classList.toggle('hidden', shouldHide);
    }
    if(symbolPad){
      const shouldHide = target !== 'terminal';
      symbolPad.classList.toggle('hidden', shouldHide);
    }
  }

  // Align numpad top with the terminal-frame top (positions .numpad relative to .panels)
  function alignNumpad(){
    try{
      const numpad = document.getElementById('numpad');
      const symbolPad = document.getElementById('symbol-pad');
      const terminalFrame = document.querySelector('.terminal-frame');
      const panelsEl = document.querySelector('.panels');
      if(!terminalFrame || !panelsEl) return;
      const termRect = terminalFrame.getBoundingClientRect();
      const panelsRect = panelsEl.getBoundingClientRect();
      const baseTop = Math.max(0, Math.round(termRect.top - panelsRect.top));

      const placePad = (pad, offset = 0) => {
        if(!pad || pad.classList.contains('hidden')) return 0;
        const style = window.getComputedStyle(pad);
        const posType = style.position;
        if(posType === 'absolute' || posType === 'fixed' || posType === 'sticky'){
          pad.style.top = baseTop + offset + 'px';
        }
        const rect = pad.getBoundingClientRect();
        return Math.ceil(rect.height || 0);
      };

      const numpadHeight = placePad(numpad, 0);
      placePad(symbolPad, numpadHeight ? numpadHeight + 12 : 0);
      // adjust terminal height so numpad fits on small screens
      adjustTerminalForNumpad();
    }catch(err){ console.warn('app.js: alignNumpad failed', err); }
  }

  function adjustTerminalForNumpad(){
    try{
      const numpad = document.getElementById('numpad');
      const symbolPad = document.getElementById('symbol-pad');
      const terminalInner = document.querySelector('.terminal-inner');
      const bootBar = document.querySelector('.boot-bar');
      const hud = document.querySelector('.hud');
      if(!terminalInner) return;

      const vh = window.innerHeight || document.documentElement.clientHeight;
      let reserved = 0;
      if(bootBar) reserved += bootBar.getBoundingClientRect().height;
      if(hud) reserved += hud.getBoundingClientRect().height;

      let numpadH = 0;
      if(numpad && !numpad.classList.contains('hidden')){
        // include some safe margin for the numpad
        numpadH = Math.ceil(numpad.getBoundingClientRect().height) + 8;
      }
      let symbolPadH = 0;
      if(symbolPad && !symbolPad.classList.contains('hidden')){
        symbolPadH = Math.ceil(symbolPad.getBoundingClientRect().height) + 8;
      }

      // panels have bottom padding/space for boot bar — mirror CSS value (80)
      const panelsBottomSpace = 80;
      // compute available space for terminal-inner.
      // Raise the minimum so the terminal shows ~15 lines (~14px font, 1.5 line-height => ~21px/line => ~315px).
      // Add padding/borders margin so choose ~340px as a comfortable floor for 15 lines.
      const MIN_TERMINAL_PX = 340;
      const accessoryHeight = numpadH + symbolPadH;
      const available = Math.max(MIN_TERMINAL_PX, vh - reserved - accessoryHeight - panelsBottomSpace - 24);
      terminalInner.style.height = available + 'px';
    }catch(err){ console.warn('app.js: adjustTerminalForNumpad failed', err); }
  }

  const holdRegistry = new Map();
  let holdIdCounter = 1;
  const HOLD_INTERVAL_MS = 1000;

  function scrollTerminalToBottom(){
    if(!terminal) return;
    const container = terminal.parentElement;
    if(container){
      container.scrollTop = container.scrollHeight;
    }
  }

  function writeTerminalLine(text = '', options = {}){
    if(!terminal) return;
    const line = document.createElement('span');
    const content = `${text ?? ''}`;
    const channel = options.channel || TERMINAL_CHANNEL_GLOBAL;
    line.dataset.channel = channel;
    line.textContent = options.noNewline ? content : `${content}\n`;
    if(options.className) line.className = options.className;
    if(options.color) line.style.color = options.color;
    terminal.appendChild(line);
    applyTerminalFilterToLine(line);
    scrollTerminalToBottom();
  }

  function applyTerminalFilterToLine(node){
    if(!node || node.nodeType !== 1) return;
    const channel = node.dataset.channel || TERMINAL_CHANNEL_GLOBAL;
    if(activeTerminalChannel === TERMINAL_CHANNEL_GLOBAL){
      if(channel === TERMINAL_CHANNEL_GLOBAL || channel === TERMINAL_CHANNEL_META){
        node.style.display = '';
      }else{
        node.style.display = 'none';
      }
      return;
    }
    if(channel === activeTerminalChannel || channel === TERMINAL_CHANNEL_META){
      node.style.display = '';
    }else{
      node.style.display = 'none';
    }
  }

  function applyTerminalFilterToAll(){
    if(!terminal) return;
    Array.from(terminal.children).forEach(applyTerminalFilterToLine);
  }

  function setActiveTerminalChannel(channel, { force = false } = {}){
    const resolved = channel || TERMINAL_CHANNEL_GLOBAL;
    if(!force && resolved === activeTerminalChannel) return;
    activeTerminalChannel = resolved;
    applyTerminalFilterToAll();
    scrollTerminalToBottom();
  }

  function hasLinesForChannel(channel){
    if(!terminal) return false;
    return Array.from(terminal.children || []).some(node => node.dataset && node.dataset.channel === channel);
  }

  function removeEmptyBanner(channel){
    if(!terminal || !channel) return;
    Array.from(terminal.querySelectorAll('.terminal-banner--empty')).forEach(node => {
      if(node.dataset && node.dataset.channel === channel){
        node.remove();
      }
    });
  }

  function clearPiSelection({ showBanner = true } = {}){
    if(!activePiSelection){
      setActiveTerminalChannel(TERMINAL_CHANNEL_GLOBAL, { force: true });
      return;
    }
    document.querySelectorAll('.pi-card.selected').forEach(card => {
      card.classList.remove('selected');
      card.setAttribute('aria-pressed', 'false');
    });
    activePiSelection = null;
    setActiveTerminalChannel(TERMINAL_CHANNEL_GLOBAL, { force: true });
    if(showBanner){
      writeTerminalLine('[view] Showing all console channels.', { className: 'terminal-banner', channel: TERMINAL_CHANNEL_META });
    }
  }

  function sendTerminalCommand(commandText){
    if(!activePiSelection){
      writeTerminalLine('No Pi selected. Choose a device in STATS to route terminal commands.');
      return;
    }
    const piId = activePiSelection.id;
    const channel = channelForPi(piId);
    const trimmed = (commandText || '').trim();
    if(!trimmed){
      writeTerminalLine('Cannot execute an empty command.', { channel, className: 'terminal-banner' });
      return;
    }
    if(!socket || !socketState.isConnected){
      writeTerminalLine('Controller connection unavailable; command not sent.', { channel, className: 'terminal-banner' });
      return;
    }
    removeEmptyBanner(channel);
    writeTerminalLine(`[terminal] Dispatching to ${activePiSelection.label || piId}…`, { channel, className: 'terminal-banner' });
    socket.emit('terminal_command', { pi_id: piId, command: trimmed }, ack => {
      if(!ack){
        writeTerminalLine('No acknowledgement from controller.', { channel, className: 'terminal-banner' });
        return;
      }
      if(ack.error){
        writeTerminalLine(`Controller rejected command: ${ack.error}`, { channel, className: 'terminal-banner' });
        return;
      }
      if(ack.request_id){
        pendingTerminal.set(ack.request_id, { piId, command: trimmed });
      }
      if(ack.message){
        writeTerminalLine(ack.message, { channel, className: 'terminal-banner' });
      }
    });
  }

  function selectPiCard(card, piId, label){
    if(!piId) return;
    document.querySelectorAll('.pi-card.selected').forEach(node => {
      if(node !== card){
        node.classList.remove('selected');
        node.setAttribute('aria-pressed', 'false');
      }
    });
    if(card){
      card.classList.add('selected');
      card.setAttribute('aria-pressed', 'true');
    }
    const displayLabel = label || piId;
    const channel = channelForPi(piId);
    activePiSelection = { id: piId, label: displayLabel };
    setActiveTerminalChannel(channel, { force: true });
    showTab('terminal');
    alignNumpad();
    const suffix = displayLabel !== piId ? ` (${piId})` : '';
    writeTerminalLine(`[view] Showing output for ${displayLabel}${suffix}. Click TERMINAL to reset.`, { className: 'terminal-banner', channel: TERMINAL_CHANNEL_META });
    removeEmptyBanner(channel);
    if(!hasLinesForChannel(channel)){
      writeTerminalLine('No console output received yet for this device.', { className: 'terminal-banner terminal-banner--empty', channel });
    }
  }

  function clearTerminal(){
    if(!terminal) return;
    terminal.textContent = '';
    scrollTerminalToBottom();
  }

  function tokenizeCommand(input){
    const tokens = [];
    const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    while((match = regex.exec(input)) !== null){
      tokens.push(match[1] ?? match[2] ?? match[3]);
    }
    return tokens;
  }

  function normalizeHexColor(value){
    if(!value) return null;
    let hex = value.trim();
    if(hex.startsWith('#')) hex = hex.slice(1);
    if(hex.length === 3){
      hex = hex.split('').map(ch => ch + ch).join('');
    }
    if(!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return `#${hex.toLowerCase()}`;
  }

  function hexToRgb(hex){
    const normalized = normalizeHexColor(hex);
    if(!normalized) return null;
    const intVal = parseInt(normalized.slice(1), 16);
    return {
      r: (intVal >> 16) & 255,
      g: (intVal >> 8) & 255,
      b: intVal & 255
    };
  }

  function rgbToHex({r, g, b}){
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    return `#${[clamp(r), clamp(g), clamp(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}`;
  }

  function lightenHex(hex, ratio = 0.2){
    const rgb = hexToRgb(hex);
    if(!rgb) return null;
    const lighten = channel => channel + (255 - channel) * ratio;
    return rgbToHex({
      r: lighten(rgb.r),
      g: lighten(rgb.g),
      b: lighten(rgb.b)
    });
  }

  function applyAccentHex(hex){
    const normalized = normalizeHexColor(hex);
    if(!normalized) return null;
    const brighter = lightenHex(normalized, 0.25) || normalized;
    const muted = lightenHex(normalized, 0.45) || normalized;
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent2', brighter);
    root.style.setProperty('--muted', muted);
    if(themeMeta) themeMeta.setAttribute('content', normalized);
    return normalized;
  }

  function applyThemePreset(name){
    const preset = themePresets[name];
    if(!preset) return false;
    Object.entries(preset).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value);
    });
    if(themeMeta && preset.bg) themeMeta.setAttribute('content', preset.bg);
    return true;
  }

  function collectStats(){
    return Array.from(document.querySelectorAll('.pi-card')).map(card => {
      const index = Number(card.dataset.pi) || null;
      const labelEl = card.querySelector('.pi-label');
      if(!labelEl) return null;
      const label = labelEl.textContent.trim();
      const cpuEl = card.querySelector('.value[data-metric="cpu"]');
      const ramEl = card.querySelector('.value[data-metric="ram"]');
      const taskEl = card.querySelector('.value[data-metric="task"]') || card.querySelector('.pi-task');
      const cpuText = cpuEl ? cpuEl.textContent.trim() : 'n/a';
      const ramText = ramEl ? ramEl.textContent.trim() : 'n/a';
      const taskText = taskEl ? taskEl.textContent.trim() : 'Unassigned';
      return {
        card,
        index,
        label,
        cpuEl,
        ramEl,
        taskEl,
        cpu: cpuText,
        ram: ramText,
        task: taskText
      };
    }).filter(Boolean);
  }

  // Ensure a .pi-card exists for the given piId. Create if missing.
  function ensurePiCard(piId, label){
    if(piId === undefined || piId === null) return null;
    const idStr = String(piId);
    const grid = document.querySelector('.pi-grid') || document.querySelector('.pi-cards') || document.querySelector('.panels') || document.body;
    let card = (grid && grid.querySelector) ? grid.querySelector(`.pi-card[data-pi="${idStr}"]`) : null;
    if(card){
      if(!card.hasAttribute('role')) card.setAttribute('role', 'button');
      if(!card.hasAttribute('tabindex')) card.tabIndex = 0;
      if(!card.hasAttribute('aria-pressed')) card.setAttribute('aria-pressed', 'false');
      const labelEl = card.querySelector('.pi-label');
      if(labelEl && label) labelEl.textContent = label;
      return card;
    }
    card = document.createElement('article');
    card.className = 'pi-card';
    card.dataset.pi = idStr;
    card.dataset.assignedTask = '';
    card.dataset.activeTask = '';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', 'false');
    card.innerHTML = `
      <header class="pi-header">
        <h2 class="pi-label">${label ? label : 'PI ' + idStr}</h2>
        <span class="pi-task" data-metric="task">Idle</span>
      </header>
      <div class="pi-metrics">
        <div class="metric">
          <span class="label">CPU</span>
          <span class="value" data-metric="cpu" data-unit="%" data-target="0">0%</span>
        </div>
        <div class="metric">
          <span class="label">RAM</span>
          <span class="value" data-metric="ram" data-unit="%" data-target="0">0%</span>
        </div>
        <div class="metric">
          <span class="label">TASK</span>
          <span class="value" data-metric="task">Idle</span>
        </div>
      </div>
    `;
    try{
      grid.appendChild(card);
    }catch(err){
      document.body.appendChild(card);
    }
    return card;
  }

  function applyPiStat(card, stat){
    const changed = [];
    if(!card || !stat) return changed;
    const assignedTextRaw = typeof stat.assigned_task === 'string' ? stat.assigned_task.trim() : '';
    const activeTextRaw = typeof stat.active_task === 'string' ? stat.active_task.trim() : '';
    const taskText = assignedTextRaw || activeTextRaw || 'Idle';
    card.dataset.assignedTask = assignedTextRaw;
    card.dataset.activeTask = activeTextRaw;
    const labelEl = card.querySelector('.pi-label');
    if(labelEl && stat.label) labelEl.textContent = stat.label;
    const headerTaskEl = card.querySelector('.pi-task[data-metric="task"]');
    if(headerTaskEl) headerTaskEl.textContent = taskText;
    const bodyTaskEl = card.querySelector('.value[data-metric="task"]');
    if(bodyTaskEl) bodyTaskEl.textContent = taskText;

    const cpuEl = card.querySelector('.value[data-metric="cpu"]');
    const cpuPercent = Number(stat.cpu_percent);
    if(cpuEl && Number.isFinite(cpuPercent)){
      cpuEl.dataset.target = cpuPercent.toFixed(1);
      cpuEl.dataset.unit = '%';
      cpuEl.dataset.decimals = '1';
      changed.push(cpuEl);
    }

    const ramEl = card.querySelector('.value[data-metric="ram"]');
    const ramPercent = Number(stat.ram_percent);
    if(ramEl && Number.isFinite(ramPercent)){
      ramEl.dataset.target = ramPercent.toFixed(0);
      ramEl.dataset.unit = '%';
      ramEl.dataset.decimals = '0';
      const used = Number(stat.ram_used_gb);
      const total = Number(stat.ram_total_gb);
      if(Number.isFinite(used) && Number.isFinite(total)){
        ramEl.title = `${used.toFixed(1)} / ${total.toFixed(1)} GB`;
      }else if(Number.isFinite(used)){
        ramEl.title = `${used.toFixed(1)} GB used`;
      }else{
        ramEl.removeAttribute('title');
      }
      changed.push(ramEl);
    }

    const online = stat.online !== false;
    card.dataset.online = online ? '1' : '0';
    return changed;
  }

  function handleStatsSnapshot(payload){
    if(!payload) return;
    const items = Array.isArray(payload) ? payload : Object.values(payload);
    const nodes = [];
    items.forEach(stat => {
      if(!stat || stat.pi_id === undefined || stat.pi_id === null) return;
      const card = ensurePiCard(stat.pi_id, stat.label);
      if(!card) return;
      const changed = applyPiStat(card, stat);
      if(changed.length) nodes.push(...changed);
    });
    if(nodes.length) animateStats(nodes);
  }

  function handleTaskCatalog(payload){
    knownTasks.clear();
    if(!payload) return;
    const items = Array.isArray(payload) ? payload : Object.values(payload);
    items.forEach(item => {
      if(!item || !item.id) return;
      knownTasks.set(item.id, item);
    });
  }

  function resolveTaskLabel(ref){
    if(!ref) return 'task';
    const taskId = ref.task_id || ref.taskId;
    if(ref.request_id && pendingTasks.has(ref.request_id)){
      const pending = pendingTasks.get(ref.request_id);
      if(pending && pending.taskId){
        const pendingInfo = knownTasks.get(pending.taskId);
        if(pendingInfo && pendingInfo.label) return pendingInfo.label;
        return pending.taskId;
      }
    }
    if(taskId && knownTasks.has(taskId)){
      const data = knownTasks.get(taskId);
      if(data && data.label) return data.label;
    }
    if(ref.label) return ref.label;
    if(taskId) return taskId;
    return 'task';
  }

  function resolveCommand(tokens){
    if(!tokens.length) return { name: null, args: [], tokens: [], label: '', invokedName: '' };
    const originalTokens = [...tokens];
    const [first, ...rest] = originalTokens;
    const invoked = first || '';
    const label = originalTokens.join(' ');
    const commandName = invoked.toLowerCase();
    if(commandName === 'clear' && rest[0] && rest[0].toLowerCase() === 'logs'){
      return { name: 'clearlogs', args: rest.slice(1), tokens: originalTokens, label, invokedName: invoked };
    }
    return { name: commandName, args: rest, tokens: originalTokens, label, invokedName: invoked };
  }

  function runResolvedCommand(resolved, options = {}){
    if(!resolved || !resolved.name) return false;
    const command = commandCatalog[resolved.name];
    const invokedName = resolved.invokedName || resolved.name;
    const prefix = options.prefix !== undefined
      ? options.prefix
      : (options.fromHold && options.holdId ? `[H#${options.holdId}] ` : '');

    const writer = (text = '', opts = {}) => {
      const finalText = prefix ? `${prefix}${text}` : text;
      writeTerminalLine(finalText, opts);
    };

    if(!command){
      if(!options.silent){
        writer(`Command not recognized: ${invokedName}`);
        writer("Type 'help' to list available commands.");
      }
      return false;
    }

    const ctx = {
      raw: options.raw ?? resolved.label ?? '',
      input: options.input ?? resolved.label ?? '',
      command: resolved.name,
      args: Array.isArray(resolved.args) ? [...resolved.args] : [],
      write: writer,
      clear: clearTerminal,
      fromHold: Boolean(options.fromHold),
      holdId: options.holdId ?? null
    };

    try{
      command.action(ctx);
      return true;
    }catch(err){
      console.error('app.js: command failed', err);
      const message = err && err.message ? err.message : err;
      writer(`Command '${resolved.name}' failed: ${message}`);
      return false;
    }
  }

  function getHoldableCommandNames(){
    return Object.entries(commandCatalog)
      .filter(([, info]) => info && info.allowHold === true)
      .map(([name, info]) => info.label || name);
  }

  function startHold(resolved, label){
    if(!resolved || !resolved.name) return;
    const command = commandCatalog[resolved.name];
    const invoked = resolved.invokedName || resolved.name;
    if(!command){
      writeTerminalLine(`Command not recognized: ${invoked}`);
      writeTerminalLine("Type 'help' to list available commands.");
      return;
    }
    if(command.allowHold !== true){
      const display = command.label || invoked;
      writeTerminalLine(`Command '${display}' cannot be held.`);
      const holdableList = getHoldableCommandNames();
      if(holdableList.length){
        writeTerminalLine(`Hold supports: ${holdableList.join(', ')}`);
      }
      writeTerminalLine("Use 'hold list' to view supported commands.");
      return;
    }

    const holdId = holdIdCounter++;
    const displayLabel = (label && label.length) ? label : (command.label || invoked);
    const snapshot = {
      name: resolved.name,
      args: Array.isArray(resolved.args) ? [...resolved.args] : [],
      label: displayLabel,
      invokedName: invoked,
      tokens: resolved.tokens ? [...resolved.tokens] : []
    };

    const invoke = () => runResolvedCommand(
      {
        name: snapshot.name,
        args: Array.isArray(snapshot.args) ? [...snapshot.args] : [],
        label: snapshot.label,
        invokedName: snapshot.invokedName,
        tokens: Array.isArray(snapshot.tokens) ? [...snapshot.tokens] : []
      },
      {
        fromHold: true,
        holdId,
        raw: snapshot.label,
        input: snapshot.label
      }
    );

    const initialOk = invoke();
    if(!initialOk){
      writeTerminalLine(`Hold #${holdId} aborted for '${displayLabel}'.`);
      return;
    }

    const intervalId = setInterval(()=>{
      const ok = invoke();
      if(!ok){
        clearInterval(intervalId);
        holdRegistry.delete(holdId);
        writeTerminalLine(`Hold #${holdId} stopped due to command failure.`);
      }
    }, HOLD_INTERVAL_MS);
    holdRegistry.set(holdId, { intervalId, label: displayLabel, snapshot });
    writeTerminalLine(`Holding #${holdId}: ${displayLabel} (every ${HOLD_INTERVAL_MS/1000}s)`);
  }

  function stopAllHolds({ silent = false } = {}){
    if(!holdRegistry.size) return [];
    const released = [];
    holdRegistry.forEach((entry, id) => {
      clearInterval(entry.intervalId);
      released.push({ id, label: entry.label });
    });
    holdRegistry.clear();
    if(!silent && released.length){
      const summary = released.map(item => `#${item.id}`).join(', ');
      console.log('app.js: released holds', summary);
    }
    return released;
  }

  function appendPrompt(inputValue){
    const channel = activePiSelection ? channelForPi(activePiSelection.id) : TERMINAL_CHANNEL_GLOBAL;
    writeTerminalLine(`> ${inputValue}`, { channel });
  }

  const commandCatalog = {
    help: {
      description: 'Show available commands',
      usage: 'help',
      allowHold: true,
      action(ctx){
        const padWidth = 18;
        ctx.write('Available commands:');
        Object.entries(commandCatalog).forEach(([name, info]) => {
          if(info && info.showInHelp === false) return;
          const displayName = info.label || name;
          const desc = info.description || '';
          ctx.write(`  ${displayName.padEnd(padWidth)} ${desc}`.trimEnd());
          if(info.usage && info.usage !== displayName){
            ctx.write(`      usage: ${info.usage}`);
          }
        });
        const holdable = getHoldableCommandNames();
        if(holdable.length){
          ctx.write(`Hold-ready commands: ${holdable.join(', ')}`);
        }else{
          ctx.write('Hold-ready commands: none');
        }
        if(holdRegistry.size){
          const summary = Array.from(holdRegistry.entries()).map(([id, entry])=>`#${id} (${entry.label})`).join(', ');
          ctx.write(`Active holds: ${summary}`);
        }else{
          ctx.write('Active holds: none');
        }
      }
    },
    hold: {
      description: 'Repeat another command every second',
      usage: 'hold <command>',
      action(ctx){
        const holdable = getHoldableCommandNames();
        const sub = (ctx.args[0] || '').toLowerCase();
        const isList = ['list','--list','-l'].includes(sub);
        const isHelp = ['help','--help','-h','?'].includes(sub);
        const refreshSeconds = Math.max(0.2, HOLD_INTERVAL_MS / 1000);
        const listLine = holdable.length ? `Hold-ready commands: ${holdable.join(', ')}` : 'Hold-ready commands: none';

        const showBasics = ()=>{
          ctx.write('Usage: hold <command>');
          ctx.write(`Refresh interval: ${refreshSeconds}s`);
          ctx.write(listLine);
          ctx.write('Use release to clear all holds.');
          ctx.write('Example: hold stats');
        };

        if(isList){
          ctx.write(listLine);
          return;
        }
        if(isHelp){
          showBasics();
          return;
        }
        if(ctx.args.length){
          ctx.write('To hold a command, run: hold <command>');
          showBasics();
          return;
        }
        showBasics();
      }
    },
    release: {
      description: 'Release all active holds',
      usage: 'release',
      action(ctx){
        if(ctx.args && ctx.args.length){
          ctx.write('release ignores additional parameters; clearing all holds.');
        }
        const released = stopAllHolds();
        if(!released.length){
          ctx.write('No active holds to release.');
          return;
        }
        const summary = released.map(item => `#${item.id} (${item.label})`).join(', ');
        ctx.write(`Released holds: ${summary}.`);
      }
    },
    ping: {
      description: 'Test latency to core systems',
      usage: 'ping',
      allowHold: true,
      action(ctx){
        const latency = (20 + Math.random()*80).toFixed(0);
        ctx.write(`PONG ${latency}ms`);
      }
    },
    color: {
      description: 'Change the UI accent/preset',
      usage: `color <${Object.keys(themePresets).join('|')}|#hex>`,
      action(ctx){
        const choice = ctx.args[0];
        if(!choice){
          ctx.write(`Usage: ${commandCatalog.color.usage}`);
          return;
        }
        const key = choice.toLowerCase();
        if(themePresets[key]){
          applyThemePreset(key);
          ctx.write(`Applied ${key} theme.`);
          return;
        }
        const normalized = applyAccentHex(choice);
        if(normalized){
          ctx.write(`Accent color set to ${normalized}.`);
          return;
        }
        ctx.write(`Unknown color "${choice}".`);
        ctx.write(`Presets: ${Object.keys(themePresets).join(', ')}`);
      }
    },
    clear: {
      description: 'Clear the terminal buffer',
      usage: 'clear',
      action(ctx){
        ctx.clear();
      }
    },
    echo: {
      description: 'Echo the provided text',
      usage: 'echo <message>',
      allowHold: true,
      action(ctx){
        if(!ctx.args.length){
          ctx.write('Usage: echo <message>');
          return;
        }
        ctx.write(ctx.args.join(' '));
      }
    },
    uptime: {
      description: 'Show UI session uptime',
      usage: 'uptime',
      allowHold: true,
      action(ctx){
        const diff = Date.now() - bootTimestamp;
        const seconds = Math.floor(diff / 1000);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        const pad = n => n.toString().padStart(2,'0');
        ctx.write(`Uptime: ${pad(hours)}:${pad(minutes)}:${pad(secs)}`);
      }
    },
    stats: {
      description: 'Snapshot the stats panel values',
      usage: 'stats',
      allowHold: true,
      action(ctx){
        const entries = collectStats();
        if(!entries.length){
          ctx.write('No stats currently available.');
          return;
        }
        entries.forEach(entry => {
          const task = entry.task ? ` — ${entry.task}` : '';
          ctx.write(`${entry.label}${task} | CPU ${entry.cpu} | RAM ${entry.ram}`);
        });
      }
    },
    logs: {
      description: 'Show recent log entries',
      usage: 'logs [count]',
      allowHold: true,
      action(ctx){
        if(!logList){
          ctx.write('Log channel not available.');
          return;
        }
        const count = Math.max(1, Math.min(20, Number(ctx.args[0]) || 5));
        const entries = Array.from(logList.querySelectorAll('.log-entry'));
        if(!entries.length){
          ctx.write('No log entries recorded yet.');
          return;
        }
        ctx.write(`Showing ${Math.min(count, entries.length)} of ${entries.length} logs:`);
        entries.slice(0, count).forEach(entry => ctx.write(entry.textContent));
      }
    },
    clearlogs: {
      label: 'clear logs',
      description: 'Clear the log panel entries',
      action(ctx){
        if(!logList){
          ctx.write('Log channel not available.');
          return;
        }
        logList.innerHTML = '';
        ctx.write('Log buffer cleared.');
      }
    },
    task: {
      description: 'List or run backend tasks',
      usage: 'task [list|run <task-id> [pi-id]|assign <machine> <task-label>]',
      action(ctx){
        if(!socket){
          ctx.write('Socket interface unavailable.');
          return;
        }
        const sub = (ctx.args[0] || '').toLowerCase();
        if(!sub || sub === 'list'){
          if(!knownTasks.size){
            ctx.write('Task catalog not available yet. Waiting for controller...');
            if(socketState.isConnected){
              socket.emit('catalog:request');
            }
            return;
          }
          ctx.write('Available tasks:');
          knownTasks.forEach((info, id) => {
            const desc = info && info.description ? ' - ' + info.description : '';
            ctx.write(`  ${id}${desc}`);
          });
          ctx.write('Run with: task run <task-id> [pi-id]');
          ctx.write('Assign label: task assign <machine> <task-label>');
          return;
        }

        if(sub === 'run'){
          const taskId = ctx.args[1];
          const targetPi = ctx.args[2] || 'local';
          if(!taskId){
            ctx.write('Usage: task run <task-id> [pi-id]');
            return;
          }
          if(!knownTasks.has(taskId)){
            ctx.write(`Task '${taskId}' not recognised.`);
            ctx.write('Use task list to view available tasks.');
            return;
          }
          if(!socketState.isConnected){
            ctx.write('Controller connection offline; cannot run task.');
            return;
          }
          ctx.write(`Dispatching task '${taskId}' to ${targetPi}...`);
          socket.emit('run_task', { task: taskId, pi_id: targetPi }, ack => {
            if(!ack){
              ctx.write('No acknowledgement from controller.');
              return;
            }
            if(ack.error){
              ctx.write(`Controller rejected task: ${ack.error}`);
              return;
            }
            if(ack.request_id){
              pendingTasks.set(ack.request_id, { taskId, piId: targetPi });
            }
            ctx.write(ack.message || 'Task accepted.');
          });
          return;
        }

        if(sub === 'assign'){
          if(ctx.args.length < 3){
            ctx.write('Usage: task assign <machine> <task-label>');
            return;
          }
          if(!socketState.isConnected){
            ctx.write('Controller connection offline; cannot assign task.');
            return;
          }
          const piRef = ctx.args[1];
          const taskLabel = ctx.args.slice(2).join(' ').trim();
          if(!taskLabel){
            ctx.write('Provide a task label to assign.');
            return;
          }
          ctx.write(`Assigning '${taskLabel}' to ${piRef}...`);
          socket.emit('assign_task', { pi: piRef, task: taskLabel }, ack => {
            if(!ack){
              ctx.write('No acknowledgement from controller.');
              return;
            }
            if(ack.error){
              ctx.write(`Controller rejected assignment: ${ack.error}`);
              return;
            }
            ctx.write(ack.message || 'Assignment recorded.');
          });
          return;
        }

        ctx.write('Usage: task [list|run <task-id> [pi-id]|assign <machine> <task-label>]');
      }
    },
    assign: {
      description: 'Assign metadata to a machine',
      usage: 'assign name <machine> <new-name>',
      action(ctx){
        if(!socket){
          ctx.write('Socket interface unavailable.');
          return;
        }
        const sub = (ctx.args[0] || '').toLowerCase();
        if(sub === 'name'){
          if(ctx.args.length < 3){
            ctx.write('Usage: assign name <machine> <new-name>');
            return;
          }
          if(!socketState.isConnected){
            ctx.write('Controller connection offline; cannot rename machine.');
            return;
          }
          const piRef = ctx.args[1];
          const newName = ctx.args.slice(2).join(' ').trim();
          if(!piRef){
            ctx.write('Specify the machine to rename.');
            return;
          }
          if(!newName){
            ctx.write('Specify the new name.');
            return;
          }
          ctx.write(`Renaming ${piRef} to '${newName}'...`);
          socket.emit('assign_name', { pi: piRef, name: newName }, ack => {
            if(!ack){
              ctx.write('No acknowledgement from controller.');
              return;
            }
            if(ack.error){
              ctx.write(`Controller rejected rename: ${ack.error}`);
              return;
            }
            ctx.write(ack.message || 'Rename recorded.');
          });
          return;
        }

        ctx.write('Usage: assign name <machine> <new-name>');
      }
    },
    
  };

  function executeCommand(inputRaw){
    const trimmed = inputRaw.trim();
    if(!trimmed) return;
    if(activePiSelection){
      sendTerminalCommand(trimmed);
      return;
    }
    const tokens = tokenizeCommand(trimmed);
    if(!tokens.length) return;
    const primary = (tokens[0] || '').toLowerCase();

    if(primary === 'hold'){
      const holdTokens = tokens.slice(1);
      const infoKey = (holdTokens[0] || '').toLowerCase();
      const treatAsInfo = !holdTokens.length || ['--help','-h','help','?','list','--list','-l'].includes(infoKey);
      if(treatAsInfo){
        runResolvedCommand(
          {
            name: 'hold',
            args: holdTokens,
            label: 'hold',
            invokedName: tokens[0],
            tokens: [...tokens]
          },
          { raw: trimmed, input: inputRaw }
        );
        return;
      }
      const resolvedHold = resolveCommand(holdTokens);
      if(!resolvedHold.name){
        const unknown = holdTokens[0] || '';
        if(unknown){
          writeTerminalLine(`Command not recognized: ${unknown}`);
        }else{
          writeTerminalLine('Unable to determine command to hold.');
        }
        writeTerminalLine("Type 'help' to list available commands.");
        runResolvedCommand(
          {
            name: 'hold',
            args: ['list'],
            label: 'hold',
            invokedName: tokens[0],
            tokens: [...tokens]
          },
          { raw: trimmed, input: inputRaw }
        );
        return;
      }
      const label = resolvedHold.label || holdTokens.join(' ');
      startHold(resolvedHold, label);
      return;
    }

    const resolved = resolveCommand(tokens);
    if(!resolved.name){
      return;
    }
    runResolvedCommand(resolved, { raw: trimmed, input: inputRaw });
  }

  if(buttons.length===0) console.warn('app.js: no .boot-btn elements found');
  buttons.forEach(b=>{
    b.addEventListener('click', (ev)=>{
      // ignore the fullscreen control (it has its own handler)
      if(b.id === 'term-fullscreen' || b.classList.contains('term-fullscreen-btn')){
        return;
      }
      const t = b.dataset.target;
      console.log('app.js: button click ->', t);
      showTab(t);
      // re-align numpad when panels change
      alignNumpad();
      if(t === 'terminal'){
        clearPiSelection();
      }
    });
  });

  // Terminal typewriter
  const lines = [
    '== PI STAT V0.9.7 ==',
    'Initializing diagnostics...',
    'Loading sensor drivers: OK',
    'Checking CPU cores: OK',
    'Reading memory map: OK',
    'Starting telemetry streams...',
    'System stable. Use boot bar controls to switch panels.',
    "Type 'help' to list console commands."
  ];

  function typeLines(el, idx=0){
    if(!el) return console.warn('typeLines: terminal element not found');
    if(idx>=lines.length) return appendLog('Terminal ready.');
    const line = lines[idx];
    let i=0;
    const span = document.createElement('span');
    span.dataset.channel = TERMINAL_CHANNEL_GLOBAL;
    el.appendChild(span);
    applyTerminalFilterToLine(span);

    const tick = setInterval(()=>{
      span.textContent = line.substring(0,i+1);
      scrollTerminalToBottom();
      i++;
      if(i>=line.length){
        clearInterval(tick);
        const newline = document.createElement('span');
        newline.className = 'terminal-break';
        newline.dataset.channel = TERMINAL_CHANNEL_GLOBAL;
        newline.textContent = '\n';
        el.appendChild(newline);
        applyTerminalFilterToLine(newline);
        scrollTerminalToBottom();
        setTimeout(()=>typeLines(el, idx+1), 300);
      }
    }, 28 + Math.random()*40);
  }

  function appendLog(text){
    if(!logList) return;
    const d = document.createElement('div');
    d.className = 'log-entry';
    d.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logList.insertBefore(d, logList.firstChild);
  }

  // Stats animation
  function animateStats(targetNodes){
    const vals = targetNodes
      ? Array.from(targetNodes).filter(Boolean)
      : Array.from(document.querySelectorAll('.metric .value[data-target]'));
    vals.forEach(v=>{
      const target = parseFloat(v.dataset.target || '0');
      const unit = v.dataset.unit || '';
      const decimals = Number(v.dataset.decimals || 0);
      const startValue = parseFloat(v.dataset.current || v.dataset.start || '0');
      const safeStart = Number.isFinite(startValue) ? startValue : 0;
      const safeTarget = Number.isFinite(target) ? target : 0;
      const duration = 1200 + Math.random()*900;
      const startTime = performance.now();
      function frame(now){
        const t = Math.min(1, (now-startTime)/duration);
        const raw = safeStart + (safeTarget - safeStart) * t;
        const formatted = decimals > 0 ? raw.toFixed(decimals) : Math.round(raw).toString();
        v.textContent = unit ? `${formatted}${unit}` : formatted;
        v.dataset.current = decimals > 0 ? raw.toFixed(decimals) : raw.toString();
        if(t<1){
          requestAnimationFrame(frame);
        }else{
          const finalFormatted = decimals > 0 ? safeTarget.toFixed(decimals) : Math.round(safeTarget).toString();
          v.textContent = unit ? `${finalFormatted}${unit}` : finalFormatted;
          v.dataset.current = decimals > 0 ? safeTarget.toFixed(decimals) : safeTarget.toString();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  const piGrid = document.querySelector('.pi-grid');
  const activatePiFromCard = card => {
    if(!card) return;
    const piId = card.dataset.pi;
    if(!piId) return;
    const labelEl = card.querySelector('.pi-label');
    const label = labelEl ? labelEl.textContent.trim() : piId;
    selectPiCard(card, piId, label);
  };

  if(piGrid){
    piGrid.addEventListener('click', ev => {
      const card = ev.target.closest('.pi-card');
      if(!card) return;
      ev.preventDefault();
      activatePiFromCard(card);
    });
    piGrid.addEventListener('keydown', ev => {
      if(ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      const card = ev.target.closest('.pi-card');
      if(!card) return;
      ev.preventDefault();
      activatePiFromCard(card);
    });
  }

  function setupSocket(){
    if(!socket){
      appendLog('Socket.IO client unavailable; realtime features disabled.');
      return;
    }

    socket.on('connect', ()=>{
      socketState.isConnected = true;
      pendingTasks.clear();
      appendLog('Connected to controller.');
      socket.emit('catalog:request');
    });

    socket.on('disconnect', ()=>{
      socketState.isConnected = false;
      appendLog('Disconnected from controller.');
    });

    socket.on('stats_snapshot', handleStatsSnapshot);
    socket.on('task_catalog', handleTaskCatalog);

    socket.on('pi_console', payload => {
      if(!payload) return;
      const piId = payload.pi_id || 'unknown';
      const line = payload.line || '';
      if(!line) return;
      const channel = channelForPi(piId);
      removeEmptyBanner(channel);
      writeTerminalLine(line, { className: 'pi-console-line', channel });
    });

    socket.on('terminal_started', payload => {
      if(!payload) return;
      const piId = payload.pi_id || 'unknown';
      const requestId = payload.request_id;
      if(requestId){ pendingTerminal.set(requestId, { piId }); }
      const command = payload.command ? `: ${payload.command}` : '';
      const channel = channelForPi(piId);
      removeEmptyBanner(channel);
      writeTerminalLine(`[terminal] ${piId} started${command}`, { channel, className: 'terminal-banner' });
    });

    socket.on('terminal_output', payload => {
      if(!payload || !payload.line) return;
      const piId = payload.pi_id || 'unknown';
      const channel = channelForPi(piId);
      removeEmptyBanner(channel);
      writeTerminalLine(payload.line, { channel });
    });

    socket.on('terminal_finished', payload => {
      if(!payload) return;
      const piId = payload.pi_id || 'unknown';
      const channel = channelForPi(piId);
      const requestId = payload.request_id;
      if(requestId) pendingTerminal.delete(requestId);
      const exitCode = payload.exit_code;
      const ok = exitCode === 0 || exitCode === null || exitCode === undefined;
      const message = ok ? 'completed successfully' : `exited with code ${exitCode}`;
      writeTerminalLine(`[terminal] ${piId} ${message}`, { channel, className: 'terminal-banner' });
    });

    socket.on('terminal_error', payload => {
      if(!payload) return;
      const piId = payload.pi_id || 'unknown';
      const channel = channelForPi(piId);
      const requestId = payload.request_id;
      if(requestId) pendingTerminal.delete(requestId);
      const err = payload.error || 'Unknown error';
      writeTerminalLine(`[terminal] ${piId} failed: ${err}`, { channel, className: 'terminal-banner' });
    });

    socket.on('log', payload => {
      if(payload && payload.message){
        appendLog(payload.message);
      }
    });

    socket.on('task_started', payload => {
      if(!payload) return;
      const label = resolveTaskLabel(payload);
      const piId = payload.pi_id || 'local';
      const channel = channelForPi(piId);
      if(payload.request_id){
        pendingTasks.set(payload.request_id, { taskId: payload.task_id, piId });
      }
      removeEmptyBanner(channel);
      writeTerminalLine(`[task] ${label} started on ${piId}.`, { channel });
    });

    socket.on('task_output', payload => {
      if(!payload || !payload.line) return;
      const piId = payload.pi_id || (payload.request_id && pendingTasks.get(payload.request_id)?.piId) || 'local';
      const channel = channelForPi(piId);
      removeEmptyBanner(channel);
      writeTerminalLine(payload.line, { className: 'task-output', channel });
    });

    socket.on('task_finished', payload => {
      if(!payload) return;
      const piId = payload.pi_id || (payload.request_id && pendingTasks.get(payload.request_id)?.piId) || 'local';
      if(payload.request_id) pendingTasks.delete(payload.request_id);
      const label = resolveTaskLabel(payload);
      const exitCode = payload.exit_code;
      const ok = exitCode === 0 || exitCode === null || exitCode === undefined;
      const message = ok ? 'completed successfully' : `exited with code ${exitCode}`;
      const channel = channelForPi(piId);
      removeEmptyBanner(channel);
      writeTerminalLine(`[task] ${label} on ${piId} ${message}.`, { channel });
    });

    socket.on('task_error', payload => {
      if(!payload) return;
      const piId = payload.pi_id || (payload.request_id && pendingTasks.get(payload.request_id)?.piId) || 'local';
      if(payload.request_id) pendingTasks.delete(payload.request_id);
      const label = resolveTaskLabel(payload);
      const msg = payload.error || 'Unknown error';
      const channel = channelForPi(piId);
      removeEmptyBanner(channel);
      writeTerminalLine(`[task] ${label} on ${piId} failed: ${msg}`, { channel });
    });
  }

  // Kick things off
  setupSocket();
  typeLines(terminal);
  animateStats();
  // position numpad initially and on resize
  alignNumpad();
  window.addEventListener('resize', alignNumpad);
  window.addEventListener('beforeunload', ()=>stopAllHolds({ silent: true }));
  window.addEventListener('pagehide', ()=>stopAllHolds({ silent: true }));

  // Command panel behavior
  const cmdForm = document.getElementById('cmd-form');
  const cmdInput = document.getElementById('cmd-input');
  if(cmdForm && cmdInput){
    cmdForm.addEventListener('submit', (ev)=>{
      ev.preventDefault();
      const rawValue = cmdInput.value;
      if(!rawValue.trim()) return;
      appendPrompt(rawValue);
      executeCommand(rawValue);
      cmdInput.value = '';
      // focus only if native on-screen keyboard is allowed
      safeFocus();
    });
  }

  // Helper to focus input only when we do not intend to suppress the native on-screen keyboard
  function safeFocus(){
    try{
      if(!cmdInput) return;
      // if the input is marked to disable OSK (readonly + data-disable-osk), avoid focusing
      const disable = cmdInput.hasAttribute('readonly') || cmdInput.dataset.disableOsk === 'true' || cmdInput.getAttribute('readonly') !== null;
      if(disable) return;
      cmdInput.focus();
    }catch(err){ /* no-op */ }
  }

  // If input is readonly and intended to use on-page keyboard, intercept touch/click so native OSK isn't triggered
  try{
    if(cmdInput && (cmdInput.hasAttribute('readonly') || cmdInput.dataset.disableOsk === 'true')){
      const qwertyEl = document.getElementById('qwerty');
      const openKeyboard = (ev)=>{
        // prevent the native keyboard from opening on touch devices
        ev.preventDefault();
        // optionally, signal visually that the on-screen keyboard should be used
        if(qwertyEl) qwertyEl.classList.add('kbd-open');
        // ensure the form submit button remains reachable for accessibility
        cmdInput.setAttribute('aria-expanded','true');
      };
      cmdInput.addEventListener('touchstart', openKeyboard, {passive:false});
      cmdInput.addEventListener('mousedown', (e)=>{ e.preventDefault(); openKeyboard(e); });
    }
  }catch(err){ console.warn('app.js: safeFocus/init touch interception failed', err); }

  // HUD removed — terminal sizing already guards for missing .hud element

  // Numpad for touchscreens: delegated handler on the #numpad container
  try{
    const numpadEl = document.getElementById('numpad');
    if(numpadEl){
      numpadEl.addEventListener('click', (ev)=>{
        const btn = ev.target.closest ? ev.target.closest('.num-btn') : null;
        if(!btn) return;
        ev.preventDefault();
        const key = btn.dataset.key;
        if(!cmdInput) return;
        if(key === 'back'){
          cmdInput.value = cmdInput.value.slice(0,-1);
          safeFocus();
          return;
        }
        if(key === 'enter'){
          if(cmdForm) cmdForm.requestSubmit ? cmdForm.requestSubmit() : cmdForm.dispatchEvent(new Event('submit',{cancelable:true, bubbles:true}));
          return;
        }
        cmdInput.value = cmdInput.value + (key || '');
        safeFocus();
      }, {passive:false});
    }
  }catch(err){ console.warn('app.js: numpad init failed', err); }

  try{
    const symbolPadEl = document.getElementById('symbol-pad');
    if(symbolPadEl){
      symbolPadEl.addEventListener('click', (ev)=>{
        const btn = ev.target.closest ? ev.target.closest('.sym-btn') : null;
        if(!btn) return;
        ev.preventDefault();
        if(!cmdInput) return;
        const key = btn.dataset.key || '';
        cmdInput.value = cmdInput.value + key;
        safeFocus();
      }, {passive:false});
    }
  }catch(err){ console.warn('app.js: symbol pad init failed', err); }

  // QWERTY on-screen keyboard handling
  try{
    const keyButtons = document.querySelectorAll('#qwerty .key-btn');
    let shiftOn = false;
    const shiftBtn = document.getElementById('shift');
    function applyChar(ch){
      if(!cmdInput) return;
      if(shiftOn){ ch = ch.toUpperCase(); }
      cmdInput.value = cmdInput.value + ch;
      safeFocus();
      // if shift is single-use, turn off after one key (optional). We'll keep as a toggle.
    }
    keyButtons.forEach(k=>{
      k.addEventListener('click', ()=>{
        const key = k.dataset.key;
        if(!cmdInput) return;
        if(key === 'back'){
          cmdInput.value = cmdInput.value.slice(0,-1);
          safeFocus();
          return;
        }
        if(key === 'enter'){
          if(cmdForm) cmdForm.requestSubmit ? cmdForm.requestSubmit() : cmdForm.dispatchEvent(new Event('submit',{cancelable:true, bubbles:true}));
          return;
        }
        if(key === 'space'){
          cmdInput.value = cmdInput.value + ' ';
          safeFocus();
          return;
        }
        if(key === 'shift'){
          shiftOn = !shiftOn;
          if(shiftBtn) shiftBtn.classList.toggle('active', shiftOn);
          return;
        }
        // regular character (some keys may have data-label for display)
        const ch = k.dataset.key || k.getAttribute('data-label') || k.textContent;
        applyChar(ch);
      });
    });
  }catch(err){ console.warn('app.js: qwerty init failed', err); }

  // Enable click-and-drag scrolling inside the terminal (pointer events)
  try{
    const termInner = document.querySelector('.terminal-inner');
    if(termInner){
      const blockNativeScroll = e => {
        e.preventDefault();
      };
      termInner.addEventListener('wheel', blockNativeScroll, {passive:false});
      termInner.addEventListener('touchmove', blockNativeScroll, {passive:false});
      let isDown = false, startY = 0, startScroll = 0, activePointerId = null;
      termInner.style.cursor = 'grab';

      termInner.addEventListener('pointerdown', (e)=>{
        // only respond to primary button
        if(e.isPrimary === false) return;
        isDown = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        startScroll = termInner.scrollTop;
        termInner.setPointerCapture(activePointerId);
        termInner.classList.add('dragging');
      });

      termInner.addEventListener('pointermove', (e)=>{
        if(!isDown || e.pointerId !== activePointerId) return;
        const delta = e.clientY - startY;
        termInner.scrollTop = startScroll - delta;
      });

      const stopDrag = (e)=>{
        if(!isDown) return;
        try{ termInner.releasePointerCapture(activePointerId); }catch(err){}
        isDown = false; activePointerId = null; termInner.classList.remove('dragging');
      };

      termInner.addEventListener('pointerup', stopDrag);
      termInner.addEventListener('pointercancel', stopDrag);
      termInner.addEventListener('pointerleave', stopDrag);
    }
  }catch(err){ console.warn('app.js: drag-to-scroll setup failed', err); }

  // Terminal fullscreen toggle: staged animation with smooth frame morphing
  try{
    const screenEl = document.querySelector('.screen');
    const termBtn = document.getElementById('term-fullscreen');
    const terminalInner = document.querySelector('.terminal-inner');
    const fullscreenTimers = [];
    const STAGE_DELAY = 240; // ms gap between animation stages for a choreographed sequence
    const STAGE_CLASSES = ['fs-stage-horizontal','fs-stage-numpad','fs-stage-vertical','fs-stage-keyboard'];
    const FS_EASE = 'cubic-bezier(.2,.9,.25,1)';
    const fullscreenState = {
      savedFrameStyle: '',
      savedRect: null,
      savedMetrics: null,
      savedInnerStyle: null,
      savedInnerHeight: null,
      placeholder: null,
      active: false
    };

    const clearFullscreenTimers = ()=>{
      while(fullscreenTimers.length){
        clearTimeout(fullscreenTimers.pop());
      }
    };

    const removeStageClasses = ()=>{
      if(!screenEl) return;
      STAGE_CLASSES.forEach(cls => screenEl.classList.remove(cls));
    };

    const queueStage = (callback, delay)=>{
      const id = window.setTimeout(callback, delay);
      fullscreenTimers.push(id);
    };

    const getTermFrame = ()=>document.querySelector('.terminal-frame');

    const prepareTerminalInner = ()=>{
      if(!terminalInner) return;
      fullscreenState.savedInnerStyle = {
        transition: terminalInner.style.transition,
        height: terminalInner.style.height
      };
      const innerRect = terminalInner.getBoundingClientRect();
      fullscreenState.savedInnerHeight = innerRect ? innerRect.height : null;
      terminalInner.style.transition = `height .6s ${FS_EASE}`;
      if(innerRect && innerRect.height){
        terminalInner.style.height = `${innerRect.height}px`;
      }
    };

    const restoreTerminalInner = ()=>{
      if(!terminalInner) return;
      if(fullscreenState.savedInnerStyle){
        terminalInner.style.transition = fullscreenState.savedInnerStyle.transition || '';
        terminalInner.style.height = fullscreenState.savedInnerStyle.height || '';
      }else{
        terminalInner.style.transition = '';
        terminalInner.style.height = '';
      }
      fullscreenState.savedInnerStyle = null;
      fullscreenState.savedInnerHeight = null;
    };

    const applyFullscreenInnerHeight = ()=>{
      if(!terminalInner) return;
      const bootBar = document.querySelector('.boot-bar');
      const bootH = bootBar ? Math.ceil(bootBar.getBoundingClientRect().height) : 64;
      const topGutter = 5;
      const bottomGutter = 5;
      const available = Math.max(200, window.innerHeight - topGutter - bottomGutter - bootH);
      terminalInner.style.height = available + 'px';
    };

    const prepareTerminalFrame = ()=>{
      const termFrame = getTermFrame();
      if(!termFrame) return null;
      const rect = termFrame.getBoundingClientRect();
      const computed = window.getComputedStyle(termFrame);
      const widthPx = parseFloat(computed.width) || rect.width;
      const heightPx = parseFloat(computed.height) || rect.height;
      fullscreenState.savedRect = rect;
      fullscreenState.savedFrameStyle = termFrame.getAttribute('style') || '';
      fullscreenState.savedMetrics = {
        width: widthPx,
        height: heightPx,
        top: rect.top,
        left: rect.left
      };
      const placeholder = document.createElement('div');
      placeholder.style.display = computed.display === 'inline' ? 'inline-block' : (computed.display || 'block');
      placeholder.style.width = computed.width;
      placeholder.style.height = `${heightPx}px`;
      placeholder.style.marginTop = computed.marginTop;
      placeholder.style.marginRight = computed.marginRight;
      placeholder.style.marginBottom = computed.marginBottom;
      placeholder.style.marginLeft = computed.marginLeft;
      placeholder.style.visibility = 'hidden';
      placeholder.style.pointerEvents = 'none';
      if(termFrame.parentNode){
        termFrame.parentNode.insertBefore(placeholder, termFrame);
        fullscreenState.placeholder = placeholder;
      }
      termFrame.style.transition = `top .6s ${FS_EASE}, left .6s ${FS_EASE}, width .6s ${FS_EASE}, height .6s ${FS_EASE}`;
      termFrame.style.position = 'fixed';
      termFrame.style.top = `${rect.top}px`;
      termFrame.style.left = `${rect.left}px`;
      termFrame.style.width = `${widthPx}px`;
      termFrame.style.height = `${heightPx}px`;
      termFrame.style.right = 'auto';
      termFrame.style.bottom = 'auto';
      termFrame.style.margin = '0';
      termFrame.style.zIndex = '1110';
      termFrame.style.maxWidth = 'none';
      termFrame.style.minWidth = '0';
      termFrame.style.boxSizing = computed.boxSizing || 'border-box';
      return termFrame;
    };

    const animateFrameVertical = termFrame => {
      if(!termFrame) return;
      const bootBar = document.querySelector('.boot-bar');
      const bootH = bootBar ? Math.ceil(bootBar.getBoundingClientRect().height) : 64;
      const topGutter = 5;
      const bottomGutter = 5;
      const targetHeight = Math.max(220, window.innerHeight - topGutter - bottomGutter - bootH);
      termFrame.style.top = `${topGutter}px`;
      termFrame.style.height = `${targetHeight}px`;
    };

    const animateFrameHorizontal = termFrame => {
      if(!termFrame) return;
      const sideGutter = 5;
      const targetWidth = Math.max(320, window.innerWidth - sideGutter * 2);
      termFrame.style.left = `${sideGutter}px`;
      termFrame.style.width = `${targetWidth}px`;
    };

    const restoreTerminalFrame = ()=>{
      const termFrame = getTermFrame();
      if(!termFrame) return;
      if(fullscreenState.savedFrameStyle){
        termFrame.setAttribute('style', fullscreenState.savedFrameStyle);
      }else{
        termFrame.removeAttribute('style');
      }
      fullscreenState.savedFrameStyle = '';
      fullscreenState.savedRect = null;
      fullscreenState.savedMetrics = null;
      if(fullscreenState.placeholder && fullscreenState.placeholder.parentNode){
        fullscreenState.placeholder.parentNode.removeChild(fullscreenState.placeholder);
      }
      fullscreenState.placeholder = null;
    };

    function enterFullscreen(){
      if(!screenEl) return;
      clearFullscreenTimers();
      removeStageClasses();
      const termFrame = prepareTerminalFrame();
      if(!termFrame) return;
      prepareTerminalInner();
      screenEl.classList.add('terminal-fullscreen');
      screenEl.classList.add('fs-stage-keyboard');
      if(termBtn){
        termBtn.setAttribute('aria-pressed','true');
        termBtn.setAttribute('aria-label','Exit fullscreen');
        termBtn.textContent = '⤡';
      }

      queueStage(()=>{
        screenEl.classList.add('fs-stage-vertical');
        animateFrameVertical(termFrame);
        applyFullscreenInnerHeight();
      }, STAGE_DELAY);

      queueStage(()=>{
        screenEl.classList.add('fs-stage-numpad');
      }, STAGE_DELAY * 2);

      queueStage(()=>{
        screenEl.classList.add('fs-stage-horizontal');
        animateFrameHorizontal(termFrame);
        window.setTimeout(()=>{
          try{ alignNumpad(); }catch(err){}
        }, 60);
      }, STAGE_DELAY * 3);

      fullscreenState.active = true;
    }

    function exitFullscreen(){
      if(!screenEl) return;
      clearFullscreenTimers();
      const termFrame = getTermFrame();
      if(termBtn){
        termBtn.setAttribute('aria-pressed','false');
        termBtn.setAttribute('aria-label','Enter fullscreen');
        termBtn.textContent = '⤢';
      }

      if(!termFrame){
        removeStageClasses();
        screenEl.classList.remove('terminal-fullscreen');
        restoreTerminalInner();
        fullscreenState.active = false;
        try{
          adjustTerminalForNumpad();
          alignNumpad();
        }catch(err){}
        return;
      }

      queueStage(()=>{
        screenEl.classList.remove('fs-stage-horizontal');
        const saved = fullscreenState.savedMetrics;
        if(saved){
          termFrame.style.left = `${saved.left}px`;
          termFrame.style.width = `${saved.width}px`;
        }
      }, 0);

      queueStage(()=>{
        screenEl.classList.remove('fs-stage-numpad');
      }, STAGE_DELAY);

      queueStage(()=>{
        screenEl.classList.remove('fs-stage-vertical');
        const saved = fullscreenState.savedMetrics;
        if(saved){
          termFrame.style.top = `${saved.top}px`;
          termFrame.style.height = `${saved.height}px`;
        }
        if(terminalInner){
          if(fullscreenState.savedInnerHeight !== null){
            terminalInner.style.height = `${fullscreenState.savedInnerHeight}px`;
          }else{
            terminalInner.style.height = '';
          }
        }
      }, STAGE_DELAY * 2);

      queueStage(()=>{
        screenEl.classList.remove('fs-stage-keyboard');
        screenEl.classList.remove('terminal-fullscreen');
        restoreTerminalInner();
        window.setTimeout(()=>{
          restoreTerminalFrame();
          try{
            adjustTerminalForNumpad();
            alignNumpad();
          }catch(err){}
        }, 320);
        fullscreenState.active = false;
      }, STAGE_DELAY * 3);
    }

    if(termBtn){
      termBtn.addEventListener('click', (ev)=>{
        ev.preventDefault();
        const isFs = screenEl && screenEl.classList.contains('terminal-fullscreen');
        if(isFs) exitFullscreen(); else enterFullscreen();
      });
    }

    window.addEventListener('resize', ()=>{
      if(!screenEl || !screenEl.classList.contains('terminal-fullscreen')) return;
      const termFrame = getTermFrame();
      if(screenEl.classList.contains('fs-stage-vertical')){
        animateFrameVertical(termFrame);
        applyFullscreenInnerHeight();
      }
      if(screenEl.classList.contains('fs-stage-horizontal')){
        animateFrameHorizontal(termFrame);
      }
    });

    window.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape' && screenEl && screenEl.classList.contains('terminal-fullscreen')){
        exitFullscreen();
      }
    });
  }catch(err){ console.warn('app.js: fullscreen init failed', err); }

  // Periodic small updates
  if(!socket){
    setInterval(()=>{
      document.querySelectorAll('.metric .value[data-target]').forEach(v=>{
        const base = Number(v.getAttribute('data-target') || v.dataset.target) || 0;
        v.setAttribute('data-target', base.toString());
      });
      animateStats();
    }, 8000);
  }
});
