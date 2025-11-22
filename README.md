# Pi Stat

Dashboard for monitoring Raspberry Pi nodes and launching repeatable maintenance tasks. The controller ( `main.py` ) is a Flask app backed by Socket.IO; it broadcasts CPU and RAM usage in real time and relays terminal output for approved commands.

## Features
- Live CPU/RAM feed for each registered Pi via WebSockets
- Built-in catalogue of safe maintenance tasks (`task list` inside the web terminal)
- Streaming terminal output when tasks run on the controller or a remote Pi
- Retro-styled UI that mirrors data across terminal, stats, and logs panels

## Getting Started
1. Create a virtual environment (optional but recommended).
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Start the controller:
   ```bash
   python main.py
   ```
4. Browse to `http://localhost:8000`.

Use the terminal panel commands:
- `task list` - show available backend tasks
- `task run <task-id>` - run a task on the controller (`task run uptime`)
- `task run <task-id> <pi-id>` - request a registered Pi to run the task
- `task assign "<machine label>" "<task label>"` - record a responsibility/role without executing a command (quotes optional for single-word names)
- `assign name "<machine label>" "<new label>"` - rename a machine directly from the terminal console

Renamed machines persist across restarts in `state/labels.json`.
Task assignments are durable as well and reload from `state/tasks.json`.

## Raspberry Pi Agent
Each node runs `pi_agent.py`, which handles registration, periodic CPU/RAM reporting, and optional task execution.

```bash
# on the Raspberry Pi
pip install -r requirements.txt  # or pip install python-socketio[client] psutil
python pi_agent.py --controller-url http://controller-host:8000 --pi-id pi-1 --label "Rack Pi 1"
```

Options:
- `--interval` (seconds) adjusts telemetry cadence (default 5s).
- `--register-only` tells the agent to report stats but refuse remote task execution.
- `--log-level DEBUG` prints verbose diagnostics while developing.

When the controller forwards a task, the agent receives an `execute_task` event, launches the provided command, streams stdout as `task_output`, and finishes with `task_finished`/`task_error`.

## Development Notes
- The frontend uses Socket.IO v4; keep the CDN link in `templates/index.html` in sync with the Python package version.
- Metrics animation expects numeric values (percentage) in `data-target` attributes.
- When adding new tasks, extend `REGISTERED_TASKS` in `main.py` with a label, description, and command list.