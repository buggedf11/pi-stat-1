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
        const ok = e.target.closest && e.target.closest('.terminal-inner, .terminal-output, .log-list');
        if(!ok){ e.preventDefault(); }
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

  function scrollTerminalToBottom(){
    if(!terminal || !terminal.parentElement) return;
    terminal.parentElement.scrollTop = terminal.parentElement.scrollHeight;
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

  function appendPrompt(inputValue){
    writeTerminalLine(`> ${inputValue}`);
  }

  const commandCatalog = {
    help: {
      description: 'Show available commands',
      usage: 'help',
      action(ctx){
        ctx.write('Available commands:');
        Object.entries(commandCatalog).forEach(([name, info]) => {
          ctx.write(`  ${name.padEnd(7)} ${info.description}`);
          if(info.usage && info.usage !== name) ctx.write(`      usage: ${info.usage}`);
        });
      }
    },
    ping: {
      description: 'Test latency to core systems',
      usage: 'ping',
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
      action(ctx){
        const stats = Array.from(document.querySelectorAll('.stat'));
        if(!stats.length){
          ctx.write('No stats currently available.');
          return;
        }
        stats.forEach(stat => {
          const label = stat.querySelector('.label');
          const value = stat.querySelector('.value');
          if(label && value) ctx.write(`${label.textContent.trim()}: ${value.textContent.trim()}`);
        });
      }
    },
    logs: {
      description: 'Show recent log entries',
      usage: 'logs [count]',
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
    }
  };

  function executeCommand(inputRaw){
    const trimmed = inputRaw.trim();
    if(!trimmed) return;
    const tokens = tokenizeCommand(trimmed);
    if(!tokens.length) return;
    const commandName = tokens[0].toLowerCase();
    const command = commandCatalog[commandName];
    const ctx = {
      raw: trimmed,
      input: inputRaw,
      command: commandName,
      args: tokens.slice(1),
      write: writeTerminalLine,
      clear: clearTerminal
    };
    if(command){
      try{
        command.action(ctx);
      }catch(err){
        console.error('app.js: command failed', err);
        writeTerminalLine(`Command '${commandName}' failed: ${err.message || err}`);
      }
    }else{
      writeTerminalLine(`Command not recognized: ${commandName}`);
      writeTerminalLine("Type 'help' to list available commands.");
    }
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
      el.scrollTop = el.scrollHeight;
      i++;
      if(i>=line.length){
        clearInterval(tick);
        el.appendChild(document.createTextNode('\n'));
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
      const target = Number(v.dataset.target) || 0;
      const isTemp = v.previousElementSibling && v.previousElementSibling.textContent.trim()==='TEMP';
      const isUptime = v.previousElementSibling && v.previousElementSibling.textContent.trim()==='UPTIME';
      let start=0, duration=1200 + Math.random()*900;
      const startTime = performance.now();
      function frame(now){
        const t = Math.min(1, (now-startTime)/duration);
        const cur = Math.round(t*target);
        if(isTemp) v.textContent = `${cur}°C`;
        else if(isUptime) v.textContent = `${cur}s`;
        else v.textContent = `${cur}%`;
        if(t<1) requestAnimationFrame(frame);
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
