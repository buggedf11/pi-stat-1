from __future__ import annotations

import json
import subprocess
import time
import uuid
from pathlib import Path
from threading import Lock, Thread
from typing import Any, Dict, List, Optional, Tuple

import psutil
from flask import Flask, render_template, request
from flask_socketio import SocketIO, disconnect


BASE = Path(__file__).resolve().parent
STATE_DIR = BASE / "state"
TEMPLATES_DIR = BASE / "templates"
STATIC_DIR = BASE / "static"

app = Flask(
    __name__,
    template_folder=str(TEMPLATES_DIR),
    static_folder=str(STATIC_DIR),
    static_url_path="/static",
)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


class LabelStore:
    """Minimal JSON-backed storage for Pi labels."""

    def __init__(self, storage_path: Path) -> None:
        self._path = storage_path
        self._lock = Lock()
        self._labels: Dict[str, str] = {}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            self._labels = {}
            return
        try:
            raw = self._path.read_text(encoding="utf-8")
            self._labels = json.loads(raw) if raw else {}
            if not isinstance(self._labels, dict):
                self._labels = {}
        except (OSError, json.JSONDecodeError):
            self._labels = {}

    def _save(self) -> None:
        tmp_path = self._path.with_suffix(".tmp")
        data = json.dumps(self._labels, indent=2, sort_keys=True)
        try:
            tmp_path.write_text(data, encoding="utf-8")
            tmp_path.replace(self._path)
        except OSError:
            # Best-effort persistence; keep in-memory state even if disk write fails.
            pass

    def get(self, pi_id: str) -> Optional[str]:
        with self._lock:
            return self._labels.get(pi_id)

    def set(self, pi_id: str, label: str) -> None:
        with self._lock:
            self._labels[pi_id] = label
            self._save()

    def remove(self, pi_id: str) -> None:
        with self._lock:
            if pi_id in self._labels:
                self._labels.pop(pi_id)
                self._save()


class TaskStore:
    """JSON-backed storage for operator-assigned task labels."""

    def __init__(self, storage_path: Path) -> None:
        self._path = storage_path
        self._lock = Lock()
        self._tasks: Dict[str, str] = {}
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            self._tasks = {}
            return
        try:
            raw = self._path.read_text(encoding="utf-8")
            data = json.loads(raw) if raw else {}
            if isinstance(data, dict):
                self._tasks = {str(k): str(v) for k, v in data.items()}
            else:
                self._tasks = {}
        except (OSError, json.JSONDecodeError):
            self._tasks = {}

    def _save(self) -> None:
        tmp_path = self._path.with_suffix(".tmp")
        data = json.dumps(self._tasks, indent=2, sort_keys=True)
        try:
            tmp_path.write_text(data, encoding="utf-8")
            tmp_path.replace(self._path)
        except OSError:
            # Persistence is best effort; avoid killing the controller on failure.
            pass

    def get(self, pi_id: str) -> Optional[str]:
        with self._lock:
            return self._tasks.get(pi_id)

    def has(self, pi_id: str) -> bool:
        with self._lock:
            return pi_id in self._tasks

    def set(self, pi_id: str, task_label: Optional[str]) -> None:
        with self._lock:
            if task_label is None:
                self._tasks.pop(pi_id, None)
            else:
                value = str(task_label).strip()
                if value:
                    self._tasks[pi_id] = value
                else:
                    self._tasks.pop(pi_id, None)
            self._save()


REGISTERED_TASKS: Dict[str, Dict[str, Any]] = {
    "uptime": {
        "label": "System Uptime",
        "description": "Show controller uptime and load averages.",
        "command": ["uptime"],
    },
    "disk-usage": {
        "label": "Disk Utilization",
        "description": "Summarize disk usage across mounted volumes.",
        "command": ["df", "-h"],
    },
    "top-processes": {
        "label": "Top Processes",
        "description": "List the most CPU hungry processes.",
        "command": [
            "bash",
            "-lc",
            "ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 6",
        ],
    },
}


class PiRegistry:
    """Thread-safe registry of Pi telemetry."""

    def __init__(
        self,
        label_store: Optional[LabelStore] = None,
        task_store: Optional[TaskStore] = None,
    ) -> None:
        self._entries: Dict[str, Dict[str, Any]] = {}
        self._lock = Lock()
        self._label_store = label_store
        self._task_store = task_store

    def upsert(self, pi_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        now = time.time()
        has_assigned = "assigned_task" in payload
        assigned_value = payload.get("assigned_task") if has_assigned else None
        with self._lock:
            entry = self._entries.get(pi_id)
            stored_label = self._label_store.get(pi_id) if self._label_store else None
            stored_task = self._task_store.get(pi_id) if self._task_store else None

            if entry is None:
                entry = {
                    "pi_id": pi_id,
                    "label": payload.get("label") or f"PI {pi_id}",
                    "ram_total_gb": payload.get("ram_total_gb"),
                    "cpu_percent": float(payload.get("cpu_percent", 0.0) or 0.0),
                    "ram_percent": float(payload.get("ram_percent", 0.0) or 0.0),
                    "ram_used_gb": float(payload.get("ram_used_gb", 0.0) or 0.0),
                    "active_task": payload.get("active_task") or "Idle",
                    "online": payload.get("online", True),
                    "last_seen": now,
                    "source": payload.get("source") or "unknown",
                }
                if has_assigned:
                    normalized = self._normalize_task_label(assigned_value)
                    if normalized is not None:
                        entry["assigned_task"] = normalized
                elif stored_task is not None:
                    entry["assigned_task"] = stored_task
                self._entries[pi_id] = entry
            else:
                entry.update(
                    {
                        "label": payload.get("label", entry["label"]),
                        "ram_total_gb": payload.get("ram_total_gb", entry.get("ram_total_gb")),
                        "cpu_percent": payload.get("cpu_percent", entry["cpu_percent"]),
                        "ram_percent": payload.get("ram_percent", entry["ram_percent"]),
                        "ram_used_gb": payload.get("ram_used_gb", entry["ram_used_gb"]),
                        "active_task": payload.get("active_task", entry.get("active_task")),
                        "online": payload.get("online", entry.get("online", True)),
                        "last_seen": now,
                        "source": payload.get("source", entry.get("source", "unknown")),
                    }
                )
                if has_assigned:
                    normalized = self._normalize_task_label(assigned_value)
                    if normalized is not None:
                        entry["assigned_task"] = normalized
                    else:
                        entry.pop("assigned_task", None)
                elif self._task_store:
                    if self._task_store.has(pi_id):
                        stored_task = self._task_store.get(pi_id)
                        if stored_task is not None:
                            entry["assigned_task"] = stored_task
                        else:
                            entry.pop("assigned_task", None)

            if stored_label:
                entry["label"] = stored_label
            if self._task_store and self._task_store.has(pi_id):
                cached = self._task_store.get(pi_id)
                if cached is not None:
                    entry["assigned_task"] = cached
                else:
                    entry.pop("assigned_task", None)

            return dict(entry)

    def set_assigned_task(self, pi_id: str, task_label: Optional[str]) -> Optional[Dict[str, Any]]:
        normalized = self._normalize_task_label(task_label)
        with self._lock:
            entry = self._entries.get(pi_id)
            if not entry:
                return None
            if normalized is not None:
                entry["assigned_task"] = normalized
            else:
                entry.pop("assigned_task", None)
            entry["last_seen"] = time.time()
            if self._task_store:
                self._task_store.set(pi_id, normalized)
            return dict(entry)

    @staticmethod
    def _normalize_task_label(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def mark_offline(self, pi_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._entries.get(pi_id)
            if not entry:
                return None
            entry["online"] = False
            entry["active_task"] = "Offline"
            entry["last_seen"] = time.time()
            return dict(entry)

    def snapshot(self) -> List[Dict[str, Any]]:
        with self._lock:
            snapshot: List[Dict[str, Any]] = []
            for key, item in self._entries.items():
                clone = dict(item)
                if self._label_store:
                    stored_label = self._label_store.get(key)
                    if stored_label:
                        clone["label"] = stored_label
                if self._task_store:
                    if self._task_store.has(key):
                        stored_task = self._task_store.get(key)
                        if stored_task is not None:
                            clone["assigned_task"] = stored_task
                        else:
                            clone.pop("assigned_task", None)
                    else:
                        clone.pop("assigned_task", None)
                snapshot.append(clone)
            return snapshot

    def get(self, pi_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            entry = self._entries.get(pi_id)
            if not entry:
                return None
            cloned = dict(entry)
            if self._label_store:
                stored_label = self._label_store.get(pi_id)
                if stored_label:
                    cloned["label"] = stored_label
            if self._task_store:
                if self._task_store.has(pi_id):
                    stored_task = self._task_store.get(pi_id)
                    if stored_task is not None:
                        cloned["assigned_task"] = stored_task
                    else:
                        cloned.pop("assigned_task", None)
                else:
                    cloned.pop("assigned_task", None)
            return cloned

    def resolve_ref(self, ref: str) -> Optional[Tuple[str, Dict[str, Any]]]:
        if not ref:
            return None
        with self._lock:
            if ref in self._entries:
                entry = self._entries[ref]
                label = self._label_store.get(ref) if self._label_store else None
                cloned = dict(entry)
                if label:
                    cloned["label"] = label
                if self._task_store:
                    if self._task_store.has(ref):
                        stored_task = self._task_store.get(ref)
                        if stored_task is not None:
                            cloned["assigned_task"] = stored_task
                        else:
                            cloned.pop("assigned_task", None)
                    else:
                        cloned.pop("assigned_task", None)
                return ref, cloned
            lowered = ref.lower()
            for key, entry in self._entries.items():
                label_value = entry.get("label") or ""
                if self._label_store:
                    stored_label = self._label_store.get(key)
                    if stored_label:
                        label_value = stored_label
                label = str(label_value).lower()
                if label and label == lowered:
                    cloned = dict(entry)
                    if label_value:
                        cloned["label"] = label_value
                    if self._task_store:
                        if self._task_store.has(key):
                            stored_task = self._task_store.get(key)
                            if stored_task is not None:
                                cloned["assigned_task"] = stored_task
                            else:
                                cloned.pop("assigned_task", None)
                        else:
                            cloned.pop("assigned_task", None)
                    return key, cloned
        return None


class TaskRunner:
    """Launch whitelisted commands and stream output over Socket.IO."""

    def __init__(self, registry: PiRegistry) -> None:
        self._registry = registry
        self._threads: Dict[str, Thread] = {}
        self._lock = Lock()

    def start_local_task(self, task_id: str, origin_sid: str) -> str:
        task = REGISTERED_TASKS.get(task_id)
        if not task:
            raise KeyError(task_id)
        request_id = str(uuid.uuid4())
        worker = Thread(
            target=self._execute,
            args=(request_id, task_id, task, origin_sid),
            daemon=True,
        )
        with self._lock:
            self._threads[request_id] = worker
        worker.start()
        return request_id

    def _execute(
        self,
        request_id: str,
        task_id: str,
        task: Dict[str, Any],
        origin_sid: str,
    ) -> None:
        label = task.get("label", task_id)
        self._registry.upsert("local", {"active_task": label, "source": "controller"})
        broadcast_snapshot()

        socketio.emit(
            "task_started",
            {"request_id": request_id, "task_id": task_id, "pi_id": "local", "label": label},
            room=origin_sid,
            namespace="/ui",
        )

        command = task.get("command", [])
        exit_code: Optional[int] = None
        error_text: Optional[str] = None
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert process.stdout is not None
            for line in process.stdout:
                socketio.emit(
                    "task_output",
                    {
                        "request_id": request_id,
                        "task_id": task_id,
                        "pi_id": "local",
                        "line": line.rstrip("\n"),
                    },
                    room=origin_sid,
                    namespace="/ui",
                )
            exit_code = process.wait()
        except FileNotFoundError:
            exit_code = -1
            error_text = "Executable not found."
        except Exception as exc:  # pragma: no cover - defensive
            exit_code = -1
            error_text = str(exc)
        finally:
            self._registry.upsert("local", {"active_task": "Idle"})
            broadcast_snapshot()
            with self._lock:
                self._threads.pop(request_id, None)

        if error_text:
            socketio.emit(
                "task_error",
                {
                    "request_id": request_id,
                    "task_id": task_id,
                    "pi_id": "local",
                    "error": error_text,
                    "exit_code": exit_code,
                },
                room=origin_sid,
                namespace="/ui",
            )

        socketio.emit(
            "task_finished",
            {
                "request_id": request_id,
                "task_id": task_id,
                "pi_id": "local",
                "exit_code": exit_code,
            },
            room=origin_sid,
            namespace="/ui",
        )


label_store = LabelStore(STATE_DIR / "labels.json")
task_store = TaskStore(STATE_DIR / "tasks.json")
registry = PiRegistry(label_store=label_store, task_store=task_store)
registry.upsert("local", {"label": "Controller", "active_task": "Idle", "source": "controller"})
task_runner = TaskRunner(registry)
pi_sessions: Dict[str, str] = {}
pi_sessions_lock = Lock()
remote_requests: Dict[str, str] = {}
remote_meta: Dict[str, Dict[str, Any]] = {}
remote_lock = Lock()


def safe_command_preview(command: List[str]) -> str:
    return " ".join(command)


def serialize_task_catalog() -> List[Dict[str, Any]]:
    catalog = []
    for task_id, info in REGISTERED_TASKS.items():
        catalog.append(
            {
                "id": task_id,
                "label": info.get("label", task_id),
                "description": info.get("description", ""),
                "command_preview": safe_command_preview(info.get("command", [])),
            }
        )
    return catalog


def broadcast_snapshot(target_sid: Optional[str] = None) -> None:
    payload = [entry for entry in registry.snapshot() if entry.get("pi_id") != "local"]
    if target_sid:
        socketio.emit("stats_snapshot", payload, room=target_sid, namespace="/ui")
    else:
        socketio.emit("stats_snapshot", payload, namespace="/ui")


def collect_local_stats() -> Dict[str, Any]:
    cpu_percent = psutil.cpu_percent(interval=None)
    memory = psutil.virtual_memory()
    used_gb = (memory.total - memory.available) / (1024**3)
    total_gb = memory.total / (1024**3)
    entry = registry.get("local") or {}
    return {
        "pi_id": "local",
        "label": entry.get("label", "Controller"),
        "cpu_percent": cpu_percent,
        "ram_percent": memory.percent,
        "ram_used_gb": used_gb,
        "ram_total_gb": total_gb,
        "active_task": entry.get("active_task", "Idle"),
        "source": "controller",
    }


def local_stats_loop() -> None:
    while True:
        stats = collect_local_stats()
        registry.upsert("local", stats)
        broadcast_snapshot()
        socketio.sleep(5)


def relay_to_ui(event_name: str, payload: Dict[str, Any]) -> None:
    request_id = payload.get("request_id")
    if not request_id:
        return
    with remote_lock:
        origin_sid = remote_requests.get(request_id)
        meta = remote_meta.get(request_id, {})
        if event_name in {"task_finished", "task_error"}:
            remote_requests.pop(request_id, None)
            remote_meta.pop(request_id, None)
    if not origin_sid:
        return

    task_id = payload.get("task_id") or meta.get("task_id")
    pi_id = payload.get("pi_id") or meta.get("pi_id") or "unknown"
    forward: Dict[str, Any] = {
        "request_id": request_id,
        "task_id": task_id,
        "pi_id": pi_id,
    }
    if event_name == "task_output":
        forward["line"] = payload.get("line", "")
    if event_name == "task_finished":
        forward["exit_code"] = payload.get("exit_code")
    if event_name == "task_error":
        forward["error"] = payload.get("error", "")
        forward["exit_code"] = payload.get("exit_code")

    socketio.emit(event_name, forward, room=origin_sid, namespace="/ui")

    if event_name in {"task_finished", "task_error"}:
        registry.upsert(pi_id, {"active_task": "Idle"})
        broadcast_snapshot()


@app.route("/")
def index() -> str:
    return render_template("index.html")


@socketio.on("connect", namespace="/ui")
def ui_connect() -> None:  # pragma: no cover - event hook
    emit_payload = {
        "level": "info",
        "message": "UI connected.",
    }
    socketio.emit("log", emit_payload, room=request.sid, namespace="/ui")
    socketio.emit("task_catalog", serialize_task_catalog(), room=request.sid, namespace="/ui")
    broadcast_snapshot(request.sid)


@socketio.on("catalog:request", namespace="/ui")
def ui_catalog_request() -> None:  # pragma: no cover - event hook
    socketio.emit("task_catalog", serialize_task_catalog(), room=request.sid, namespace="/ui")


@socketio.on("run_task", namespace="/ui")
def ui_run_task(payload: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover - event hook
    if not isinstance(payload, dict):
        return {"error": "Invalid payload."}
    task_id = payload.get("task")
    pi_id = payload.get("pi_id", "local")
    if not task_id:
        return {"error": "Task id required."}
    task = REGISTERED_TASKS.get(task_id)
    if not task:
        return {"error": f"Task '{task_id}' not recognised."}

    if pi_id == "local":
        try:
            request_id = task_runner.start_local_task(task_id, request.sid)
        except KeyError:
            return {"error": f"Task '{task_id}' not registered."}
        socketio.emit(
            "log",
            {
                "level": "info",
                "message": f"Local task '{task_id}' started.",
            },
            room=request.sid,
            namespace="/ui",
        )
        return {
            "status": "accepted",
            "request_id": request_id,
            "message": f"Task '{task_id}' running on controller.",
        }

    with pi_sessions_lock:
        target_sid = pi_sessions.get(pi_id)
    if not target_sid:
        return {"error": f"Pi '{pi_id}' is offline."}

    request_id = str(uuid.uuid4())
    with remote_lock:
        remote_requests[request_id] = request.sid
        remote_meta[request_id] = {"task_id": task_id, "pi_id": pi_id}

    socketio.emit(
        "execute_task",
        {
            "request_id": request_id,
            "task_id": task_id,
            "command": task.get("command", []),
            "label": task.get("label", task_id),
        },
        to=target_sid,
        namespace="/pi",
    )

    registry.upsert(pi_id, {"active_task": task.get("label", task_id)})
    broadcast_snapshot()
    socketio.emit(
        "log",
        {
            "level": "info",
            "message": f"Forwarded task '{task_id}' to {pi_id}.",
        },
        room=request.sid,
        namespace="/ui",
    )
    return {
        "status": "forwarded",
        "request_id": request_id,
        "message": f"Task '{task_id}' forwarded to {pi_id}.",
    }


@socketio.on("assign_task", namespace="/ui")
def ui_assign_task(payload: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover - event hook
    if not isinstance(payload, dict):
        return {"error": "Invalid payload."}
    pi_ref = str(payload.get("pi") or "").strip()
    task_label = str(payload.get("task") or "").strip()
    if not pi_ref:
        return {"error": "Machine reference is required."}
    if not task_label:
        return {"error": "Task label is required."}

    resolved = registry.resolve_ref(pi_ref)
    if not resolved:
        return {"error": f"Machine '{pi_ref}' is not registered."}
    pi_id, entry = resolved

    updated = registry.set_assigned_task(pi_id, task_label)
    if not updated:
        return {"error": f"Machine '{pi_ref}' is not registered."}
    broadcast_snapshot()

    friendly = updated.get("label") or entry.get("label") or pi_id
    socketio.emit(
        "log",
        {"level": "info", "message": f"Assigned '{task_label}' to {friendly}."},
        room=request.sid,
        namespace="/ui",
    )
    return {
        "status": "ok",
        "message": f"Assigned '{task_label}' to {friendly}.",
        "pi_id": pi_id,
        "task": updated.get("assigned_task"),
    }


@socketio.on("assign_name", namespace="/ui")
def ui_assign_name(payload: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover - event hook
    if not isinstance(payload, dict):
        return {"error": "Invalid payload."}
    pi_ref = str(payload.get("pi") or "").strip()
    new_label = str(payload.get("name") or "").strip()
    if not pi_ref:
        return {"error": "Machine reference is required."}
    if not new_label:
        return {"error": "New name is required."}

    resolved = registry.resolve_ref(pi_ref)
    if not resolved:
        return {"error": f"Machine '{pi_ref}' is not registered."}
    pi_id, entry = resolved

    label_store.set(pi_id, new_label)
    registry.upsert(pi_id, {"label": new_label})
    broadcast_snapshot()

    friendly = entry.get("label") or pi_id
    socketio.emit(
        "log",
        {
            "level": "info",
            "message": f"Renamed {friendly} to '{new_label}'.",
        },
        room=request.sid,
        namespace="/ui",
    )
    return {
        "status": "ok",
        "message": f"Renamed {friendly} to '{new_label}'.",
        "pi_id": pi_id,
        "name": new_label,
    }


@socketio.on("register", namespace="/pi")
def pi_register(payload: Dict[str, Any]) -> None:  # pragma: no cover - event hook
    if not isinstance(payload, dict):
        disconnect()
        return
    pi_id = str(payload.get("pi_id") or "").strip()
    if not pi_id:
        disconnect()
        return
    with pi_sessions_lock:
        pi_sessions[pi_id] = request.sid
    assigned = task_store.get(pi_id)
    registry.upsert(
        pi_id,
        {
            "label": payload.get("label") or f"PI {pi_id}",
            "ram_total_gb": payload.get("ram_total_gb"),
            "active_task": payload.get("active_task", "Idle"),
            "source": "pi",
            "assigned_task": assigned,
        },
    )
    broadcast_snapshot()
    socketio.emit(
        "log",
        {"level": "info", "message": f"Pi '{pi_id}' registered."},
        namespace="/ui",
    )


@socketio.on("stats_report", namespace="/pi")
def pi_stats_report(payload: Dict[str, Any]) -> None:  # pragma: no cover - event hook
    if not isinstance(payload, dict):
        return
    pi_id = payload.get("pi_id")
    if not pi_id:
        return
    registry.upsert(
        pi_id,
        {
            "cpu_percent": payload.get("cpu_percent"),
            "ram_percent": payload.get("ram_percent"),
            "ram_used_gb": payload.get("ram_used_gb"),
            "ram_total_gb": payload.get("ram_total_gb"),
            "active_task": payload.get("active_task"),
            "source": "pi",
            "assigned_task": task_store.get(pi_id),
        },
    )
    broadcast_snapshot()


@socketio.on("task_started", namespace="/pi")
def pi_task_started(payload: Dict[str, Any]) -> None:  # pragma: no cover - event hook
    relay_to_ui("task_started", payload)


@socketio.on("task_output", namespace="/pi")
def pi_task_output(payload: Dict[str, Any]) -> None:  # pragma: no cover - event hook
    relay_to_ui("task_output", payload)


@socketio.on("task_finished", namespace="/pi")
def pi_task_finished(payload: Dict[str, Any]) -> None:  # pragma: no cover - event hook
    relay_to_ui("task_finished", payload)


@socketio.on("task_error", namespace="/pi")
def pi_task_error(payload: Dict[str, Any]) -> None:  # pragma: no cover - event hook
    relay_to_ui("task_error", payload)


@socketio.on("disconnect", namespace="/pi")
def pi_disconnect() -> None:  # pragma: no cover - event hook
    lost: Optional[str] = None
    with pi_sessions_lock:
        for key, sid in list(pi_sessions.items()):
            if sid == request.sid:
                lost = key
                pi_sessions.pop(key, None)
                break
    if not lost:
        return
    registry.mark_offline(lost)
    broadcast_snapshot()
    socketio.emit(
        "log",
        {"level": "warning", "message": f"Pi '{lost}' disconnected."},
        namespace="/ui",
    )


socketio.start_background_task(local_stats_loop)


if __name__ == "__main__":  # pragma: no cover - manual launch
    socketio.run(app, host="0.0.0.0", port=8000, debug=True)