#!/usr/bin/env python3
"""MBTI 场域洞察 (MBTI Field Insight).

A Jungian "cognitive functions" reading of a just-finished conversation.  The
service is intentionally side-car only: it never touches the memory database,
never modifies watermarks, and every public entry point swallows its own
exceptions.  Long network calls run inside a daemon thread so the audio agent
and the memory sidecar are never blocked.

The language model is **always** the PWM ``LLMClient``.  Callers may inject one
(the memory sidecar passes the owner's ``pwm.llm_client``); otherwise a default
client is built from PWM's own config loader so the model, base_url, api_key,
json_mode and thinking parameters are identical everywhere.

CLI demo::

    memory/.venv/bin/python -m memory.integrations.qwen_audio_agent.mbti_insight_service --test
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# ``LLMClient`` and the PWM config loader live in ``memory/src``.  The service
# is loaded either as ``python -m memory.integrations...`` (repo root on
# sys.path) or by path from the memory sidecar (which already adds this dir).
# Make the import work in both cases without changing either caller.
_SERVICE_ROOT = Path(__file__).resolve().parents[2]  # .../memory
_SRC_ROOT = _SERVICE_ROOT / "src"
_SERVICE_DIR = Path(__file__).resolve().parent
for _extra_root in (_SRC_ROOT, _SERVICE_DIR):
    if str(_extra_root) not in sys.path:
        sys.path.insert(0, str(_extra_root))

from config import split_memory_config  # noqa: E402
from llm_client import LLMClient  # noqa: E402
from crystallized_memory_helper import (  # noqa: E402
    format_memory_context_for_prompt,
    get_crystallized_memory_context,
)


DEFAULT_ENV_PATH = Path("~/.config/qwaudio/config.env").expanduser()
DEFAULT_PWM_CONFIG_PATH = _SERVICE_ROOT / "config.yaml"
DEFAULT_OUTPUT_PATH = Path("~/.config/qwaudio/data/memory/mbti_insights.jsonl").expanduser()

_ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)

_OWNER_SPEAKER_LABELS = {
    "speaker_0", "user", "human", "self", "me", "i", "wearer", "owner",
    "用户", "用户本人", "佩戴者", "本人", "我", "speaker_用户本人",
}

# The wearer is always labelled speaker_0; everyone else folds into
# speaker_1 (external voices in the field).
_OWNER_LABEL = "speaker_0（佩戴者·你）"
_EXTERNAL_LABEL = "speaker_1（外部发言人）"

_LLM_STAGE = "mbti_field_insight"


SYSTEM_PROMPT = """你是一位「随身荣格心理导师」，精通 MBTI 认知功能八维
(Ni 内倾直觉 / Ne 外倾直觉 / Ti 内倾思考 / Te 外倾思考 /
 Fi 内倾情感 / Fe 外倾情感 / Si 内倾感觉 / Se 外倾感觉)、
荣格心理学原型，以及Conversation中的「心理能量场」。

你刚刚读完一段佩戴者（speaker_0）刚结束的语音对白或会议转录，以及从「个人世界模型」蒸馏出的
高阶认知记忆（佩戴者当前的高阶活动 User Activity、当下处境状态 Situational State、
正在推进的长期主线 User Threads）。这些记忆是从大量原始语音中提炼出的精华，
比琐碎对白更能说明佩戴者真实的处境。你的任务不是做事实摘要，而是像看穿潜意识一样，
读出佩戴者在**具体活动场景与处境重压**下的认知功能运作、妥协、防御机制与潜意识张力。
风格要求：
- 神神叨叨却颇有哲理，幽默却一针见血，像禅师又像毒舌老友。
- 禁止就几句零星碎语泛泛而论：必须把对白与佩戴者正在参与的活动（如多方利益协调、
  技术争议、规格文档核对）和其处境（如交付节点将至、外部依赖卡住、时间压力）绑在一起读。
- 直击八维认知功能的内在博弈与能量流向，例如：Fe 表面妥协 vs Ti 潜意识撤离、
  Te 强推效率压制 vs Ni 焦虑、Ne 逃逸 vs Si 经验固执、Fi 价值硬撑 vs Fe 关系维护。
  至少点名两个相互拉扯的具体认知功能，并解释它们如何在这场活动/处境中现身、能量从哪流向哪。
- 必须围绕佩戴者本人（speaker_0）展开，外部发言只是照见他的镜子。
- 保持心理隐喻与哲学意味，但不要给出临床诊断，不要涉及自伤或医疗建议。

请严格输出一个 JSON 对象，只包含以下五个字段，全部使用中文：
{
  "archetype": "形象标签，例如 INFJ 宿命洞察 / ENTP 混沌破局 / INTJ 冷 inference 军师，4~12 字",
  "field_energy": "一句话描述场域能量动态，例如 从外倾情感(Fe)的过度协调转入内倾思考(Ti)的冷漠撤离",
  "insight": "严格 100~200 个汉字的核心剖析（务必控制篇幅，超过 200 字视为不合格），直击佩戴者的潜意识博弈，拒绝流水账摘要",
  "jungian_quote": "一句荣格/哲学风格的名言，充满宿命感或启迪性，可自行凝练",
  "recommended_action": "一个具体的微动作建议，例如 闭目深呼吸 1 分钟，把刚才那句没说出口的话在心里说完"
}

只输出 JSON，不要 Markdown 代码块，不要任何解释性前后缀。
字数限制是硬性要求：insight 必须介于 100 到 200 个汉字之间。"""


class MBTIInsightService:
    """Generate, persist and notify a Jungian MBTI reading of recent dialogue."""

    def __init__(
        self,
        *,
        llm_client: Optional[LLMClient] = None,
        output_path: Optional[Path | str] = None,
        config_path: Optional[Path | str] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._output_path = Path(output_path).expanduser() if output_path else DEFAULT_OUTPUT_PATH
        self._logger = logger or logging.getLogger(__name__)
        # PWM config.yaml used only when no LLMClient is injected.
        self._config_path = Path(config_path).expanduser() if config_path else None
        self._llm_client = llm_client
        self._default_client: Optional[LLMClient] = None
        self._client_lock = threading.Lock()
        self._io_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Environment + configuration helpers (CLI convenience only)
    # ------------------------------------------------------------------
    @staticmethod
    def _read_env_file(path: Path) -> Dict[str, str]:
        """Read ``KEY=VALUE`` lines; used only to mirror the desktop runtime env."""
        values: Dict[str, str] = {}
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            return values
        for line in text.splitlines():
            match = _ENV_LINE_RE.match(line)
            if not match:
                continue
            key, value = match.group(1), match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            values[key] = value
        return values

    @classmethod
    def _apply_desktop_pwm_env(cls, path: Path = DEFAULT_ENV_PATH) -> None:
        """Export desktop ``config.env`` values that PWM's loader consumes.

        The desktop launches the sidecar with ``QWEN_AUDIO_PWM_*`` already
        exported.  The standalone CLI mirrors that environment (without
        overwriting anything already set) so the default ``LLMClient`` is
        built from exactly the same inputs as the sidecar's.
        """
        for key, value in cls._read_env_file(path).items():
            os.environ.setdefault(key, value)

    def _default_pwm_client(self) -> Optional[LLMClient]:
        """Build an LLMClient from PWM's own ``personal_world_model.llm_model``."""
        with self._client_lock:
            if self._default_client is None:
                try:
                    pwm_config = (
                        split_memory_config(self._config_path)
                        if self._config_path
                        else split_memory_config()
                    )
                    self._default_client = LLMClient(
                        memory_config={"llm": pwm_config.llm_model},
                        logger=self._logger,
                    )
                except Exception as exc:
                    self._logger.warning(
                        "MBTI insight: failed to build default PWM LLMClient: %s", exc,
                    )
                    return None
            return self._default_client

    def _resolve_llm_client(
        self, llm_client: Optional[LLMClient],
    ) -> Optional[LLMClient]:
        if llm_client is not None:
            return llm_client
        if self._llm_client is not None:
            return self._llm_client
        return self._default_pwm_client()

    # ------------------------------------------------------------------
    # Input normalization
    # ------------------------------------------------------------------
    @staticmethod
    def normalize_conversation(
        messages: Optional[List[Dict[str, Any]]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, str]]:
        """Return ordered ``{speaker, text}`` turns from either input shape.

        ``speaker_0`` is the wearer; all other labels become external voices.
        """
        turns: List[Dict[str, str]] = []
        for message in messages or []:
            if not isinstance(message, dict):
                continue
            text = str(message.get("content") or "").strip()
            if not text:
                continue
            if "speaker" in message:
                raw = str(message.get("speaker") or "").strip().lower()
            else:
                role = str(message.get("role") or "").strip().lower()
                raw = "speaker_0" if role in {"user", "human", "wearer", "owner"} else "speaker_1"
            speaker = "speaker_0" if raw in _OWNER_SPEAKER_LABELS else "speaker_1"
            turns.append({"speaker": speaker, "text": text[:4_000]})
        for segment in segments or []:
            if not isinstance(segment, dict):
                continue
            text = str(segment.get("text") or "").strip()
            if not text:
                continue
            raw = str(
                segment.get("speaker")
                or segment.get("speaker_id")
                or segment.get("speakerId")
                or ""
            ).strip().lower()
            speaker = "speaker_0" if raw in _OWNER_SPEAKER_LABELS else "speaker_1"
            turns.append({"speaker": speaker, "text": text[:4_000]})
        return turns

    @staticmethod
    def _format_transcript(turns: List[Dict[str, str]], max_chars: int = 12_000) -> str:
        lines: List[str] = []
        used = 0
        for turn in turns:
            label = _OWNER_LABEL if turn["speaker"] == "speaker_0" else _EXTERNAL_LABEL
            line = f"{label}: {turn['text']}"
            if used + len(line) > max_chars:
                lines.append("…（对白过长，已截断）")
                break
            lines.append(line)
            used += len(line) + 1
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # LLM (PWM LLMClient only)
    # ------------------------------------------------------------------
    @staticmethod
    def _extract_json(text: str) -> Optional[Dict[str, Any]]:
        """Tolerant fallback parser for endpoints that ignore json mode."""
        raw = str(text or "").strip()
        fenced = _FENCE_RE.search(raw)
        if fenced:
            raw = fenced.group(1).strip()
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(raw[start : end + 1])
        except (ValueError, TypeError):
            return None
        return data if isinstance(data, dict) else None

    def _call_llm(
        self,
        transcript: str,
        llm_client: LLMClient,
        memory_block: str = "",
    ) -> Optional[Dict[str, Any]]:
        sections = [SYSTEM_PROMPT, "\n\n---\n\n"]
        if memory_block:
            sections.extend([
                "以下是从个人世界模型记忆金字塔中蒸馏出的高阶认知记忆，是本次洞察的核心锚点：\n\n",
                memory_block,
                "\n\n---\n\n",
            ])
        sections.extend([
            "【最近对白与现场原声】（speaker_0 是佩戴者本人，speaker_1 是外部发言人；"
            "原声只作为高阶活动与处境的佐证，不要停留在字面碎语）",
            "请严格按上面的系统指令，只输出一个 JSON 对象：\n\n",
            transcript,
        ])
        prompt = "".join(sections)
        raw = llm_client.call_llm(prompt, stage_name=_LLM_STAGE)
        if not raw:
            self._logger.warning("MBTI insight LLM stage=%s returned no content", _LLM_STAGE)
            return None
        parsed = llm_client.parse_json_object_from_llm_text(raw, stage_name=_LLM_STAGE)
        if parsed is None:
            parsed = self._extract_json(raw)
        if parsed is None:
            self._logger.warning("MBTI insight LLM stage=%s returned no JSON object", _LLM_STAGE)
        return parsed

    @staticmethod
    def _clean_fields(data: Dict[str, Any]) -> Dict[str, str]:
        result: Dict[str, str] = {}
        for key in (
            "archetype", "field_energy", "insight", "jungian_quote", "recommended_action",
        ):
            value = data.get(key)
            result[key] = str(value).strip() if value is not None else ""
        if not result["archetype"]:
            result["archetype"] = "INFP 潜意识漫游"
        if not result["field_energy"]:
            result["field_energy"] = "能量在意识与潜意识之间无声游移"
        if not result["insight"]:
            result["insight"] = "言语的缝隙里，藏着你尚未说出口的自己。"
        if not result["jungian_quote"]:
            result["jungian_quote"] = "直到你使潜意识成为意识，它都将主导你的生活并被称为命运。——荣格"
        if not result["recommended_action"]:
            result["recommended_action"] = "闭目深呼吸 1 分钟，把刚才没说出口的话在心里说完"
        return result

    @staticmethod
    def _metadata_from_context(
        memory_context: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Derive traceable metadata fields from the crystallized context."""
        context = memory_context or {}
        latest = context.get("latest_activity") or {}
        states = context.get("situational_states") or []
        focus_bits = [
            str(state.get("state_topic") or "").strip()
            for state in states if isinstance(state, dict)
        ]
        focus_bits = [bit for bit in focus_bits if bit]
        return {
            "activity_id": latest.get("id"),
            "activity_summary": str(latest.get("activity_text") or "").strip(),
            "situational_focus": "；".join(focus_bits[:3]),
            "active_thread_titles": [
                str(thread.get("title") or "").strip()
                for thread in (context.get("active_threads") or [])
                if isinstance(thread, dict) and thread.get("title")
            ][:5],
        }

    # ------------------------------------------------------------------
    # Persistence + notification
    # ------------------------------------------------------------------
    def _persist(self, record: Dict[str, Any]) -> None:
        try:
            self._output_path.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps(record, ensure_ascii=False)
            with self._io_lock:
                with self._output_path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            self._logger.info("MBTI insight persisted to %s", self._output_path)
        except Exception as exc:
            self._logger.warning("MBTI insight persist failed: %s", exc)

    @staticmethod
    def _osascript_escape(value: Any) -> str:
        return (
            str(value or "")
            .replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\r", " ")
            .replace("\n", " ")
        )

    def notify(self, insight: Dict[str, Any]) -> bool:
        """Best-effort macOS notification; never raises."""
        if sys.platform != "darwin":
            self._logger.debug("MBTI insight notification skipped on %s", sys.platform)
            return False
        title = self._osascript_escape("🔮 场域洞察 · MBTI")
        subtitle = self._osascript_escape(insight.get("archetype") or "MBTI 场域洞察")
        message = self._osascript_escape(insight.get("jungian_quote") or "")
        script = (
            f'display notification "{message}" with title "{title}" subtitle "{subtitle}"'
        )
        try:
            subprocess.run(
                ["osascript", "-e", script],
                check=False,
                timeout=8,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except Exception as exc:
            self._logger.warning("MBTI insight notification failed: %s", exc)
            return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def generate_insight(
        self,
        *,
        messages: Optional[List[Dict[str, Any]]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
        source: str = "unspecified",
        llm_client: Optional[LLMClient] = None,
        memory_context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Synchronously generate one insight. Catches every exception.

        When ``memory_context`` is not injected, the crystallized world-model
        memory is discovered and read automatically (defensively).
        """
        try:
            turns = self.normalize_conversation(messages=messages, segments=segments)
            if not turns:
                self._logger.debug("MBTI insight skipped: no dialogue turns")
                return None
            client = self._resolve_llm_client(llm_client)
            if client is None:
                return None
            if memory_context is None:
                try:
                    memory_context = get_crystallized_memory_context()
                except Exception as exc:  # pragma: no cover - defensive boundary
                    self._logger.debug("MBTI crystallized memory unavailable: %s", exc)
                    memory_context = {}
            memory_block = format_memory_context_for_prompt(memory_context)
            parsed = self._call_llm(
                self._format_transcript(turns), client, memory_block=memory_block,
            )
            if not parsed:
                return None
            record: Dict[str, Any] = self._clean_fields(parsed)
            record.update(self._metadata_from_context(memory_context))
            record.update({
                "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "source": source,
                "turn_count": len(turns),
                "provider": "pwm_llm_client",
                "model": getattr(client, "_model", None),
            })
            self._persist(record)
            self.notify(record)
            self._logger.info(
                "MBTI insight generated source=%s archetype=%s stage=%s",
                source, record["archetype"], _LLM_STAGE,
            )
            return record
        except Exception as exc:  # pragma: no cover - defensive boundary
            self._logger.exception("MBTI insight generation failed: %s", exc)
            return None

    def generate_insight_async(
        self,
        *,
        messages: Optional[List[Dict[str, Any]]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
        source: str = "unspecified",
        llm_client: Optional[LLMClient] = None,
        memory_context: Optional[Dict[str, Any]] = None,
    ) -> Optional[threading.Thread]:
        """Fire-and-forget. Returns the daemon thread (or None on failure)."""
        def runner() -> None:
            try:
                self.generate_insight(
                    messages=messages, segments=segments, source=source,
                    llm_client=llm_client, memory_context=memory_context,
                )
            except Exception:  # pragma: no cover - belt and braces
                self._logger.exception("MBTI insight async worker failed")

        try:
            thread = threading.Thread(
                target=runner,
                name="mbti-field-insight",
                daemon=True,
            )
            thread.start()
            return thread
        except Exception as exc:  # pragma: no cover - thread creation can fail
            self._logger.warning("MBTI insight async start failed: %s", exc)
            return None


def _demo_segments() -> List[Dict[str, str]]:
    """A tense meeting where the wearer yields, then quietly withdraws."""
    dialogue = [
        ("speaker_1", "这个版本必须今天定下来，再拖就没有窗口了。我们直接按我的方案走吧。"),
        ("speaker_0", "我其实还有几个顾虑……不过既然时间紧，先按你说的推进也行。"),
        ("speaker_1", "顾虑具体是什么？你上次也是这么说的，最后也没拿出替代方案。"),
        ("speaker_0", "主要是风险没人兜底。算了，我既然提不出更好的，就别卡大家了。"),
        ("speaker_1", "这就对了嘛。你其实挺配合的，就是想太多。"),
        ("speaker_0", "嗯，我想太多了。（沉默两秒）那后续的问题我来同步吧。"),
        ("speaker_1", "等等，你刚才那句话什么意思？好像有点情绪。"),
        ("speaker_0", "没有情绪，我只是觉得……算了，不重要。继续下一个议题吧。"),
        ("speaker_1", "行吧，那就这样，辛苦你收尾。"),
        ("speaker_0", "好。（低头记笔记，手指在纸上无意识地划圈）"),
    ]
    return [{"speaker": speaker, "text": text} for speaker, text in dialogue]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="MBTI 场域洞察 · 测试入口")
    parser.add_argument("--test", action="store_true", help="用模拟会议对白生成一次真实洞察")
    parser.add_argument(
        "--config", default=str(DEFAULT_PWM_CONFIG_PATH),
        help="PWM config.yaml 路径（无注入 LLMClient 时用于构造默认客户端）",
    )
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_PATH), help="jsonl 持久化路径")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.test:
        parser.print_help()
        return 0

    # Mirror the desktop's PWM environment so the default LLMClient matches
    # the one the memory sidecar builds for each owner.
    MBTIInsightService._apply_desktop_pwm_env(DEFAULT_ENV_PATH)
    service = MBTIInsightService(
        config_path=Path(args.config),
        output_path=Path(args.output),
    )
    segments = _demo_segments()
    print("模拟对白（speaker_0=佩戴者，speaker_1=外部发言人）：")
    for turn in segments:
        label = "佩戴者" if turn["speaker"] == "speaker_0" else "外部"
        print(f"  [{label}] {turn['text']}")
    context = get_crystallized_memory_context()
    if context.get("latest_activity"):
        print(f"\n🧠 锚定高阶活动：{context['latest_activity'].get('activity_text', '')[:80]}")
    if context.get("situational_states"):
        print("⚡ 锚定处境焦点：" + "；".join(
            state.get("state_topic", "") for state in context["situational_states"]
        ))
    print("\n正在请求 PWM LLMClient 生成场域洞察 …\n")

    result = service.generate_insight(
        segments=segments, source="cli-test", memory_context=context,
    )
    if not result:
        print("未生成洞察：请检查 PWM 配置/API Key、网络或日志输出。")
        return 1
    print("生成成功：")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\n已保存至 {service._output_path}，并已触发 macOS 通知。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
