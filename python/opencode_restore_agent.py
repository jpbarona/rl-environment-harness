"""Harbor installed agent that replays a captured OpenCode attempt.

Extends Harbor's built-in OpenCode agent (same trajectory parsing and ATIF
output) with the harness replay contract:

- The pinned OpenCode build is baked into the task image at
  /usr/local/opencode/opencode (checksum-verified at install time); the npm
  opencode-ai track is a different version line and is NOT used.
- Before the attempt, the fresh OpenCode session store is seeded from the
  frozen capture records at /opt/capture via the compiled harness seeder
  (Step 3 logic verbatim: bootstrap store init, conversation prefix rows,
  per-session sequence counter, referenced tool-output artifacts).
- The agent submits the ORIGINAL captured request exactly once through
  `opencode run --session <captured-session-id>`, so the restored preceding
  context and the effective model input are preserved. A fresh instruction
  alone is insufficient by design.
"""

from __future__ import annotations

import json
import shlex
from typing import override

from harbor.agents.installed.base import NonZeroAgentExitCodeError, with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

OPENCODE_BIN = "/usr/local/opencode/opencode"
PINNED_VERSION = "2.0.18"
CAPTURE_DIR = "/opt/capture"
SELECTED_PATH = f"{CAPTURE_DIR}/selected.json"


class OpenCodeRestoreAgent(OpenCode):
    """Replay the captured attempt inside a native Harbor trial."""

    @staticmethod
    def name() -> str:
        return "opencode-restore"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # The pinned binary is baked into the image; verify it and expose it
        # on PATH. No npm install: the npm opencode-ai track (1.x) is a
        # different version line from the pinned 2.0.18 binary.
        await self.exec_as_root(
            environment,
            command=(
                f"test -x {OPENCODE_BIN} && "
                f"{OPENCODE_BIN} --version | grep -q 'opencode v{PINNED_VERSION}' && "
                f"ln -sf {OPENCODE_BIN} /usr/local/bin/opencode"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        selected_result = await environment.exec(command=f"cat {SELECTED_PATH}")
        if selected_result.return_code != 0:
            raise RuntimeError(f"cannot read {SELECTED_PATH}: {selected_result.stderr}")
        selected = json.loads(selected_result.stdout or "{}")
        session_id = selected.get("sessionId")
        prompt = selected.get("prompt")
        checkpoint_id = selected.get("checkpointId")
        if not session_id or not prompt or not checkpoint_id:
            raise RuntimeError("selected.json lacks sessionId/prompt/checkpointId")

        self._instruction = prompt
        escaped_prompt = shlex.quote(prompt)
        # One persistent OpenCode home for seeding AND the attempt: the
        # seeded session store must be the store the run continues.
        opencode_home = (self.environment_logs_dir / "opencode").as_posix()
        seed_env = {"HOME": opencode_home, "TMPDIR": f"{opencode_home}/seed-tmp"}
        await self.exec_as_agent(
            environment,
            command=(
                "node /opt/harness/dist/checkpoint/seed.js "
                f"--workspace /app --capture {CAPTURE_DIR} "
                f"--checkpoint {shlex.quote(checkpoint_id)} "
                f"--home {shlex.quote(opencode_home)} "
                f"--opencode-bin {OPENCODE_BIN}"
            ),
            env=seed_env,
        )

        env = dict(self.model_connection.env)
        env["OPENCODE_FAKE_VCS"] = "git"
        env["XDG_DATA_HOME"] = f"{opencode_home}/data"
        env["XDG_STATE_HOME"] = f"{opencode_home}/state"
        env["HOME"] = opencode_home

        config_command = self._build_register_config_command()
        if config_command:
            await self.exec_as_agent(environment, command=config_command, env=env)

        cli_flags = self.build_cli_flags()
        cli_flags_arg = (cli_flags + " ") if cli_flags else ""
        await self.exec_as_agent(
            environment,
            command=(
                "opencode run --format=json --thinking --auto "
                f"--session {shlex.quote(session_id)} "
                f"--model {shlex.quote(self.model_name)} "
                f"{cli_flags_arg}-- {escaped_prompt} "
                f"2>&1 </dev/null | stdbuf -oL tee "
                f"{shlex.quote((self.environment_logs_dir / self._OUTPUT_FILENAME).as_posix())}"
            ),
            env=env,
        )
        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError(
                "OpenCode emitted error event(s): " + "; ".join(messages[:3])
            )
