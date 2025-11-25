# Pi Stat

Simple dashboard for watching Raspberry Pi stats and running commands from a web page. The controller lives in `main.py` and serves the UI at port 8000.

## Controller Quick Start (Windows or Linux)
1. Install Python 3.10+ if you do not already have it.
2. Create and activate a virtual environment (optional but recommended).
   ```bash
   python -m venv .venv
   source .venv/bin/activate        # Linux / macOS
   .\.venv\Scripts\activate        # Windows PowerShell
   ```
3. Install the controller dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Launch the controller:
   ```bash
   python main.py
   ```
5. Open the dashboard at `http://localhost:8000` (swap `localhost` for your host IP if you are on a different machine).

## Connect a Raspberry Pi
1. Update the Pi and ensure Python 3 is installed:
   ```bash
   sudo apt update && sudo apt install -y python3 python3-pip
   ```
2. Install the Pi agent dependencies (reuse `requirements.txt` if you prefer):
   ```bash
   pip3 install python-socketio[client] psutil
   ```
3. Start the agent:
   ```bash
   python3 pi_agent.py --controller-url http://<controller-ip>:8000 --pi-id pi-1 --label "Living Room"
   ```
   - `<controller-ip>`: address where `main.py` is running.
   - `--pi-id`: choose any unique name for that Pi.
   - `--label` is optional; it controls the display name in the dashboard.

The Pi now sends CPU/RAM updates and is ready to run commands you trigger from the web terminal.

## Deploying the Agent on Windows
1. Install Python 3.10+ from [python.org](https://www.python.org/downloads/). During setup, tick "Add Python to PATH".
2. Open PowerShell in the repository folder and create a virtual environment (optional):
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate
   ```
3. Install dependencies:
   ```powershell
   pip install python-socketio[client] psutil
   ```
4. Run the agent, pointing it at your controller:
   ```powershell
   python pi_agent.py --controller-url http://<controller-ip>:8000 --pi-id win-node --label "Windows"
   ```
   Leave this PowerShell window open so the agent can stream stats and terminal output.

## Web Terminal Commands
- `task list` — show the safe, pre-built maintenance tasks.
- `task run <task-id>` — run a task on the controller, example: `task run uptime`.
- `task run <task-id> <pi-id>` — send the task to a specific Pi, example: `task run cleanup pi-1`.
- `task assign "<machine label>" "<task label>"` — log who owns which task without running anything.
- `assign name "<machine label>" "<new label>"` — rename a machine in the UI.

## Run Third-Party Programs With Live Output
1. Open the UI terminal and send an `open_program` command:
   ```
   {"action":"open_program","command":["sudo","pihole","-f"]}
   ```
   - Use a JSON object.
   - `command` is a list of arguments exactly how you would type them in a shell.
   - The agent starts the program with stdout captured and streams every line back into the terminal window.
2. Watch the terminal panel. Anything the program prints appears there. GUI-only apps will stay silent; for daemons, tail their logs instead:
   ```
   {"action":"open_program","command":["tail","-f","/var/log/pihole.log"]}
   ```
3. Close the program when you are done:
   ```
   {"action":"close_program","request_id":"<value from open_program reply>"}
   ```
   - The request id is returned right after you open the program.
   - Closing sends a terminate signal; you will see a final `terminal_finished` message with the exit code.

## Helpful Tips
- One controller can handle many Pis; run `pi_agent.py` on each with a unique `--pi-id`.
- If a program exits on its own, the terminal stops streaming automatically.
- Stuck output? Send `close_program` again with the same `request_id` to force-stop it.
- Renamed machines and task notes persist inside the `state/` folder.