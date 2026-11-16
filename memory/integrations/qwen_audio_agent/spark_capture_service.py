#!/usr/bin/env python3
"""灵感火花捕获 (Spark Capture & Spicy Critique).

A "hardcore geek investor" reading of a just-finished conversation. It only
rewards a genuinely new idea that the wearer (speaker_0) *actively* voiced;
small talk, errands and other people's brainstorming are ignored.

The service is intentionally side-car only: it never touches the memory
database, never modifies watermarks, and every public entry point swallows its
own exceptions. Long network calls run inside a daemon thread so the audio
agent and the memory sidecar are never blocked.

The language model is **always** the PWM ``LLMClient``. Callers may inject one
(the memory sidecar passes the owner's ``pwm.llm_client``); otherwise a default
client is built from PWM's own config loader so the model, base_url, api_key,
json_mode and thinking parameters are identical everywhere.

CLI demo::

    memory/.venv/bin/python -m memory.integrations.qwen_audio_agent.spark_capture_service --test
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

# ``LLMClient`` and the PWM config loader live in ``memory/src``. The service
# is loaded either as ``python -m memory.integrations...`` (repo root on
# sys.path) or by path from the memory sidecar / DevLab simulator (which
# already add this dir). Make the import work in all cases without changing
# any caller.
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
DEFAULT_OUTPUT_PATH = Path(
    "~/.config/qwaudio/data/memory/spark_captures.jsonl"
).expanduser()

_ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)

_OWNER_SPEAKER_LABELS = {
    "speaker_0", "user", "human", "self", "me", "i", "wearer", "owner",
    "用户", "用户本人", "佩戴者", "本人", "我", "speaker_用户本人",
}

# The wearer is always labelled speaker_0; everyone else folds into
# speaker_1 (external voices in the field).
_OWNER_LABEL = "speaker_0（佩戴者·你·唯一可能的灵感来源）"
_EXTERNAL_LABEL = "speaker_1（外部发言人·只能是背景，不得充当灵感来源）"

_LLM_STAGE = "spark_capture"

_TRUE_TOKENS = {"true", "1", "yes", "y", "on", "是", "有", "真"}
_FALSE_TOKENS = {"false", "0", "no", "n", "off", "否", "无", "假", "none", "null", ""}


SYSTEM_PROMPT = """你是一位「见过 1000 个平庸项目的硬核极客投资人」，同时是智商极高、嘴极毒的刻薄挚友。
你戴过无数 AI 眼镜，听过太多自嗨式的「我要做个 XX」——你能一眼看穿一个想法里真正的金子，
也能毫不留情地把它吹上天的地方戳出洞来。你的风格是：辛辣、毒舌、极客式一针见血，
幽默但不客气，挑剔但不空洞。拒绝温吞客套，拒绝「这个想法很好，但是……」式的废话。

你刚刚读完一段佩戴者（speaker_0）刚结束的语音对白或自言自语，以及从「个人世界模型」蒸馏出的
高阶认知记忆：佩戴者正在推进的**真实项目主线清单 (active_threads)** 与**当下焦点 (situational_states)**。
这些记忆是从长期记忆中提炼出的真实业务，不是随口闲聊。你的任务是判断：
**佩戴者本人是否主动说出了一个真正的新想法、新点子、产品设计构思或假设。**

【铁律 · 违反即失败】
1. 灵感必须且只能来自 speaker_0 主动说出的话。如果 speaker_0 只是在应答寒暄、
   附和别人、讨论既有琐事、复述别人的点子、自我安慰或情绪宣泄，一律判定 has_spark=false。
2. speaker_1 或其他外部声音说出的点子永远不算数，哪怕它听起来更精彩；它们最多只能作为理解
   speaker_0 那句话的背景。
3. 宁可错杀三千，不可放过一个自嗨。没有货真价实的新意，就果断 has_spark=false，
   不要为了凑卡片而硬编。
4. 如果 has_spark=false，只输出 {"has_spark": false}，其余字段可省略，绝不发挥。
5. 如果 has_spark=true，下面的十个字段一个都不能少，全部使用中文。

【卡片字段要求】
- has_spark: 布尔值 true（本场确有 speaker_0 主动说出的灵感）。
- title: 简短有力的灵感代号，8~18 字，像产品代号，例如 "赛博外脑：将潜意识外包给眼镜"。
- user_spark_quote: 逐字摘录 speaker_0 主动说出的那句灵感原话，不得杜撰、不得润色。
- the_pitch: 一句话说清灵感实质，锋利到能当 elevator pitch。
- pros: 真正诱人之处与创新点，指出它为什么不是又一个平庸 App。
- cons: 致命盲点与自嗨陷阱，用毒舌把技术、成本、伦理或人性上的硬伤钉死，拒绝温吞客套。
- extension: 顺着这个逻辑推演到极致的脑洞，越荒诞越要写得像真能做出来的路线图。
- relevance: 【必须锚定真实主线】直接批判该灵感与佩戴者手头正在推进的项目主线
  （如《空间屏应用与Device SDK交付》《面向未来 AI 眼镜的实验性项目》）以及当下处境焦点
  （如交付节点将至、外部依赖卡住）的真实关系——它究竟能直接补齐哪块关键拼图，还是
  在交付迫在眉睫时又一次典型的自我感动、逃避式脑洞、用新点子掩盖旧债？必须点名至少一条
  真实主线标题，不许泛泛而谈「与正在做的事有关」。
- spicy_verdict: 【必须结合具体项目处境】一句字字诛心却醍醐灌顶的毒舌终审评语，
  把灵感与佩戴者真实交付压力的碰撞钉死，像投资人当面把 BP 摔在桌上。
- reality_check: 一个最小、可在 48 小时内完成的试金石挑战，用来验真或当众打脸。

请严格输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释性前后缀。
只有 speaker_0 主动迸发的新想法才值得你出手；否则保持沉默。"""


class SparkCaptureService:
    """Detect, critique, persist and notify a wearer-authored spark."""

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
        exported. The standalone CLI / DevLab simulator mirrors that
        environment (without overwriting anything already set) so the default
        ``LLMClient`` is built from exactly the same inputs as the sidecar's.
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
                        "Spark capture: failed to build default PWM LLMClient: %s", exc,
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
                "以下是佩戴者真实推进的项目主线与当下焦点（个人世界模型记忆），"
                "你的 relevance 与 spicy_verdict 必须锚定这些真实业务：\n\n",
                memory_block,
                "\n\n---\n\n",
            ])
        sections.extend([
            "【最近对白与现场原声】（speaker_0 是佩戴者本人，也是唯一可能的灵感来源；"
            "speaker_1 是外部发言人，只能作为背景）",
            "请严格按上面的系统指令判断并只输出一个 JSON 对象：\n\n",
            transcript,
        ])
        prompt = "".join(sections)
        raw = llm_client.call_llm(prompt, stage_name=_LLM_STAGE)
        if not raw:
            self._logger.warning("Spark capture LLM stage=%s returned no content", _LLM_STAGE)
            return None
        parsed = llm_client.parse_json_object_from_llm_text(raw, stage_name=_LLM_STAGE)
        if parsed is None:
            parsed = self._extract_json(raw)
        if parsed is None:
            self._logger.warning("Spark capture LLM stage=%s returned no JSON object", _LLM_STAGE)
        return parsed

    @staticmethod
    def _coerce_bool(value: Any) -> bool:
        """Fail closed: only an explicit true-ish value counts as a spark."""
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value != 0
        token = str(value or "").strip().lower()
        if token in _TRUE_TOKENS:
            return True
        if token in _FALSE_TOKENS:
            return False
        return False

    @staticmethod
    def _clean_fields(data: Dict[str, Any]) -> Dict[str, Any]:
        record: Dict[str, Any] = {"has_spark": SparkCaptureService._coerce_bool(data.get("has_spark"))}
        for key in (
            "title", "user_spark_quote", "the_pitch", "pros", "cons",
            "extension", "relevance", "spicy_verdict", "reality_check",
        ):
            value = data.get(key)
            record[key] = str(value).strip() if value is not None else ""
        if record["has_spark"]:
            if not record["title"]:
                record["title"] = "无名火花：一个还没想清楚的念头"
            if not record["user_spark_quote"]:
                record["user_spark_quote"] = "（原话未被可靠摘录）"
            if not record["spicy_verdict"]:
                record["spicy_verdict"] = "连一句狠话都配不上，这火花大概只是灯光反射。"
        return record

    @staticmethod
    def _linked_thread_titles(
        memory_context: Optional[Dict[str, Any]],
    ) -> List[str]:
        """List the real project threads this spark should be judged against."""
        context = memory_context or {}
        return [
            str(thread.get("title") or "").strip()
            for thread in (context.get("active_threads") or [])
            if isinstance(thread, dict) and thread.get("title")
        ][:5]

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
            self._logger.info("Spark capture persisted to %s", self._output_path)
        except Exception as exc:
            self._logger.warning("Spark capture persist failed: %s", exc)

    @staticmethod
    def _osascript_escape(value: Any) -> str:
        return (
            str(value or "")
            .replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\r", " ")
            .replace("\n", " ")
        )

    def notify(self, spark: Dict[str, Any]) -> bool:
        """Best-effort macOS notification; never raises."""
        if sys.platform != "darwin":
            self._logger.debug("Spark capture notification skipped on %s", sys.platform)
            return False
        title = self._osascript_escape("💡 灵感火花 · 毒舌诊断")
        subtitle = self._osascript_escape(spark.get("title") or "灵感火花")
        message = self._osascript_escape(spark.get("spicy_verdict") or "")
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
            self._logger.warning("Spark capture notification failed: %s", exc)
            return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def generate_spark(
        self,
        *,
        messages: Optional[List[Dict[str, Any]]] = None,
        segments: Optional[List[Dict[str, Any]]] = None,
        source: str = "unspecified",
        llm_client: Optional[LLMClient] = None,
        memory_context: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Synchronously generate one spark card. Catches every exception.

        When ``memory_context`` is not injected, crystallized world-model memory
        is discovered and read automatically (defensively). Returns the cleaned
        record (including ``has_spark: false``) to the caller, but only persists
        and notifies when a real spark was found.
        """
        try:
            turns = self.normalize_conversation(messages=messages, segments=segments)
            if not turns:
                self._logger.debug("Spark capture skipped: no dialogue turns")
                return None
            # Rigid condition: no active wearer speech means no possible spark.
            if not any(turn["speaker"] == "speaker_0" for turn in turns):
                self._logger.debug("Spark capture skipped: wearer never spoke")
                return {"has_spark": False}
            client = self._resolve_llm_client(llm_client)
            if client is None:
                return None
            if memory_context is None:
                try:
                    memory_context = get_crystallized_memory_context()
                except Exception as exc:  # pragma: no cover - defensive boundary
                    self._logger.debug("Spark crystallized memory unavailable: %s", exc)
                    memory_context = {}
            memory_block = format_memory_context_for_prompt(memory_context)
            parsed = self._call_llm(
                self._format_transcript(turns), client, memory_block=memory_block,
            )
            if not parsed:
                return None
            record: Dict[str, Any] = self._clean_fields(parsed)
            record["linked_thread_titles"] = self._linked_thread_titles(memory_context)
            record.update({
                "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "source": source,
                "turn_count": len(turns),
                "provider": "pwm_llm_client",
                "model": getattr(client, "_model", None),
            })
            if not record["has_spark"]:
                self._logger.info("Spark capture: no genuine spark (source=%s)", source)
                return record
            self._persist(record)
            self.notify(record)
            self._logger.info(
                "Spark captured source=%s title=%s stage=%s",
                source, record["title"], _LLM_STAGE,
            )
            return record
        except Exception as exc:  # pragma: no cover - defensive boundary
            self._logger.exception("Spark capture generation failed: %s", exc)
            return None

    def generate_spark_async(
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
                self.generate_spark(
                    messages=messages, segments=segments, source=source,
                    llm_client=llm_client, memory_context=memory_context,
                )
            except Exception:  # pragma: no cover - belt and braces
                self._logger.exception("Spark capture async worker failed")

        try:
            thread = threading.Thread(
                target=runner,
                name="spark-capture",
                daemon=True,
            )
            thread.start()
            return thread
        except Exception as exc:  # pragma: no cover - thread creation can fail
            self._logger.warning("Spark capture async start failed: %s", exc)
            return None


def _demo_segments() -> List[Dict[str, str]]:
    """Wearerspirits a wildly impractical AI-glasses feature during small talk."""
    dialogue = [
        ("speaker_1", "下班了，随便聊聊。你最近那副眼镜还顺手吗？"),
        ("speaker_0", "还行吧，就是它只会提醒我开会，太没劲了。诶我有个想法——"),
        ("speaker_0", "给眼镜加个 real-time 吐槽模式：看到谁就在我耳朵边小声毒舌他，"
                      "只给我一个人听，脸上还得保持微笑，外人完全看不出来。"),
        ("speaker_1", "哈哈这不就是缺德版 AR 滤镜吗？"),
        ("speaker_0", "对，但重点是它得学会我的刻薄语气，越熟的人吐槽越狠；"
                      "我觉得这比什么 AI 秘书有用一万倍。"),
        ("speaker_0", "甚至可以做会员订阅：升级后连对方的心率都能编成段子。"),
        ("speaker_1", "你可真敢想……"),
    ]
    return [{"speaker": speaker, "text": text} for speaker, text in dialogue]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="灵感火花捕获 · 测试入口")
    parser.add_argument("--test", action="store_true", help="用模拟灵感对白生成一张真实灵感卡片")
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
    SparkCaptureService._apply_desktop_pwm_env(DEFAULT_ENV_PATH)
    service = SparkCaptureService(
        config_path=Path(args.config),
        output_path=Path(args.output),
    )
    segments = _demo_segments()
    print("模拟对白（speaker_0=佩戴者，speaker_1=外部发言人）：")
    for turn in segments:
        label = "佩戴者" if turn["speaker"] == "speaker_0" else "外部"
        print(f"  [{label}] {turn['text']}")
    context = get_crystallized_memory_context()
    if context.get("active_threads"):
        print("\n🔗 锚定真实主线：" + " ｜ ".join(
            thread.get("title", "") for thread in context["active_threads"][:3]
        ))
    print("\n正在请求 PWM LLMClient 生成灵感卡片 …\n")

    result = service.generate_spark(
        segments=segments, source="cli-test", memory_context=context,
    )
    if not result:
        print("未捕获灵感：请检查 PWM 配置/API Key、网络或日志输出。")
        return 1
    if not result.get("has_spark"):
        print("本次对话未检测到真正的新灵感（has_spark=false），静默退出，不落盘不打扰。")
        return 0
    print("捕获成功：")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\n已保存至 {service._output_path}，并已触发 macOS 通知。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
