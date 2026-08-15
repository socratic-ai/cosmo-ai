"""The fast-voice + slow-brain pattern, as one background client tool.

The realtime agent is the fast brain: it answers instantly and keeps the
conversation moving. `consult_deep_thinker` is the slow one — a background
tool whose handler sends a genuinely hard question to a more capable
reasoning model. The handler acks immediately, so the agent says "let me
work on that" and keeps talking; when the considered answer lands, the
server injects it and the agent announces it unprompted.

No microphone or speaker required — this example uses the text channel only.
It's an interactive REPL: type anything, or fire one of the suggested
questions by number to see the pattern in action.

Usage:
    pip install cosmo-ai-sdk cosmo-cli anthropic prompt_toolkit
    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/python/deep_thinker.py   # after `cosmo login`, or with COSMO_API_KEY set

Dim, italic lines are SDK mechanics (acks, tool calls, session events) —
still worth watching, just visually out of the way of the conversation. The
ack releases the tool reply in milliseconds, so you can keep chatting — try
sending a second message right after the first. The deep thinker's answer
gets its own highlighted box when it lands, and the agent brings it up on
its own, unprompted.
"""

import asyncio
import contextlib
import os
import re
import shutil
import textwrap
import time

import anthropic
from prompt_toolkit.application import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.key_binding.key_processor import KeyPressEvent
from prompt_toolkit.layout import HSplit, Layout, VSplit, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.patch_stdout import patch_stdout
from pydantic import BaseModel, Field

from cosmo_ai import (
    AudioConfig,
    ErrorEvent,
    ReadyEvent,
    RealtimeClient,
    SessionEndedEvent,
    ToolCallEvent,
    ToolResultEvent,
    TranscriptDeltaEvent,
    tool,
)
from cosmo_ai.tools import ClientToolJob

DEEP_THINKER_MODEL = os.environ.get("DEEP_THINKER_MODEL", "claude-opus-5")

# Golden prompts: questions meaty enough that the agent reaches for
# consult_deep_thinker rather than answering off the cuff. Shown as
# type-a-number shortcuts so a first-time user sees the pattern immediately.
SUGGESTED_QUESTIONS = [
    "Should our payments ledger use event sourcing or plain CRUD with audit "
    "tables? We're a team of four and compliance matters.",
    "We're a multi-tenant SaaS choosing between Postgres row-level security "
    "and an application-layer authorization service — which holds up better "
    "as the tenant count grows past a thousand?",
    "Our API is versioned by URL path today. Should we move to header-based "
    "versioning before we ship a public SDK, or is that premature?",
]


# Raw ANSI SGR codes, applied directly to printed text.
_RESET = "\x1b[0m"
_DIM = "\x1b[2m"
_ITALIC = "\x1b[3m"
_BOLD = "\x1b[1m"
_CYAN = "\x1b[36m"
_GREEN = "\x1b[32m"
_YELLOW = "\x1b[33m"
_RED = "\x1b[31m"

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _sanitize(text: str) -> str:
    """Strips every C0 control character, including ESC/CR/LF, from text
    this file didn't itself compose — user input, model-generated
    replies, and anything server-reported (event messages, tool
    summaries, exception text). patch_stdout(raw=True) (see main()) lets
    ANSI through unfiltered so this file's own color codes render, which
    means unsanitized third-party text could otherwise inject terminal
    escape sequences or, via a stray \\r, corrupt the current line."""
    return _CONTROL_CHARS.sub("", text)


def diagnostic(text: str, *, error: bool = False) -> None:
    """SDK/protocol mechanics — tool calls, acks, session events. Dimmed
    and italicized so it reads as background detail rather than
    conversation, without hiding it: still fully visible, just visually
    receded. Errors keep a red tint so a failure doesn't disappear."""
    color = _RED if error else ""
    print(f"{_DIM}{_ITALIC}{color}{_sanitize(text)}{_RESET}")


def chat(label: str, text: str, color: str = "") -> None:
    """A line someone actually said. Only the speaker's label is colored —
    the message itself stays in the terminal's default color, which reads
    better than a wall of tinted text."""
    print(f"{_DIM}{stamp()}{_RESET} {_BOLD}{color}{label}:{_RESET} {_sanitize(text)}")


def _box_width() -> int:
    # The floor keeps the box legible on a narrow terminal without ever
    # asking for more width than the terminal actually has to give.
    columns = shutil.get_terminal_size(fallback=(80, 24)).columns
    return max(20, min(columns - 4, 96))


def _draw_box(rows: list[str], *, width: int, color: str = "") -> None:
    """Border-only: draws a box around pre-wrapped display rows (each
    already <= width). Callers own their own wrapping, since the
    suggestions list and the deep-thinker answer wrap differently
    (a numbered list with hanging indents vs. plain paragraphs)."""
    c, r = (color, _RESET) if color else ("", "")
    lines = [
        "",
        f"{c}╭{'─' * (width + 2)}╮{r}",
        *(f"{c}│ {row_text.ljust(width)} │{r}" for row_text in rows),
        f"{c}╰{'─' * (width + 2)}╯{r}",
        "",
    ]
    # One write for the whole box, not one print() per row: under
    # patch_stdout, a burst of separate print() calls can be split across
    # more than one background flush, and each flush independently erases
    # and redraws the live framed input around whatever it's writing —
    # split mid-box, that stamps the input box's own hrules and status
    # line into the middle of this one.
    print("\n".join(lines), end="")


def print_suggestions() -> None:
    width = _box_width()
    rows = list(
        textwrap.wrap(
            "Type a message, or send one of these to see the pattern in action:",
            width=width,
        )
    )
    rows.append("")
    for i, question in enumerate(SUGGESTED_QUESTIONS, start=1):
        prefix = f"{i}. "
        wrapped = textwrap.wrap(question, width=width - len(prefix)) or [""]
        rows.append(prefix + wrapped[0])
        rows.extend(" " * len(prefix) + continuation for continuation in wrapped[1:])
    rows.append("")
    rows.append("/quit to end.")
    _draw_box(rows, width=width)


def print_deep_thinker_answer(answer: str) -> None:
    width = _box_width()
    rows = ["Deep thinker's answer:", ""]
    rows.extend(textwrap.wrap(_sanitize(answer), width=width) or ["(empty answer)"])
    _draw_box(rows, width=width, color=_YELLOW)


_started = time.monotonic()


def stamp() -> str:
    return f"{time.monotonic() - _started:+6.2f}s"


# The live framed-input Application, so a state change can force it to
# redraw immediately rather than waiting on the spinner's own tick.
_active_app: "Application[None] | None" = None


def _invalidate_prompt() -> None:
    if _active_app is not None:
        _active_app.invalidate()


def _set_active_app(app: "Application[None] | None") -> None:
    global _active_app
    _active_app = app


class _CountedState:
    """Tracks how many concurrent operations of one kind are in flight,
    plus when the oldest of them started. consult_deep_thinker (and a
    send_text turn) can be invoked more than once before the first call
    resolves, so a single "since" timestamp isn't enough: one job
    finishing would clear the flag while a sibling job is still
    genuinely running. Counting instead means the status line keeps
    showing "still working" for as long as ANY of them is."""

    def __init__(self) -> None:
        self._count = 0
        self.since: float | None = None

    def begin(self) -> None:
        self._count += 1
        if self.since is None:
            self.since = time.monotonic()
        _invalidate_prompt()

    def end(self) -> None:
        self._count = max(0, self._count - 1)
        if self._count == 0:
            self.since = None
        _invalidate_prompt()


# Whether consult_deep_thinker is mid-flight, and since when — read by
# status_line() so it's unambiguous whether the deep thinker is working or
# it's your turn, independent of whatever's scrolling by above the prompt.
_working = _CountedState()
# Whether the realtime agent is generating a normal (non-deep-thinker)
# response — begun the moment you send a message, ended on that
# utterance's final transcript delta. Without this, the status line only
# ever reflected the background tool, so an ordinary reply in progress
# still showed "your turn" the whole time it was being generated.
_responding = _CountedState()
# Whether the deep thinker's answer has been delivered but the agent hasn't
# announced it yet — begun right after job.complete(), ended on the next
# assistant transcript delta. Delivery and the spoken announcement are two
# separate events (the announcement can lag behind delivery), so without
# this the status line dropped straight back to "your turn" the instant
# the answer was handed off, even though nothing has actually been said.
_awaiting_announcement = _CountedState()


_SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def _spinner_frame(elapsed: float) -> str:
    return _SPINNER_FRAMES[int(elapsed * 10) % len(_SPINNER_FRAMES)]


def status_line() -> str:
    # Rendered directly beneath the framed input box (see framed_prompt())
    # rather than pinned to the terminal's bottom row, so it stays right
    # where you're looking instead of leaving a gap below the conversation.
    # Animation lives here, inside prompt_toolkit's own managed render
    # surface, rather than a separate task writing to stdout directly —
    # that's what keeps it safe against live typing.
    if _working.since is not None:
        elapsed = time.monotonic() - _working.since
        return f" {_spinner_frame(elapsed)} deep thinker working ({elapsed:.0f}s) "
    if _responding.since is not None:
        elapsed = time.monotonic() - _responding.since
        return f" {_spinner_frame(elapsed)} assistant responding "
    if _awaiting_announcement.since is not None:
        elapsed = time.monotonic() - _awaiting_announcement.since
        return f" {_spinner_frame(elapsed)} answer delivered — waiting for the agent to bring it up ({elapsed:.0f}s) "
    return " ● your turn — type a message, or /quit "


def _hrule() -> Window:
    return Window(height=1, char="─")


async def framed_prompt() -> str | None:
    """Like input(), but rendered as a horizontal-rule-framed box with the
    live status_line() directly beneath it, instead of a single "> " line.
    Returns None on EOF/Ctrl-C/Ctrl-D rather than raising.

    A custom Application rather than PromptSession's bottom_toolbar: the
    toolbar pins to the terminal's actual bottom row, not just below the
    input, which leaves a large gap on a tall terminal. This runs inside
    the caller's patch_stdout() context, which coordinates any active
    prompt_toolkit render with concurrent print() calls — not just
    PromptSession's.

    erase_when_done=True wipes the box (both rules and the status line) the
    moment it exits, so only the currently-live turn is ever framed — the
    caller prints its own plain history line for what was just entered,
    and completed turns read as normal scrollback instead of a trail of
    boxes.
    """
    buf = Buffer()
    result: str | None = None

    kb = KeyBindings()

    @kb.add("enter")
    def _submit(event: KeyPressEvent) -> None:
        nonlocal result
        result = buf.text
        event.app.exit()

    @kb.add("c-c")
    @kb.add("c-d")
    def _cancel(event: KeyPressEvent) -> None:
        event.app.exit()  # result stays None

    input_row = VSplit(
        [
            Window(content=FormattedTextControl("> "), width=2, dont_extend_width=True),
            Window(content=BufferControl(buffer=buf), height=1),
        ]
    )
    status_row = Window(content=FormattedTextControl(status_line), height=1)

    # The result is carried out through the `result` closure variable
    # above, not through Application's own exit(result=...) channel — the
    # generic parameter is None because nothing ever calls exit(result=).
    app: Application[None] = Application(
        layout=Layout(
            HSplit([_hrule(), input_row, _hrule(), status_row]),
            focused_element=input_row,
        ),
        key_bindings=kb,
        full_screen=False,
        erase_when_done=True,
    )

    async def ticker() -> None:
        # Keeps the spinner animating (and the elapsed-seconds count
        # ticking up) even when nothing else triggers a redraw.
        while True:
            await asyncio.sleep(0.15)
            app.invalidate()

    _set_active_app(app)
    tick_task = asyncio.create_task(ticker())
    try:
        await app.run_async()
    finally:
        tick_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await tick_task
        _set_active_app(None)

    return result


class HardQuestion(BaseModel):
    question: str = Field(
        description="The hard question, restated with any context from the "
        "conversation the deep thinker needs to answer it well"
    )


_deep_thinker = anthropic.AsyncAnthropic()

_DEEP_THINKER_PROMPT = (
    "You are the deep-reasoning half of a voice assistant. The fast half is "
    "holding a live conversation and has delegated this question to you:\n\n"
    "{question}\n\n"
    "Give a rigorous, decisive answer. It will be spoken aloud, so keep it "
    "under 250 words: lead with the recommendation, then the two or three "
    "considerations that actually decide it."
)


@tool(background=True)
async def consult_deep_thinker(input: HardQuestion, job: ClientToolJob) -> None:
    """Delegate a genuinely hard question — architecture trade-offs, deep
    analysis, anything worth real deliberation — to a slower, more capable
    reasoning model. Returns immediately; the considered answer arrives later.
    """
    # Ack first: the reply goes back to the agent now, and everything after
    # this line runs while the conversation continues.
    await job.ack(note="Let me work through that properly while we keep talking.")
    diagnostic(
        f"{stamp()} [deep_thinker] acked — big-model call starts, chat continues"
    )
    question_excerpt = input.question[:60]

    _working.begin()
    try:
        response = await _deep_thinker.messages.create(
            model=DEEP_THINKER_MODEL,
            max_tokens=16000,
            messages=[
                {
                    "role": "user",
                    "content": _DEEP_THINKER_PROMPT.format(question=input.question),
                }
            ],
        )
    except Exception as exc:
        # Broad on purpose: a ClientToolJob must eventually resolve via
        # ack/complete/fail. Catching only anthropic.APIError would leave
        # the job — and the agent waiting on it — hanging forever on any
        # other failure (a network error, a malformed response, ...).
        diagnostic(
            f"{stamp()} [deep_thinker] ✗ failed for {question_excerpt!r} — {exc}",
            error=True,
        )
        await job.fail(error=f"The deep thinker was unavailable: {exc}")
        return
    finally:
        _working.end()

    if response.stop_reason == "refusal":
        diagnostic(
            f"{stamp()} [deep_thinker] ✗ declined by safety classifiers "
            f"for {question_excerpt!r}",
            error=True,
        )
        await job.fail(error="The deep thinker declined to answer that question.")
        return

    answer = "".join(block.text for block in response.content if block.type == "text")
    if not answer:
        diagnostic(
            f"{stamp()} [deep_thinker] ✗ empty answer "
            f"(stop_reason={response.stop_reason}) for {question_excerpt!r}",
            error=True,
        )
        await job.fail(error="The deep thinker returned an empty answer.")
        return

    # Print the answer as soon as it exists — don't make it wait on the
    # agent's own turn-taking. job.complete() delivers the result to the
    # backend; when the agent actually speaks it depends on the realtime
    # provider, which can lag well behind delivery.
    print_deep_thinker_answer(answer)
    # `summary` is the model-facing text the agent speaks (capped at 2048
    # chars); `result` is structured data for logs and hooks.
    await job.complete(result={"model": DEEP_THINKER_MODEL}, summary=answer)
    diagnostic(
        f"{stamp()} [deep_thinker] ✓ delivered to the agent — announcement may lag"
    )
    _awaiting_announcement.begin()


async def main() -> None:
    async with RealtimeClient() as client:
        agent = client.agent(
            instructions=(
                "You are a quick, engaging assistant. When the user asks a "
                "genuinely hard question, call consult_deep_thinker, tell them "
                "you'll work on it in the background, and keep the conversation "
                "going. Announce the considered answer as soon as its result "
                "reaches you."
            ),
            tools=[consult_deep_thinker],
            # Text channel only, as advertised — without this the server
            # still synthesizes speech nobody hears (and still bills for
            # it) even though nothing in this example ever plays it back.
            audio=AudioConfig(output=False),
        )
        async with agent.start() as session:
            # patch_stdout coordinates any active prompt_toolkit render
            # (framed_prompt()'s Application, below) with concurrent print()
            # calls — everything from here down (the event loop, the
            # background tool's own prints) needs to be inside it, since a
            # plain input() has no way to survive concurrent output landing
            # mid-prompt. raw=True is required: by default patch_stdout
            # replaces every ESC byte in printed text with "?" to stop
            # stray control sequences from corrupting the render, which
            # would mangle the ANSI color codes below into visible garbage.
            with patch_stdout(raw=True):
                diagnostic(
                    f"{stamp()} ● session live — session_id={session.session_id}"
                )

                async def drive() -> None:
                    print_suggestions()
                    while True:
                        raw = await framed_prompt()
                        if raw is None:
                            break  # EOF / Ctrl-C / Ctrl-D
                        text = raw.strip()
                        if not text:
                            continue
                        if text in ("/quit", "/exit"):
                            break
                        if text.isdigit() and 1 <= int(text) <= len(
                            SUGGESTED_QUESTIONS
                        ):
                            text = SUGGESTED_QUESTIONS[int(text) - 1]
                        # framed_prompt()'s box erases itself on exit, so this
                        # is what's left behind in scrollback for the turn.
                        chat("you", text, color=_CYAN)
                        _responding.begin()
                        await session.send_text(text)
                    await session.end()

                driver = asyncio.create_task(drive())

                async for event in session:
                    if isinstance(event, ReadyEvent):
                        diagnostic(f"{stamp()} [ready] session_id={event.session_id}")
                    elif isinstance(event, TranscriptDeltaEvent):
                        if event.is_final:
                            # The final delta carries the whole cumulative
                            # utterance text — the earlier word-by-word
                            # deltas aren't needed for a clean transcript
                            # line.
                            if event.role.value == "assistant":
                                chat("assistant", event.text, color=_GREEN)
                                _responding.end()
                                _awaiting_announcement.end()
                            else:
                                chat(event.role.value, event.text)
                    elif isinstance(event, ToolCallEvent):
                        # Covers the case where the model fires the tool
                        # with no preceding speech — otherwise nothing
                        # would ever end _responding here, since only a
                        # final assistant transcript delta does.
                        _responding.end()
                        diagnostic(f"{stamp()} ● tool call: {event.name}")
                    elif isinstance(event, ToolResultEvent):
                        # For a background tool this frame carries the ACK,
                        # not the answer — the answer arrives as agent
                        # speech later.
                        ok = "ok" if event.ok else "err"
                        diagnostic(
                            f"{stamp()} ● tool acknowledged [{ok}] — {event.summary}"
                        )
                    elif isinstance(event, ErrorEvent):
                        _responding.end()
                        diagnostic(
                            f"{stamp()} ● error {event.code.value}: {event.message}",
                            error=True,
                        )
                    elif isinstance(event, SessionEndedEvent):
                        diagnostic(f"{stamp()} ● session ended: {event.reason}")

                await driver
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
