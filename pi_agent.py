from __future__ import annotations

import argparse
import logging
import os
import platform
import signal
import subprocess
import sys
import threading
import time
from typing import Iterable, List, Optional

import psutil
import socketio


PI_NAMESPACE = "/pi"
# Default controller URL: change this to point at your controller's IP and port
# Example: "http://172.19.112.40:8000"
DEFAULT_CONTROLLER_URL = os.environ.get("PISTAT_CONTROLLER", "http://172.25.64.211:8000")


class PiAgent:
    """Socket.IO client that reports stats and executes approved tasks."""

    def __init__(
        self,
        controller_url: str,
        pi_id: str,
        label: Optional[str],
        stats_interval: float = 5.0,
        register_only: bool = False,
        log_level: str = "INFO",
    ) -> None:
        self.controller_url = controller_url.rstrip("/")
        self.pi_id = pi_id
        self.label = label or pi_id
        self.stats_interval = max(1.0, stats_interval)
        self.register_only = register_only
        self.logger = logging.getLogger("pi-agent")
        self.active_task = "Idle"
        self._active_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._stats_thread: Optional[threading.Thread] = None
        self._sio = socketio.Client(logger=self.logger, engineio_logger=False)
        self._configure_handlers()
        self._configure_logging(log_level)

    def _configure_logging(self, level: str) -> None:
        numeric = getattr(logging, level.upper(), logging.INFO)
        logging.basicConfig(
            level=numeric,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
        )

    def _configure_handlers(self) -> None:
        @_self_event(self._sio, "connect")
        def _connect() -> None:
            self.logger.info("Connected to controller; registering as %s", self.pi_id)
            self._emit_register()

        @_self_event(self._sio, "disconnect")
        def _disconnect() -> None:
            self.logger.warning("Disconnected from controller")

        @_self_event(self._sio, "execute_task")
        def _execute_task(payload: dict) -> None:
            if self.register_only:
                self.logger.info("Ignoring task request because agent is in register-only mode")
                return
            self._handle_execute_task(payload)

        @_self_event(self._sio, "execute_terminal")
        def _execute_terminal(payload: dict) -> None:
            if self.register_only:
                self.logger.info("Ignoring terminal command because agent is in register-only mode")
                return
            self._handle_terminal_command(payload)

    def _emit_register(self) -> None:
        vm_info = psutil.virtual_memory()
        payload = {
            "pi_id": self.pi_id,
            "label": self.label,
            "ram_total_gb": vm_info.total / (1024**3),
            "active_task": self.active_task,
        }
        self._sio.emit("register", payload, namespace=PI_NAMESPACE)

    def _handle_execute_task(self, payload: dict) -> None:
        request_id = (payload or {}).get("request_id")
        command = (payload or {}).get("command")
        task_id = (payload or {}).get("task_id")
        label = (payload or {}).get("label") or task_id or "task"
        if not request_id:
            self.logger.error("Task payload missing request_id: %s", payload)
            return
        if not isinstance(command, Iterable) or isinstance(command, (str, bytes)):
            self.logger.error("Task payload has invalid command: %s", payload)
            self._emit_task_error(request_id, label, "Invalid command payload")
            return
        cmd_list = [str(part) for part in command]
        worker = threading.Thread(
            target=self._run_task,
            args=(request_id, task_id or label, label, cmd_list),
            daemon=True,
        )
        worker.start()

    def _handle_terminal_command(self, payload: dict) -> None:
        request_id = (payload or {}).get("request_id")
        raw_command = (payload or {}).get("command")
        if not request_id:
            self.logger.error("Terminal command missing request_id: %s", payload)
            return
        if not raw_command or not isinstance(raw_command, (str, list, tuple)):
            self.logger.error("Terminal command payload invalid: %s", payload)
            self._emit_terminal_error(request_id, "Invalid command payload")
            return
        if isinstance(raw_command, (list, tuple)):
            command_str = " ".join(str(part) for part in raw_command)
        else:
            command_str = str(raw_command)
        self.logger.info("Executing terminal command %s: %s", request_id, command_str)
        worker = threading.Thread(
            target=self._run_terminal_command,
            args=(request_id, command_str),
            daemon=True,
        )
        worker.start()

    def _run_task(self, request_id: str, task_id: str, label: str, command: List[str]) -> None:
        self.logger.info("Running task %s: %s", request_id, " ".join(command))
        with self._active_lock:
            self.active_task = label
        self._sio.emit(
            "task_started",
            {"request_id": request_id, "task_id": task_id, "pi_id": self.pi_id},
            namespace=PI_NAMESPACE,
        )
        exit_code: Optional[int] = None
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError:
            exit_code = -1
            self.logger.exception("Executable not found for task %s", request_id)
            self._emit_task_error(request_id, task_id, "Executable not found", exit_code)
        except Exception as exc:
            exit_code = -1
            self.logger.exception("Failed to start task %s", request_id)
            self._emit_task_error(request_id, task_id, str(exc), exit_code)
        else:
            assert process.stdout is not None
            try:
                for line in process.stdout:
                    cleaned = line.rstrip("\n")
                    if cleaned:
                        self._sio.emit(
                            "task_output",
                            {
                                "request_id": request_id,
                                "task_id": task_id,
                                "pi_id": self.pi_id,
                                "line": cleaned,
                            },
                            namespace=PI_NAMESPACE,
                        )
                exit_code = process.wait()
            except Exception as exc:  # pragma: no cover - runtime safeguard
                exit_code = -1
                self.logger.exception("Task %s encountered runtime error", request_id)
                self._emit_task_error(request_id, task_id, str(exc), exit_code)
            else:
                self._sio.emit(
                    "task_finished",
                    {
                        "request_id": request_id,
                        "task_id": task_id,
                        "pi_id": self.pi_id,
                        "exit_code": exit_code,
                    },
                    namespace=PI_NAMESPACE,
                )
        finally:
            with self._active_lock:
                self.active_task = "Idle"

    def _emit_task_error(self, request_id: str, task_id: str, message: str, exit_code: int = -1) -> None:
        self._sio.emit(
            "task_error",
            {
                "request_id": request_id,
                "task_id": task_id,
                "pi_id": self.pi_id,
                "error": message,
                "exit_code": exit_code,
            },
            namespace=PI_NAMESPACE,
        )

    def _run_terminal_command(self, request_id: str, command: str) -> None:
        self._sio.emit(
            "terminal_started",
            {"request_id": request_id, "pi_id": self.pi_id, "command": command},
            namespace=PI_NAMESPACE,
        )
        exit_code: Optional[int] = None
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                shell=True,
            )
        except FileNotFoundError:
            exit_code = -1
            self.logger.exception("Terminal executable not found for %s", request_id)
            self._emit_terminal_error(request_id, "Executable not found", exit_code)
            return
        except Exception as exc:  # pragma: no cover - safety
            exit_code = -1
            self.logger.exception("Failed to start terminal command %s", request_id)
            self._emit_terminal_error(request_id, str(exc), exit_code)
            return

        assert process.stdout is not None
        try:
            for line in process.stdout:
                cleaned = line.rstrip("\n")
                if cleaned:
                    self._sio.emit(
                        "terminal_output",
                        {
                            "request_id": request_id,
                            "pi_id": self.pi_id,
                            "line": cleaned,
                        },
                        namespace=PI_NAMESPACE,
                    )
            exit_code = process.wait()
        except Exception as exc:  # pragma: no cover - runtime safeguard
            exit_code = -1
            self.logger.exception("Terminal command %s encountered runtime error", request_id)
            self._emit_terminal_error(request_id, str(exc), exit_code)
        else:
            self._sio.emit(
                "terminal_finished",
                {
                    "request_id": request_id,
                    "pi_id": self.pi_id,
                    "exit_code": exit_code,
                },
                namespace=PI_NAMESPACE,
            )

    def _emit_terminal_error(self, request_id: str, message: str, exit_code: int = -1) -> None:
        self._sio.emit(
            "terminal_error",
            {
                "request_id": request_id,
                "pi_id": self.pi_id,
                "error": message,
                "exit_code": exit_code,
            },
            namespace=PI_NAMESPACE,
        )

    def _stats_loop(self) -> None:
        self.logger.info("Starting stats loop with interval %ss", self.stats_interval)
        psutil.cpu_percent(interval=None)
        while not self._stop_event.wait(self.stats_interval):
            cpu_percent = psutil.cpu_percent(interval=None)
            vm_info = psutil.virtual_memory()
            used_gb = (vm_info.total - vm_info.available) / (1024**3)
            payload = {
                "pi_id": self.pi_id,
                "cpu_percent": cpu_percent,
                "ram_percent": vm_info.percent,
                "ram_used_gb": used_gb,
                "ram_total_gb": vm_info.total / (1024**3),
                "active_task": self.active_task,
            }
            self._sio.emit("stats_report", payload, namespace=PI_NAMESPACE)

    def start(self) -> None:
        self.logger.info(
            "Connecting to %s as %s (register-only=%s)",
            self.controller_url,
            self.pi_id,
            self.register_only,
        )
        try:
            self._sio.connect(self.controller_url, namespaces=[PI_NAMESPACE])
        except socketio.exceptions.ConnectionError:
            self.logger.error("Unable to connect to %s", self.controller_url)
            raise SystemExit(1)

        self._stats_thread = threading.Thread(target=self._stats_loop, daemon=True)
        self._stats_thread.start()

        try:
            while not self._stop_event.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            self.logger.info("Keyboard interrupt received; shutting down")
            self.stop()

    def stop(self) -> None:
        self._stop_event.set()
        if self._stats_thread and self._stats_thread.is_alive():
            self._stats_thread.join(timeout=2.0)
        if self._sio.connected:
            self._sio.disconnect()
        self.logger.info("Agent stopped")


def _self_event(sio_client: socketio.Client, event_name: str):
    """Decorator factory for class-bound Socket.IO events."""

    def decorator(func):
        sio_client.on(event_name, namespace=PI_NAMESPACE)(func)
        return func

    return decorator


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Raspberry Pi telemetry agent")
    parser.add_argument(
        "--controller-url",
        default=os.environ.get("PISTAT_CONTROLLER", DEFAULT_CONTROLLER_URL),
        help="Base URL of the controller server",
    )
    parser.add_argument("--pi-id", default=os.environ.get("PISTAT_ID") or platform.node(), help="Unique identifier for this Pi")
    parser.add_argument("--label", default=os.environ.get("PISTAT_LABEL"), help="Friendly label to show in the dashboard")
    parser.add_argument("--interval", type=float, default=float(os.environ.get("PISTAT_INTERVAL", 5.0)), help="Seconds between stats reports (default 5)")
    parser.add_argument("--register-only", action="store_true", help="Register with the controller but do not execute tasks")
    parser.add_argument("--log-level", default=os.environ.get("PISTAT_LOGLEVEL", "INFO"), help="Logging level (DEBUG, INFO, WARNING, ERROR)")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    agent = PiAgent(
        controller_url=args.controller_url,
        pi_id=args.pi_id,
        label=args.label,
        stats_interval=args.interval,
        register_only=args.register_only,
        log_level=args.log_level,
    )

    def handle_signal(signum, _frame):
        agent.logger.info("Signal %s received; stopping agent", signum)
        agent.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    agent.start()


if __name__ == "__main__":
    main(sys.argv[1:])
