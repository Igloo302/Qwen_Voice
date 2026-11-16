#!/usr/bin/env python3
"""Verification tests for the crystallized-memory upgrade.

Run with::

    memory/.venv/bin/python -m memory.integrations.qwen_audio_agent.test_crystallized_memory

The tests read the *real* owner databases when present (read-only) and always
validate the full MBTI / spark generation paths with an injected fake LLM, so
no network or API key is required.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from memory.integrations.qwen_audio_agent import crystallized_memory_helper as helper  # noqa: E402
from memory.integrations.qwen_audio_agent import mbti_insight_service as mbti  # noqa: E402
from memory.integrations.qwen_audio_agent import spark_capture_service as spark  # noqa: E402


class FakeLLM:
    """Minimal LLMClient stand-in that records the prompt and returns JSON."""

    _model = "fake-crystallized-test-model"

    def __init__(self, response: dict) -> None:
        self.response = response
        self.prompts: list[str] = []

    def call_llm(self, prompt: str, stage_name: str | None = None, **_kwargs) -> str:
        self.prompts.append(prompt)
        return json.dumps(self.response, ensure_ascii=False)

    def parse_json_object_from_llm_text(self, text: str, stage_name: str | None = None):
        return json.loads(text)


class CrystallizedHelperTests(unittest.TestCase):
    def test_reads_real_activity_threads_and_states(self):
        owner_dirs = helper.discover_owner_dirs()
        self.assertTrue(owner_dirs, "expected at least one owner database")
        owner = owner_dirs[0]
        context = helper.get_crystallized_memory_context(owner_dir=owner)

        self.assertTrue(context["recent_activities"], "no UserActivityItem found")
        self.assertEqual(
            context["latest_activity"]["id"],
            context["recent_activities"][0]["id"],
        )
        self.assertIn("activity_text", context["latest_activity"])
        self.assertIn("user_role", context["latest_activity"])

        self.assertTrue(context["active_threads"], "no active UserThread found")
        self.assertTrue(
            all(thread["status"] == "active" for thread in context["active_threads"])
        )
        titles = [thread["title"] for thread in context["active_threads"]]
        self.assertIn("空间屏应用与Device SDK交付", titles)

        self.assertTrue(context["situational_states"], "no active SituationalState found")
        self.assertTrue(
            all(
                state["status"] == "active" and state["state_type"] == "situational_state"
                for state in context["situational_states"]
            )
        )
        self.assertTrue(
            any("交付" in state["state_topic"] for state in context["situational_states"])
        )
        self.assertTrue(
            any(state["conditions"] for state in context["situational_states"]),
            "conditions JSON was not parsed",
        )

        # evidence_fact_ids must be enriched with real memory_facts summaries.
        enriched = [a for a in context["recent_activities"] if a["evidence_facts"]]
        self.assertTrue(enriched, "no activity had evidence facts resolved")

        prompt = helper.format_memory_context_for_prompt(context)
        self.assertIn("【佩戴者当前高阶活动 (User Activity)】", prompt)
        self.assertIn("【佩戴者当下处境状态 (Situational State)】", prompt)
        self.assertIn("【佩戴者正在推进的长期主线 (User Threads)】", prompt)

    def test_missing_database_degrades_gracefully(self):
        context = helper.get_crystallized_memory_context(
            memory_db_path="/nonexistent/memory.db",
            user_model_db_path="/nonexistent/user_model.db",
        )
        self.assertEqual(context, helper._EMPTY_CONTEXT)

    def test_prompt_handles_empty_context(self):
        self.assertEqual(helper.format_memory_context_for_prompt(None), "")
        self.assertEqual(helper.format_memory_context_for_prompt({}), "")


class ServiceIntegrationTests(unittest.TestCase):
    def setUp(self):
        owner_dirs = helper.discover_owner_dirs()
        self.context = (
            helper.get_crystallized_memory_context(owner_dir=owner_dirs[0])
            if owner_dirs else helper._EMPTY_CONTEXT.copy()
        )
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    @staticmethod
    def _segments():
        return [
            {"speaker": "speaker_1", "text": "这个版本必须今天定下来，我们直接按我的方案走。"},
            {"speaker": "speaker_0", "text": "我还有顾虑，但时间紧，先按你说的推进也行。"},
            {"speaker": "speaker_0", "text": "其实风险没人兜底，算了，后续我来同步吧。"},
        ]

    def test_mbti_output_fields_and_memory_anchoring(self):
        llm = FakeLLM({
            "archetype": "INFJ 宿命洞察",
            "field_energy": "Fe 表面妥协 → Ti 潜意识撤离",
            "insight": "你在交付重压之下把顾虑折成沉默，又把沉默伪装成配合。过度协调的 Fe 保住了场面，Ti 却悄悄撤回了对方案的真实判断——这正是你把风险独自吞下的方式。",
            "jungian_quote": "孤独并非来自无人陪伴，而是来自无法谈及重要之事。——荣格",
            "recommended_action": "把那句没说出口的顾虑写下来，再决定要不要收回。",
        })
        out = Path(self.tmp.name) / "mbti.jsonl"
        service = mbti.MBTIInsightService(output_path=out)
        with mock.patch.object(mbti.MBTIInsightService, "notify", return_value=True):
            record = service.generate_insight(
                segments=self._segments(),
                source="unit-test",
                llm_client=llm,
                memory_context=self.context,
            )
        self.assertIsNotNone(record)
        for key in ("archetype", "field_energy", "insight", "jungian_quote", "recommended_action"):
            self.assertIn(key, record)

        latest = self.context.get("latest_activity") or {}
        self.assertEqual(record["activity_id"], latest.get("id"))
        self.assertEqual(record["activity_summary"], latest.get("activity_text", ""))
        self.assertIn("交付", record["situational_focus"])

        prompt = llm.prompts[0]
        self.assertIn("【佩戴者当前高阶活动 (User Activity)】", prompt)
        self.assertIn("【佩戴者当下处境状态 (Situational State)】", prompt)
        self.assertIn("【最近对白与现场原声】", prompt)
        self.assertIn("空间屏应用与Device SDK交付", prompt)
        self.assertTrue(out.exists())
        self.assertEqual(len(out.read_text(encoding="utf-8").strip().splitlines()), 1)

    def test_spark_output_fields_and_thread_anchoring(self):
        llm = FakeLLM({
            "has_spark": True,
            "title": "赛博外脑：把潜意识外包给眼镜",
            "user_spark_quote": "我有个想法，让眼镜把我的梦和潜意识也记下来。",
            "the_pitch": "把梦境与潜意识持续记录并生成晨间简报。",
            "pros": "抓住可穿戴设备长期在场的独特数据优势。",
            "cons": "功耗、隐私与 hallucination 三重硬伤。",
            "extension": "会员订阅：把梦境编成段子。",
            "relevance": "这与《空间屏应用与Device SDK交付》无关，20号交付在即又是典型的逃避式脑洞。",
            "spicy_verdict": "SDK 还没交付就想外包潜意识，先把眼前这份集成文档写完。",
            "reality_check": "48 小时内做出一个梦境记录原型。",
        })
        out = Path(self.tmp.name) / "spark.jsonl"
        service = spark.SparkCaptureService(output_path=out)
        with mock.patch.object(spark.SparkCaptureService, "notify", return_value=True):
            record = service.generate_spark(
                segments=[
                    {"speaker": "speaker_0", "text": "我有个想法，让眼镜把我的梦和潜意识也记下来。"},
                ],
                source="unit-test",
                llm_client=llm,
                memory_context=self.context,
            )
        self.assertIsNotNone(record)
        self.assertTrue(record["has_spark"])
        for key in ("title", "user_spark_quote", "the_pitch", "pros", "cons",
                    "extension", "relevance", "spicy_verdict", "reality_check"):
            self.assertIn(key, record)
        self.assertEqual(
            record["linked_thread_titles"],
            [t["title"] for t in self.context.get("active_threads", [])][:5],
        )

        prompt = llm.prompts[0]
        self.assertIn("【佩戴者正在推进的长期主线 (User Threads)】", prompt)
        self.assertIn("【最近对白与现场原声】", prompt)
        self.assertIn("空间屏应用与Device SDK交付", prompt)
        self.assertTrue(out.exists())

    def test_auto_injection_when_context_not_supplied(self):
        """A missing memory_context must trigger automatic discovery."""
        sentinel = {"latest_activity": {"id": 99, "activity_text": "自动注入的活动"}}
        llm = FakeLLM({
            "archetype": "INTP 冷推理",
            "field_energy": "Ti → Ne",
            "insight": "自动注入路径下的剖析正文，用于验证记忆上下文被正确带入。",
            "jungian_quote": "名言",
            "recommended_action": "微行动",
        })
        service = mbti.MBTIInsightService(output_path=Path(self.tmp.name) / "auto.jsonl")
        with mock.patch.object(mbti.MBTIInsightService, "notify", return_value=True), \
             mock.patch.object(mbti, "get_crystallized_memory_context", return_value=sentinel) as getter:
            record = service.generate_insight(
                segments=self._segments(), source="unit-test-auto", llm_client=llm,
            )
        getter.assert_called_once_with()
        self.assertEqual(record["activity_id"], 99)
        self.assertEqual(record["activity_summary"], "自动注入的活动")


if __name__ == "__main__":
    unittest.main(verbosity=2)
