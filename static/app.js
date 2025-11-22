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

  function showTab(target){
    panels.forEach(p=>p.classList.toggle('active', p.id===target));
    buttons.forEach(b=>b.classList.toggle('active', b.dataset.target===target));
    const numpad = document.getElementById('numpad');
    if(numpad){
      const shouldHide = target !== 'terminal';
      numpad.classList.toggle('hidden', shouldHide);
    }
  }

  // Align numpad top with the terminal-frame top (positions .numpad relative to .panels)
  function alignNumpad(){
    try{
      const numpad = document.getElementById('numpad');
      const terminalFrame = document.querySelector('.terminal-frame');
      const panelsEl = document.querySelector('.panels');
      if(!numpad || !terminalFrame || !panelsEl) return;
      if(numpad.classList.contains('hidden')) return;
      const style = window.getComputedStyle(numpad);
      // Respect small-screen fallback where numpad is fixed
      if(style.position === 'fixed') return;
      const termRect = terminalFrame.getBoundingClientRect();
      const panelsRect = panelsEl.getBoundingClientRect();
      const top = Math.max(0, Math.round(termRect.top - panelsRect.top));
      numpad.style.top = top + 'px';
    }catch(err){ console.warn('app.js: alignNumpad failed', err); }
  }

  const bootTimestamp = Date.now();
  const root = document.documentElement;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const themePresets = {
    green: { accent:'#39ff14', accent2:'#7eff3f', muted:'#63b36b', bg:'#000a00', panel:'#001200' },
    amber: { accent:'#ffb347', accent2:'#ffd166', muted:'#ffc680', bg:'#1d1200', panel:'#2a1a00' },
    blue: { accent:'#5ad1ff', accent2:'#89e0ff', muted:'#7aa6ff', bg:'#00111d', panel:'#001a2b' },
    purple: { accent:'#c77dff', accent2:'#e0aaff', muted:'#b794f6', bg:'#140016', panel:'#1f0026' }
  };

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
    line.textContent = options.noNewline ? content : `${content}\n`;
    if(options.className) line.className = options.className;
    if(options.color) line.style.color = options.color;
    terminal.appendChild(line);
    scrollTerminalToBottom();
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

  function ensurePiCard(piId, label){
    const grid = document.querySelector('.pi-grid');
    if(!grid) return null;
    const idStr = String(piId);
    let card = grid.querySelector(`.pi-card[data-pi="${idStr}"]`);
    if(card){
      const labelEl = card.querySelector('.pi-label');
      if(labelEl && label) labelEl.textContent = label;
      return card;
    }
    card = document.createElement('article');
    card.className = 'pi-card';
    card.dataset.pi = idStr;
    card.dataset.assignedTask = '';
    card.dataset.activeTask = '';
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
    grid.appendChild(card);
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
    writeTerminalLine(`> ${inputValue}`);
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
          ctx.write('Example: hold monitor pi 3');
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
    monitor: {
      description: 'Inspect a specific PI channel',
      usage: 'monitor pi <1-7>',
      allowHold: true,
      action(ctx){
        if(!ctx.args.length){
          ctx.write('Usage: monitor pi <1-7>');
          return;
        }

        let index = null;
        const firstArg = ctx.args[0];
        if(firstArg && firstArg.toLowerCase() === 'pi'){
          const candidate = Number(ctx.args[1]);
          index = Number.isFinite(candidate) ? candidate : null;
        }else{
          const match = (firstArg || '').match(/(\d+)/);
          if(match) index = Number(match[1]);
        }

        if(!Number.isInteger(index) || index < 1 || index > 7){
          ctx.write('Provide a PI channel between 1 and 7.');
          ctx.write('Usage: monitor pi <1-7>');
          return;
        }

        const entries = collectStats();
        if(!entries.length){
          ctx.write('No stats currently available.');
          return;
        }
        const entry = entries.find(item => item.index === index);
        if(!entry){
          ctx.write(`PI ${index} feed unavailable.`);
          return;
        }

        const task = entry.task ? ` — ${entry.task}` : '';
        ctx.write(`Monitoring ${entry.label}${task}: CPU ${entry.cpu} | RAM ${entry.ram}`);
      }
    }
  };

  function executeCommand(inputRaw){
    const trimmed = inputRaw.trim();
    if(!trimmed) return;
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
      const t = b.dataset.target;
      console.log('app.js: button click ->', t);
      showTab(t);
      // re-align numpad when panels change
      alignNumpad();
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
    el.appendChild(span);

    const tick = setInterval(()=>{
      span.textContent = line.substring(0,i+1);
      scrollTerminalToBottom();
      i++;
      if(i>=line.length){
        clearInterval(tick);
        el.appendChild(document.createTextNode('\n'));
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

    socket.on('log', payload => {
      if(payload && payload.message){
        appendLog(payload.message);
      }
    });

    socket.on('task_started', payload => {
      if(!payload) return;
      const label = resolveTaskLabel(payload);
      const piId = payload.pi_id || 'local';
      if(payload.request_id){
        pendingTasks.set(payload.request_id, { taskId: payload.task_id, piId });
      }
      writeTerminalLine(`[task] ${label} started on ${piId}.`);
    });

    socket.on('task_output', payload => {
      if(!payload || !payload.line) return;
      writeTerminalLine(payload.line, { className: 'task-output' });
    });

    socket.on('task_finished', payload => {
      if(!payload) return;
      const piId = payload.pi_id || (payload.request_id && pendingTasks.get(payload.request_id)?.piId) || 'local';
      if(payload.request_id) pendingTasks.delete(payload.request_id);
      const label = resolveTaskLabel(payload);
      const exitCode = payload.exit_code;
      const ok = exitCode === 0 || exitCode === null || exitCode === undefined;
      const message = ok ? 'completed successfully' : `exited with code ${exitCode}`;
      writeTerminalLine(`[task] ${label} on ${piId} ${message}.`);
    });

    socket.on('task_error', payload => {
      if(!payload) return;
      const piId = payload.pi_id || (payload.request_id && pendingTasks.get(payload.request_id)?.piId) || 'local';
      if(payload.request_id) pendingTasks.delete(payload.request_id);
      const label = resolveTaskLabel(payload);
      const msg = payload.error || 'Unknown error';
      writeTerminalLine(`[task] ${label} on ${piId} failed: ${msg}`);
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
      cmdInput.focus();
    });
  }

  // Numpad for touchscreens: append numbers, dot, backspace, and submit
  try{
    const numButtons = document.querySelectorAll('.num-btn');
    if(numButtons.length){
      numButtons.forEach(b=>{
        b.addEventListener('click', ()=>{
          const key = b.dataset.key;
          if(!cmdInput) return;
          if(key === 'back'){
            // remove last char
            cmdInput.value = cmdInput.value.slice(0,-1);
            cmdInput.focus();
            return;
          }
          if(key === 'enter'){
            // submit
            if(cmdForm) cmdForm.requestSubmit ? cmdForm.requestSubmit() : cmdForm.dispatchEvent(new Event('submit',{cancelable:true, bubbles:true}));
            return;
          }
          // append digit or dot
          cmdInput.value = cmdInput.value + key;
          cmdInput.focus();
        });
      });
    }
  }catch(err){ console.warn('app.js: numpad init failed', err); }

  // QWERTY on-screen keyboard handling
  try{
    const keyButtons = document.querySelectorAll('#qwerty .key-btn');
    let shiftOn = false;
    const shiftBtn = document.getElementById('shift');
    function applyChar(ch){
      if(!cmdInput) return;
      if(shiftOn){ ch = ch.toUpperCase(); }
      cmdInput.value = cmdInput.value + ch;
      cmdInput.focus();
      // if shift is single-use, turn off after one key (optional). We'll keep as a toggle.
    }
    keyButtons.forEach(k=>{
      k.addEventListener('click', ()=>{
        const key = k.dataset.key;
        if(!cmdInput) return;
        if(key === 'back'){
          cmdInput.value = cmdInput.value.slice(0,-1);
          cmdInput.focus();
          return;
        }
        if(key === 'enter'){
          if(cmdForm) cmdForm.requestSubmit ? cmdForm.requestSubmit() : cmdForm.dispatchEvent(new Event('submit',{cancelable:true, bubbles:true}));
          return;
        }
        if(key === 'space'){
          cmdInput.value = cmdInput.value + ' ';
          cmdInput.focus();
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
