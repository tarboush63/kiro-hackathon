"""Character Voice Agent - single-file FastAPI backend.

Serves the static frontend from public/ and hosts one WebSocket per page at /ws.
The agent answers in character with Amazon Nova Lite (via LangGraph), and each
answer is spoken with Amazon Polly (mp3 + viseme speech marks for lip sync).

AWS region is always us-east-1. Credentials come from .env when present
(python-dotenv), otherwise from the server's AWS role.
"""
import asyncio
import base64
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal, Optional

import boto3
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from langchain_aws import ChatBedrockConverse
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph

# --------------------------------------------------------------------------- #
# Config / AWS                                                                 #
# --------------------------------------------------------------------------- #

ROOT = Path(__file__).parent
REGION = "us-east-1"
MODEL_ID = "us.amazon.nova-lite-v1:0"
MAX_INPUT_CHARS = 500
HISTORY_LIMIT = 20  # keep roughly the last 20 messages per conversation

# Load .env if it exists. On a server without .env the role is used instead.
load_dotenv(ROOT / ".env")


def load_character() -> dict:
    with open(ROOT / "character.json", "r", encoding="utf-8") as fh:
        return json.load(fh)


CHARACTER = load_character()

# Boto3 clients are pinned to us-east-1. boto3 reads keys from the environment
# (.env) or, when absent, from the server role.
_polly = boto3.client("polly", region_name=REGION)
_executor = ThreadPoolExecutor(max_workers=4)


# --------------------------------------------------------------------------- #
# AI answer format + LangGraph agent                                           #
# --------------------------------------------------------------------------- #

Emotion = Literal["neutral", "happy", "angry", "sad", "relaxed"]


class Reply(BaseModel):
    """Structured answer the model must return."""

    text: str = Field(description="The spoken reply, 1 to 3 short sentences, no lists, no emojis.")
    emotion: Emotion = Field(default="neutral", description="The character's emotion for this reply.")
    move: Optional[str] = Field(
        default=None,
        description="Optional animation move name, or null for none.",
    )


SYSTEM_PROMPT = (
    CHARACTER["personality"]
    + "\n\nAlways answer in character. Keep replies to 1-3 short sentences. "
    "Never use lists or emojis. Choose an emotion that fits your reply."
)

# Build the model with structured output once. If AWS/model is unavailable the
# error surfaces per-request and the UI shows a friendly message.
_llm = ChatBedrockConverse(model=MODEL_ID, region_name=REGION, temperature=0.6)
_structured_llm = _llm.with_structured_output(Reply)


# The latest Reply per thread is handed back via this side channel so the
# structured object never has to be persisted in the checkpointer state.
_last_reply: dict[str, Reply] = {}


def _agent_node(state: MessagesState, config) -> dict:
    """One answer step: last ~20 messages + system prompt -> structured Reply."""
    from langchain_core.messages import AIMessage

    history = state["messages"][-HISTORY_LIMIT:]
    messages = [SystemMessage(content=SYSTEM_PROMPT), *history]
    reply: Reply = _structured_llm.invoke(messages)
    thread_id = config["configurable"]["thread_id"]
    _last_reply[thread_id] = reply
    # Only plain messages go into the persisted conversation memory.
    return {"messages": [AIMessage(content=reply.text)]}


_builder = StateGraph(MessagesState)
_builder.add_node("agent", _agent_node)
_builder.add_edge(START, "agent")
_graph = _builder.compile(checkpointer=InMemorySaver())


def run_agent(thread_id: str, user_text: str) -> Reply:
    """Run the agent for one user turn and return the structured Reply."""
    _graph.invoke(
        {"messages": [HumanMessage(content=user_text)]},
        config={"configurable": {"thread_id": thread_id}},
    )
    reply = _last_reply.pop(thread_id, None)
    if reply is None:
        reply = Reply(text="...", emotion="neutral")
    return reply


# --------------------------------------------------------------------------- #
# Polly: mp3 audio + viseme/word speech marks (two calls in parallel)          #
# --------------------------------------------------------------------------- #


def _polly_audio(text: str) -> bytes:
    resp = _polly.synthesize_speech(
        Text=text,
        OutputFormat="mp3",
        VoiceId=CHARACTER["voice"],
        Engine=CHARACTER.get("engine", "neural"),
    )
    return resp["AudioStream"].read()


def _polly_marks(text: str) -> list:
    resp = _polly.synthesize_speech(
        Text=text,
        OutputFormat="json",
        VoiceId=CHARACTER["voice"],
        Engine=CHARACTER.get("engine", "neural"),
        SpeechMarkTypes=["viseme", "word"],
    )
    raw = resp["AudioStream"].read().decode("utf-8")
    marks = []
    for line in raw.splitlines():
        line = line.strip()
        if line:
            marks.append(json.loads(line))
    return marks


async def synthesize(text: str):
    """Return (audio_b64, visemes, words). Runs the two Polly calls in threads."""
    loop = asyncio.get_running_loop()
    audio_future = loop.run_in_executor(_executor, _polly_audio, text)
    marks_future = loop.run_in_executor(_executor, _polly_marks, text)
    audio_bytes, marks = await asyncio.gather(audio_future, marks_future)
    visemes = [{"time": m["time"], "value": m["value"]} for m in marks if m.get("type") == "viseme"]
    words = [{"time": m["time"], "value": m["value"]} for m in marks if m.get("type") == "word"]
    return base64.b64encode(audio_bytes).decode("ascii"), visemes, words


# --------------------------------------------------------------------------- #
# Bonus A: Amazon Transcribe streaming (speech -> text)                        #
# --------------------------------------------------------------------------- #

try:
    from amazon_transcribe.client import TranscribeStreamingClient
    from amazon_transcribe.handlers import TranscriptResultStreamHandler
    from amazon_transcribe.model import TranscriptEvent

    _TRANSCRIBE_AVAILABLE = True
except Exception:  # noqa: BLE001 - optional dependency (bonus A)
    _TRANSCRIBE_AVAILABLE = False

# One streaming client reused for the whole process.
_transcribe_client = (
    TranscribeStreamingClient(region=REGION) if _TRANSCRIBE_AVAILABLE else None
)


class MicSession:
    """One live Transcribe stream for a WebSocket. Feeds audio in, pushes
    partial transcripts out over the socket, and yields the final transcript."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.stream = None
        self.handler_task = None
        self.final_text = ""
        self.bytes_in = 0
        self._pending: list[bytes] = []  # chunks that arrive during stream setup

    async def start(self):
        self.stream = await _transcribe_client.start_stream_transcription(
            language_code="en-US",
            media_sample_rate_hz=16000,
            media_encoding="pcm",
        )

        parent = self

        class _Handler(TranscriptResultStreamHandler):
            async def handle_transcript_event(self, event: "TranscriptEvent"):
                for result in event.transcript.results:
                    if not result.alternatives:
                        continue
                    text = result.alternatives[0].transcript
                    if result.is_partial:
                        await parent._send_partial(text)
                    else:
                        parent.final_text = text
                        await parent._send_partial(text)

        self.handler = _Handler(self.stream.output_stream)
        self.handler_task = asyncio.create_task(self.handler.handle_events())

        # Flush any audio that arrived while the stream was still opening.
        if self._pending:
            for chunk in self._pending:
                await self.stream.input_stream.send_audio_event(audio_chunk=chunk)
            self._pending.clear()

    async def _send_partial(self, text: str):
        try:
            await self.ws.send_text(json.dumps({"type": "partial", "text": text}))
        except Exception:  # noqa: BLE001
            pass

    async def feed(self, chunk: bytes):
        self.bytes_in += len(chunk)
        if self.stream:
            await self.stream.input_stream.send_audio_event(audio_chunk=chunk)
        else:
            # Stream still opening - keep the audio instead of dropping it.
            self._pending.append(chunk)

    async def stop(self) -> str:
        """Close the input stream, wait for the final transcript, return it."""
        print(f"[mic] received {self.bytes_in} bytes "
              f"({self.bytes_in / 32000:.1f}s of audio)")
        if self.stream:
            if self._pending:
                for chunk in self._pending:
                    await self.stream.input_stream.send_audio_event(audio_chunk=chunk)
                self._pending.clear()
            await self.stream.input_stream.end_stream()
        if self.handler_task:
            try:
                await asyncio.wait_for(self.handler_task, timeout=15)
            except Exception:  # noqa: BLE001
                self.handler_task.cancel()
        print(f"[mic] final transcript: {self.final_text!r}")
        return self.final_text.strip()


# --------------------------------------------------------------------------- #
# FastAPI app                                                                  #
# --------------------------------------------------------------------------- #

app = FastAPI()


@app.get("/character")
def character_public():
    """Public character info for the frontend. Personality stays server-side."""
    return {
        "name": CHARACTER["name"],
        "avatar": CHARACTER["avatar"],
        "greeting": CHARACTER["greeting"],
        "background": CHARACTER["background"],
    }


@app.get("/capabilities")
def capabilities():
    """Tell the frontend which optional features the server supports."""
    return {"microphone": _TRANSCRIBE_AVAILABLE}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    thread_id = str(uuid.uuid4())
    mic: MicSession | None = None
    try:
        while True:
            frame = await ws.receive()

            # Binary frame = microphone audio chunk (bonus A).
            if "bytes" in frame and frame["bytes"] is not None:
                if mic:
                    await mic.feed(frame["bytes"])
                continue

            raw = frame.get("text")
            if raw is None:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            if mtype == "chat":
                text = (msg.get("text") or "").strip()[:MAX_INPUT_CHARS]
                if not text:
                    continue
                await handle_chat(ws, thread_id, text)
            elif mtype == "greeting":
                # Speak the configured greeting (no agent call).
                await speak_text(ws, CHARACTER["greeting"], emotion="relaxed")
            elif mtype == "mic_start":
                print("[mic] start")
                if _TRANSCRIBE_AVAILABLE and mic is None:
                    mic = MicSession(ws)
                    try:
                        await mic.start()
                    except Exception as exc:  # noqa: BLE001
                        print("mic start error:", repr(exc))
                        mic = None
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": "My ears aren't working right now. Try typing.",
                        }))
            elif mtype == "mic_stop":
                print("[mic] stop")
                if mic is not None:
                    final_text = ""
                    try:
                        final_text = await mic.stop()
                    except Exception as exc:  # noqa: BLE001
                        print("mic stop error:", repr(exc))
                    mic = None
                    final_text = final_text[:MAX_INPUT_CHARS]
                    if final_text:
                        await handle_chat(ws, thread_id, final_text)
                    else:
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": "I didn't catch that, habibi. Try again.",
                        }))
                else:
                    # Always answer a mic_stop so the UI never stays stuck waiting.
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "I wasn't listening yet. Try again.",
                    }))
    except WebSocketDisconnect:
        return
    except Exception:
        return


async def handle_chat(ws: WebSocket, thread_id: str, text: str):
    try:
        loop = asyncio.get_running_loop()
        reply = await loop.run_in_executor(_executor, run_agent, thread_id, text)
        await speak_reply(ws, reply)
    except Exception as exc:  # noqa: BLE001 - surface a friendly error to the UI
        print("chat error:", repr(exc))
        await ws.send_text(json.dumps({
            "type": "error",
            "message": "Sorry, my old mind wandered. Please try again.",
        }))


async def speak_reply(ws: WebSocket, reply: Reply):
    audio_b64, visemes, words = await synthesize(reply.text)
    await ws.send_text(json.dumps({
        "type": "answer",
        "text": reply.text,
        "emotion": reply.emotion,
        "move": reply.move,
        "audio": audio_b64,
        "visemes": visemes,
        "words": words,
    }))


async def speak_text(ws: WebSocket, text: str, emotion: str = "neutral"):
    audio_b64, visemes, words = await synthesize(text)
    await ws.send_text(json.dumps({
        "type": "answer",
        "text": text,
        "emotion": emotion,
        "move": None,
        "audio": audio_b64,
        "visemes": visemes,
        "words": words,
    }))


# Mount static frontend LAST so API routes above take precedence.
app.mount("/", StaticFiles(directory=str(ROOT / "public"), html=True), name="public")
