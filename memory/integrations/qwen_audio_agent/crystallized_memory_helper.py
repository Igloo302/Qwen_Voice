#!/usr/bin/env python3
"""Crystallized memory extraction for the qwen-audio-agent side-car features.

This module is a **lightweight, read-only, defensive** bridge from the Personal
World Model's distilled memory pyramid (SQLite) to the creative DevLab
features (MBTI field insight / spark capture).  It never writes to a database,
never touches watermarks, and swallows every exception so a broken or missing
database can never break the audio agent or the memory side-car.

Three layers of the pyramid are exposed:

* ``memory_user_activity_items``  -> high-order ``UserActivityItem`` rows,
  enriched with the ``memory_facts`` summaries listed in ``evidence_fact_ids``.
* ``memory_user_threads``         -> active ``UserThread`` projects.
* ``user_states``                 -> active ``SituationalState`` rows whose
  ``state_type = 'situational_state'`` (``current_focus`` etc.).

Database discovery
------------------
By default we scan ``~/.config/qwaudio/data/memory/agent-memory/owners/*/`` and
pick the most recently modified owner that has a ``memory.db`` / ``user_model.db``.
The memory side-car can skip discovery by passing explicit database paths
(``holder.pwm.database.db_path`` / ``holder.pwm.user_model_database.db_path``).

CLI demo::

    memory/.venv/bin/python -m memory.integrations.qwen_audio_agent.crystallized_memory_helper --test
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

DEFAULT_OWNERS_ROOT = Path(
    "~/.config/qwaudio/data/memory/agent-memory/owners"
).expanduser()

_EMPTY_CONTEXT: Dict[str, Any] = {
    "latest_activity": {},
    "recent_activities": [],
    "active_threads": [],
    "situational_states": [],
}


# ----------------------------------------------------------------------
# Discovery / connection helpers
# ----------------------------------------------------------------------
def _safe_int_list(raw: Any, limit: int = 32) -> List[int]:
    """Parse a JSON id list into a bounded list of positive ints."""
    if isinstance(raw, (list, tuple)):
        candidates = list(raw)
    else:
        text = str(raw or "").strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return []
        candidates = parsed if isinstance(parsed, list) else []
    result: List[int] = []
    for value in candidates[:limit]:
        try:
            number = int(value)
        except (ValueError, TypeError):
            continue
        if number > 0 and number not in result:
            result.append(number)
    return result


def _safe_json_object(raw: Any) -> Dict[str, Any]:
    """Parse a JSON object column into a dict, gracefully degrading to {}."""
    if isinstance(raw, dict):
        return raw
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def discover_owner_dirs(root: Path | str = DEFAULT_OWNERS_ROOT) -> List[Path]:
    """Return owner directories containing a memory/user-model database.

    Directories are sorted by the newest database mtime so the "active" owner
    bubbles to the top.  An empty list is returned on any filesystem problem.
    """
    try:
        base = Path(root).expanduser()
        if not base.is_dir():
            return []
        dirs: List[Path] = []
        for child in base.iterdir():
            if not child.is_dir():
                continue
            if (child / "memory.db").exists() or (child / "user_model.db").exists():
                dirs.append(child)
        def newest(path: Path) -> float:
            stamps = []
            for name in ("memory.db", "user_model.db"):
                candidate = path / name
                try:
                    stamps.append(candidate.stat().st_mtime)
                except OSError:
                    pass
            return max(stamps) if stamps else 0.0
        return sorted(dirs, key=newest, reverse=True)
    except Exception as exc:  # pragma: no cover - defensive filesystem boundary
        logger.debug("crystallized memory: owner discovery failed: %s", exc)
        return []


def _resolve_database_paths(
    owner_dir: Optional[Path | str] = None,
    memory_db_path: Optional[Path | str] = None,
    user_model_db_path: Optional[Path | str] = None,
) -> tuple[Optional[Path], Optional[Path]]:
    """Resolve the two database paths from explicit args or owner discovery."""
    memory_path = Path(memory_db_path).expanduser() if memory_db_path else None
    model_path = Path(user_model_db_path).expanduser() if user_model_db_path else None
    if memory_path and model_path:
        return memory_path, model_path

    base: Optional[Path] = None
    if owner_dir:
        base = Path(owner_dir).expanduser()
    else:
        candidates = discover_owner_dirs()
        base = candidates[0] if candidates else None
    if base is None:
        return memory_path, model_path
    if memory_path is None:
        candidate = base / "memory.db"
        memory_path = candidate if candidate.exists() else None
    if model_path is None:
        candidate = base / "user_model.db"
        model_path = candidate if candidate.exists() else None
    return memory_path, model_path


def _readonly_connection(path: Optional[Path]) -> Optional[sqlite3.Connection]:
    """Open an immutable read-only SQLite connection, or None on any problem."""
    if path is None:
        return None
    try:
        if not path.exists():
            return None
        # URI mode=ro guarantees no writes even if the file is writable.
        uri = f"file:{path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=3.0)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception as exc:  # pragma: no cover - defensive boundary
        logger.debug("crystallized memory: cannot open %s: %s", path, exc)
        return None


# ----------------------------------------------------------------------
# Row normalizers
# ----------------------------------------------------------------------
def _normalize_activity(row: sqlite3.Row, fact_summaries: List[str]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "activity_text": str(row["activity_text"] or ""),
        "user_role": str(row["user_role"] or ""),
        "confidence": float(row["confidence"] or 0.0),
        "started_at": str(row["started_at"] or ""),
        "ended_at": str(row["ended_at"] or ""),
        "evidence_fact_ids": _safe_int_list(row["evidence_fact_ids"]),
        "evidence_facts": fact_summaries,
        "created_at": str(row["created_at"] or ""),
    }


def _normalize_thread(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "title": str(row["title"] or ""),
        "current_summary": str(row["current_summary"] or ""),
        "identity_description": str(row["identity_description"] or ""),
        "status": str(row["status"] or ""),
        "updated_at": str(row["updated_at"] or ""),
    }


def _normalize_state(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "state_domain": str(row["state_domain"] or ""),
        "state_type": str(row["state_type"] or ""),
        "state_kind": str(row["state_kind"] or ""),
        "state_topic": str(row["state_topic"] or ""),
        "state_text": str(row["state_text"] or ""),
        "status": str(row["status"] or ""),
        "conditions": _safe_json_object(row["conditions"]),
        "last_observed_at": str(row["last_observed_at"] or ""),
    }


# ----------------------------------------------------------------------
# Public extraction API
# ----------------------------------------------------------------------
def get_crystallized_memory_context(
    owner_dir: Optional[Path | str] = None,
    limit_activities: int = 3,
    limit_threads: int = 5,
    limit_states: int = 3,
    *,
    memory_db_path: Optional[Path | str] = None,
    user_model_db_path: Optional[Path | str] = None,
) -> Dict[str, Any]:
    """Read the distilled world-model memory into a compact context dict.

    Returns a dict with keys ``latest_activity``, ``recent_activities``,
    ``active_threads`` and ``situational_states``.  Missing databases, missing
    tables or any query error degrade to empty values rather than raising.
    """
    context: Dict[str, Any] = {
        "latest_activity": {},
        "recent_activities": [],
        "active_threads": [],
        "situational_states": [],
    }
    try:
        limit_activities = max(0, min(int(limit_activities or 0), 20))
        limit_threads = max(0, min(int(limit_threads or 0), 20))
        limit_states = max(0, min(int(limit_states or 0), 20))
    except (ValueError, TypeError):
        return context

    memory_path, model_path = _resolve_database_paths(
        owner_dir=owner_dir,
        memory_db_path=memory_db_path,
        user_model_db_path=user_model_db_path,
    )

    # ---- memory.db: activities + threads ----------------------------
    memory_conn = _readonly_connection(memory_path)
    if memory_conn is not None:
        try:
            if limit_activities > 0:
                activity_rows = memory_conn.execute(
                    "SELECT id, activity_text, user_role, confidence, started_at, "
                    "ended_at, evidence_fact_ids, created_at "
                    "FROM memory_user_activity_items "
                    # created_at uses a consistent local offset in the real
                    # data; ended_at/started_at mix +00:00 and +08:00, which
                    # makes lexical ordering unreliable.
                    "ORDER BY created_at DESC, id DESC "
                    "LIMIT ?",
                    (limit_activities,),
                ).fetchall()
                recent_activities: List[Dict[str, Any]] = []
                for row in activity_rows:
                    summaries = _fetch_fact_summaries(
                        memory_conn, _safe_int_list(row["evidence_fact_ids"]),
                    )
                    recent_activities.append(_normalize_activity(row, summaries))
                context["recent_activities"] = recent_activities
                context["latest_activity"] = recent_activities[0] if recent_activities else {}
        except Exception as exc:
            logger.debug("crystallized memory: activity read failed: %s", exc)

        try:
            if limit_threads > 0:
                thread_rows = memory_conn.execute(
                    "SELECT id, title, identity_description, current_summary, "
                    "status, updated_at FROM memory_user_threads "
                    "WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT ?",
                    (limit_threads,),
                ).fetchall()
                context["active_threads"] = [
                    _normalize_thread(row) for row in thread_rows
                ]
        except Exception as exc:
            logger.debug("crystallized memory: thread read failed: %s", exc)
        finally:
            try:
                memory_conn.close()
            except Exception:
                pass

    # ---- user_model.db: situational states --------------------------
    model_conn = _readonly_connection(model_path)
    if model_conn is not None:
        try:
            if limit_states > 0:
                state_rows = model_conn.execute(
                    "SELECT id, state_domain, state_type, state_kind, state_topic, "
                    "state_text, status, conditions, last_observed_at FROM user_states "
                    "WHERE status = 'active' AND state_type = 'situational_state' "
                    "ORDER BY last_observed_at DESC, id DESC LIMIT ?",
                    (limit_states,),
                ).fetchall()
                context["situational_states"] = [
                    _normalize_state(row) for row in state_rows
                ]
        except Exception as exc:
            logger.debug("crystallized memory: situational state read failed: %s", exc)
        finally:
            try:
                model_conn.close()
            except Exception:
                pass

    return context


def _fetch_fact_summaries(
    conn: sqlite3.Connection, fact_ids: Sequence[int],
) -> List[str]:
    """Return ``fact_topic: summary`` strings for the given fact ids."""
    if not fact_ids:
        return []
    try:
        placeholders = ",".join("?" for _ in fact_ids)
        rows = conn.execute(
            f"SELECT id, summary, fact_topic FROM memory_facts "
            f"WHERE id IN ({placeholders})",
            tuple(fact_ids),
        ).fetchall()
    except Exception as exc:  # pragma: no cover - defensive boundary
        logger.debug("crystallized memory: fact read failed: %s", exc)
        return []
    by_id = {row["id"]: row for row in rows}
    summaries: List[str] = []
    for fact_id in fact_ids:
        row = by_id.get(fact_id)
        if not row:
            continue
        summary = str(row["summary"] or "").strip()
        topic = str(row["fact_topic"] or "").strip()
        summaries.append(f"[{topic}] {summary}" if topic else summary)
    return summaries


def format_memory_context_for_prompt(context: Optional[Dict[str, Any]]) -> str:
    """Render the crystallized context as a readable Chinese prompt section.

    Shared by the MBTI / spark services so both reason over identical, distilled
    world-model memory rather than raw ASR noise.
    """
    context = context or {}
    lines: List[str] = []
    latest = context.get("latest_activity") or {}
    recent = context.get("recent_activities") or []
    threads = context.get("active_threads") or []
    states = context.get("situational_states") or []

    if latest:
        lines.append("【佩戴者当前高阶活动 (User Activity)】")
        lines.append(f"- 活动：{latest.get('activity_text', '')}")
        role_map = {
            "actor": "主导者(actor)",
            "participant": "参与者(participant)",
            "contextual": "背景(contextual)",
        }
        lines.append(f"- 佩戴者角色：{role_map.get(latest.get('user_role', ''), latest.get('user_role', '未知'))}")
        facts = latest.get("evidence_facts") or []
        if facts:
            lines.append("- 关联事实证据：" + "；".join(str(f) for f in facts[:8]))
        if len(recent) > 1:
            lines.append("- 近期其他活动：" + " ｜ ".join(
                str(item.get("activity_text", "")) for item in recent[1:3]
            ))

    if states:
        lines.append("【佩戴者当下处境状态 (Situational State)】")
        for state in states:
            topic = state.get("state_topic", "")
            text = state.get("state_text", "")
            lines.append(f"- {topic}：{text}")
            conditions = state.get("conditions") or {}
            if isinstance(conditions, dict) and conditions:
                bits = [f"{k}={v}" for k, v in conditions.items() if v]
                if bits:
                    lines.append("    · 条件：" + "；".join(bits))

    if threads:
        lines.append("【佩戴者正在推进的长期主线 (User Threads)】")
        for thread in threads:
            lines.append(f"- 《{thread.get('title', '')}》：{thread.get('current_summary', '')}")

    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="结晶记忆提取 · CLI 验证入口")
    parser.add_argument("--test", action="store_true", help="打印当前 owner 的结晶记忆上下文")
    parser.add_argument("--owner-dir", default=None, help="指定 owner 目录")
    parser.add_argument("--memory-db", default=None, help="直接指定 memory.db 路径")
    parser.add_argument("--user-model-db", default=None, help="直接指定 user_model.db 路径")
    parser.add_argument("--json", action="store_true", help="仅输出 JSON（便于程序调用）")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    context = get_crystallized_memory_context(
        owner_dir=args.owner_dir,
        memory_db_path=args.memory_db,
        user_model_db_path=args.user_model_db,
    )
    if args.json or args.test:
        print(json.dumps(context, ensure_ascii=False, indent=2))
    else:
        parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
