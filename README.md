# Pi Stat

Simple dashboard for watching Raspberry Pi stats and running commands from a web page. The controller lives in `main.py` and serves the UI at port 8000.

## Controller Quick Start
1. `pip install -r requirements.txt` — get the Python packages.
2. `python main.py` — start the Flask/Socket.IO server.
3. Open `http://localhost:8000` (or replace `localhost` with your server IP).

## Connect a Raspberry Pi
1. On the Pi run `pip install python-socketio[client] psutil` (or reuse the same `requirements.txt`).
2. Start the agent:
   ```bash
   python pi_agent.py --controller-url http://<controller-ip>:8000 --pi-id pi-1 --label "Living Room"
   ```
   - `<controller-ip>`: address where `main.py` is running.
   - `--pi-id`: choose any unique name for that Pi.
   - `--label` is optional; it controls the display name in the dashboard.

The Pi now sends CPU/RAM updates and is ready to run commands you trigger from the web terminal.

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