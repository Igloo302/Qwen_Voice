#!/usr/bin/env python3
"""MBTI 场域洞察 (MBTI Field Insight).

A Jungian "cognitive functions" reading of a just-finished conversation.  The
service is intentionally side-car only: it never touches the memory database,
never modifies watermarks, and every public entry point swallows its own
exceptions.  Long network calls run inside a daemon thread so the audio agent
and the memory sidecar are never blocked.

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

try:  # requests ships with the project venv; fall back to stdlib if absent.
    import requests
except ImportError:  # pragma: no cover - only used in stripped environments
    requests = None  # type: ignore[assignment]

import urllib.error
import urllib.request


DEFAULT_CONFIG_PATH = Path("~/.config/qwaudio/config.env").expanduser()
DEFAULT_OUTPUT_PATH = Path("~/.config/qwaudio/data/memory/mbti_insights.jsonl").expanduser()

DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DASHSCOPE_MODEL = "qwen-plus"
DEEPSEEK_MODEL = "deepseek-chat"

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


SYSTEM_PROMPT = """你是一位「随身荣格心理导师」，精通 MBTI 认知功能八维
(Ni 内倾直觉 / Ne 外倾直觉 / Ti 内倾思考 / Te 外倾思考 /
 Fi 内倾情感 / Fe 外倾情感 / Si 内倾感觉 / Se 外倾感觉)、
荣格心理学原型，以及Conversation中的「心理能量场」。

你刚刚读完一段佩戴者（speaker_0）刚结束的语音对白或会议转录。你的任务不是做事实摘要，
而是像看穿潜意识一样，读出佩戴者在刚才这场人际博弈中的认知功能运作、妥协、防御机制
与潜意识张力。风格要求：
- 神神叨叨却颇有哲理，幽默却一针见血，像禅师又像毒舌老友。
- 聚焦「人际博弈与心理能量场」：谁在主导、谁在退让、佩戴者用了哪种认知功能
  来防御或攻击、能量从哪个功能流向哪个功能。
- 至少点名一个具体的认知功能（如 Fe 过度协调、Ti 冷漠撤离、Ni 宿命感、Ne 逃逸、
  Fi 价值硬撑、Te 效率压制、Si 经验固执、Se 当下防御），并解释它如何现身。
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
        config_path: Optional[Path | str] = None,
        output_path: Optional[Path | str] = None,
        logger: Optional[logging.Logger] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: int = 60,
    ) -> None:
        self._config_path = Path(config_path).expanduser() if config_path else DEFAULT_CONFIG_PATH
        self._output_path = Path(output_path).expanduser() if output_path else DEFAULT_OUTPUT_PATH
        self._logger = logger or logging.getLogger(__name__)
        self._override_api_key = api_key
        self._override_base_url = base_url
        self._override_model = model
        self._timeout = timeout
        self._io_lock = threading.Lock()
        self._config_lock = threading.Lock()
        self._cached_llm: Optional[Dict[str, str]] = None

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------
    @staticmethod
    def _read_env_file(path: Path) -> Dict[str, str]:
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

    def _resolve_llm(self) -> Optional[Dict[str, str]]:
        """DashScope/qwen-plus wins; DeepSeek is the documented fallback."""
        with self._config_lock:
            if self._cached_llm is not None:
                return dict(self._cached_llm)
            if self._override_api_key:
                llm = {
                    "api_key": self._override_api_key,
                    "base_url": self._override_base_url or DASHSCOPE_BASE_URL,
                    "model": self._override_model or DASHSCOPE_MODEL,
                    "provider": "override",
                }
                self._cached_llm = llm
                return dict(llm)
            env = self._read_env_file(self._config_path)
            dashscope = (
                env.get("DASHSCOPE_API_KEY")
                or os.environ.get("DASHSCOPE_API_KEY", "")
            ).strip()
            deepseek = (
                env.get("DEEPSEEK_API_KEY")
                or os.environ.get("DEEPSEEK_API_KEY", "")
            ).strip()
            if dashscope:
                llm = {
                    "api_key": dashscope,
                    "base_url": env.get("DASHSCOPE_BASE_URL", "").strip() or DASHSCOPE_BASE_URL,
                    "model": env.get("MBTI_INSIGHT_MODEL", "").strip() or DASHSCOPE_MODEL,
                    "provider": "dashscope",
                }
            elif deepseek:
                llm = {
                    "api_key": deepseek,
                    "base_url": env.get("DEEPSEEK_BASE_URL", "").strip() or DEEPSEEK_BASE_URL,
                    "model": env.get("MBTI_INSIGHT_MODEL", "").strip() or DEEPSEEK_MODEL,
                    "provider": "deepseek",
                }
            else:
                self._logger.warning(
                    "MBTI insight skipped: no DASHSCOPE_API_KEY/DEEPSEEK_API_KEY in %s or env",
                    self._config_path,
                )
                return None
            self._cached_llm = llm
            return dict(llm)

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
    # LLM
    # ------------------------------------------------------------------
    @staticmethod
    def _extract_json(text: str) -> Optional[Dict[str, Any]]:
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

    @staticmethod
    def _post_json(url: str, headers: Dict[str, str], payload: Dict[str, Any], timeout: int):
        """Use requests when available, otherwise stdlib urllib."""
        if requests is not None:
            response = requests.post(url, headers=headers, json=payload, timeout=timeout)
            response.raise_for_status()
            return response.json()
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def _call_llm(self, transcript: str, llm: Dict[str, str]) -> Optional[Dict[str, Any]]:
        url = f"{llm['base_url'].rstrip('/')}/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm['api_key']}",
        }
        base_payload: Dict[str, Any] = {
            "model": llm["model"],
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "以下是刚结束的对白（speaker_0 是佩戴者本人，speaker_1 是外部发言人）。"
                        "请按系统提示输出 JSON：\n\n" + transcript
                    ),
                },
            ],
            "temperature": 0.85,
            "top_p": 0.9,
            "max_tokens": 1200,
            "stream": False,
        }
        # First try strict JSON mode; some endpoints reject response_format,
        # in which case a plain call plus our tolerant parser still works.
        attempts: List[Dict[str, Any]] = [
            {**base_payload, "response_format": {"type": "json_object"}},
            dict(base_payload),
        ]
        for index, payload in enumerate(attempts):
            try:
                data = self._post_json(url, headers, payload, self._timeout)
                choices = data.get("choices") or []
                content = (choices[0].get("message") or {}).get("content") if choices else None
                parsed = self._extract_json(str(content or ""))
                if parsed:
                    return parsed
                self._logger.warning("MBTI insight LLM attempt %s returned no JSON object", index + 1)
            except Exception as exc:
                self._logger.warning(
                    "MBTI insight LLM attempt %s failed: %s: %s",
                    index + 1, type(exc).__name__, str(exc)[:200],
                )
        return None

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
    ) -> Optional[Dict[str, Any]]:
        """Synchronously generate one insight. Catches every exception."""
        try:
            turns = self.normalize_conversation(messages=messages, segments=segments)
            if not turns:
                self._logger.debug("MBTI insight skipped: no dialogue turns")
                return None
            llm = self._resolve_llm()
            if not llm:
                return None
            parsed = self._call_llm(self._format_transcript(turns), llm)
            if not parsed:
                return None
            record: Dict[str, Any] = self._clean_fields(parsed)
            record.update({
                "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "source": source,
                "turn_count": len(turns),
                "provider": llm.get("provider"),
                "model": llm.get("model"),
            })
            self._persist(record)
            self.notify(record)
            self._logger.info(
                "MBTI insight generated source=%s archetype=%s", source, record["archetype"],
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
    ) -> Optional[threading.Thread]:
        """Fire-and-forget. Returns the daemon thread (or None on failure)."""
        def runner() -> None:
            try:
                self.generate_insight(messages=messages, segments=segments, source=source)
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
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="config.env 路径")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_PATH), help="jsonl 持久化路径")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.test:
        parser.print_help()
        return 0

    service = MBTIInsightService(
        config_path=Path(args.config),
        output_path=Path(args.output),
    )
    segments = _demo_segments()
    print("模拟对白（speaker_0=佩戴者，speaker_1=外部发言人）：")
    for turn in segments:
        label = "佩戴者" if turn["speaker"] == "speaker_0" else "外部"
        print(f"  [{label}] {turn['text']}")
    print("\n正在请求 LLM 生成场域洞察 …\n")

    result = service.generate_insight(segments=segments, source="cli-test")
    if not result:
        print("未生成洞察：请检查 API Key、网络或日志输出。")
        return 1
    print("生成成功：")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"\n已保存至 {service._output_path}，并已触发 macOS 通知。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
