document.addEventListener('DOMContentLoaded', () => {
  console.log('app.js: DOM ready');
  const buttons = document.querySelectorAll('.boot-btn');
  const panels = document.querySelectorAll('.panel');
  const terminal = document.getElementById('terminal-output');
  const logList = document.getElementById('log-list');
  console.log('app.js: found', buttons.length, 'buttons and', panels.length, 'panels');
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
  }

  // Align numpad top with the terminal-frame top (positions .numpad relative to .panels)
  function alignNumpad(){
    try{
      const numpad = document.getElementById('numpad');
      const terminalFrame = document.querySelector('.terminal-frame');
      const panelsEl = document.querySelector('.panels');
      if(!numpad || !terminalFrame || !panelsEl) return;
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
    return Array.from(document.querySelectorAll('.stat')).map(stat => {
      const labelEl = stat.querySelector('.label');
      const valueEl = stat.querySelector('.value');
      if(!labelEl || !valueEl) return null;
      const metaEl = stat.querySelector('.meta');
      const label = labelEl.textContent.trim();
      const value = valueEl.textContent.trim();
      const description = metaEl ? metaEl.textContent.trim() : (stat.dataset.description || '');
      const index = Number(stat.dataset.pi) || parseInt((label.match(/(\d+)/) || [])[1], 10) || null;
      return { stat, label, value, description, index, valueEl };
    }).filter(Boolean);
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
        ctx.write('Available commands:');
        Object.entries(commandCatalog).forEach(([name, info]) => {
          const displayName = info.label || name;
          ctx.write(`  ${displayName.padEnd(12)} ${info.description}`);
          if(info.usage && info.usage !== displayName) ctx.write(`      usage: ${info.usage}`);
        });
        ctx.write('  hold <command>  Hold a command and refresh every second');
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
          const suffix = entry.description ? ` - ${entry.description}` : '';
          ctx.write(`${entry.label}: ${entry.value}${suffix}`);
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

        const descriptor = entry.description ? ` - ${entry.description}` : '';
        ctx.write(`Monitoring ${entry.label}${descriptor}: ${entry.value}`);
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
      if(!holdTokens.length){
        writeTerminalLine('Usage: hold <command>');
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
  function animateStats(){
    const vals = document.querySelectorAll('.stat .value');
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

  // Kick things off
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
  setInterval(()=>{
    // simulate small stat changes (no-op but safe)
    document.querySelectorAll('.stat .value').forEach(v=>{
      const base = Number(v.getAttribute('data-target') || v.dataset.target) || 0;
      // could add small random wiggle here in future
    });
    animateStats();
    appendLog('Telemetry tick');
  }, 8000);

  // Keyboard shortcuts: disabled Tab-to-cycle behavior so bottom buttons are primary
});
